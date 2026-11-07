//! Generic durable ownership; no item classes, inventory slots or gameplay rules.
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transfer {
    pub request_id: String,
    pub entity_id: String,
    pub expected_revision: u32,
    pub recipient: String,
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn validate(command: &Transfer) -> Result<()> {
    ensure!(
        valid_id(&command.entity_id) && valid_id(&command.recipient),
        "invalid entity or recipient"
    );
    crate::persistence::validate_request_id(&command.request_id)
}
pub fn list(
    tx: &Transaction<'_>,
    principal: &str,
    after: &str,
    expected: Option<u64>,
) -> Result<Value> {
    ensure!(after.is_empty() || valid_id(after), "invalid cursor");
    let generation: i64 = tx.query_row(
        "SELECT generation FROM ownership_versions WHERE principal=?1",
        [principal],
        |r| r.get(0),
    )?;
    let generation = u64::try_from(generation)?;
    if expected.is_some_and(|g| g != generation) {
        return Ok(json!({"status":"conflict","generation":generation}));
    }
    let mut statement=tx.prepare("SELECT id,revision,value FROM owned_entities WHERE owner=?1 AND id>?2 ORDER BY id LIMIT 101")?;
    let rows = statement.query_map(params![principal, after], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, u32>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut entities = Vec::new();
    for row in rows {
        let (id, revision, value) = row?;
        entities.push(
            json!({"id":id,"revision":revision,"value":serde_json::from_str::<Value>(&value)?}),
        );
    }
    let more = entities.len() > 100;
    if more {
        entities.pop();
    }
    let cursor = if more {
        entities.last().map(|e| e["id"].clone())
    } else {
        None
    };
    Ok(json!({"entities":entities,"nextCursor":cursor,"generation":generation}))
}
pub fn transfer(
    tx: &Transaction<'_>,
    principal: &str,
    command: &Transfer,
    context: Option<&crate::policy::ActionContext>,
) -> Result<Value> {
    validate(command)?;
    let request = format!("entity-transfer-v1\n{}", serde_json::to_string(command)?);
    let previous: Option<(String, String)> = tx
        .query_row(
            "SELECT request,response FROM outcomes WHERE principal=?1 AND request_id=?2",
            params![principal, command.request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    // Replay must precede current authorization: a committed transfer legitimately
    // means its original sender no longer owns the entity.
    if let Some((original, response)) = previous {
        return Ok(if original == request {
            serde_json::from_str(&response)?
        } else {
            json!({"error":"request id reused with different payload"})
        });
    }
    let count: u32 = tx.query_row(
        "SELECT count(*) FROM outcomes WHERE principal=?1",
        [principal],
        |r| r.get(0),
    )?;
    if count >= 10000 {
        return Ok(json!({"error":"request ledger full"}));
    }
    let revision: Option<u32> = tx
        .query_row(
            "SELECT revision FROM owned_entities WHERE id=?1 AND owner=?2",
            params![command.entity_id, principal],
            |r| r.get(0),
        )
        .optional()?;
    let response = match revision {
        None => json!({"status":"rejected","reason":"not_owned"}),
        Some(revision) if revision != command.expected_revision => {
            json!({"status":"conflict","revision":revision})
        }
        Some(_) if command.recipient == principal => {
            json!({"status":"rejected","reason":"same_owner"})
        }
        Some(revision) => {
            let scene_world: Option<String> = tx
                .query_row(
                    "SELECT world FROM scene_entities WHERE entity=?1",
                    [&command.entity_id],
                    |r| r.get(0),
                )
                .optional()?;
            if !crate::policy::scene_action_allowed(principal, scene_world.as_deref(), context) {
                return Ok(json!({"error":"live scene authorization required"}));
            }
            let recipient: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM principals WHERE id=?1 AND revoked=0)",
                [&command.recipient],
                |r| r.get(0),
            )?;
            if !recipient {
                json!({"status":"rejected","reason":"recipient_unavailable"})
            } else if let Some(next) = revision.checked_add(1) {
                let changed=tx.execute("UPDATE owned_entities SET owner=?1,revision=?2 WHERE id=?3 AND owner=?4 AND revision=?5",params![command.recipient,next,command.entity_id,principal,revision])?;
                ensure!(
                    changed == 1,
                    "ownership changed inside serialized transaction"
                );
                json!({"status":"committed","entityId":command.entity_id,"revision":next,"owner":command.recipient})
            } else {
                json!({"status":"rejected","reason":"revision_exhausted"})
            }
        }
    };
    tx.execute(
        "INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)",
        params![
            principal,
            command.request_id,
            request,
            serde_json::to_string(&response)?
        ],
    )?;
    Ok(response)
}
