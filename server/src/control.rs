//! Reliable channel v3: fixed-width client commands and positional server events.
//! Nested event values use bounded binary tags; no JSON text travels over SCTP.
use serde_json::{Value, json};
pub const MAX_CONTROL: usize = 16 * 1024;
pub const MAX_COMMAND: usize = 70;
const SCHEMAS: &[(u8, &str, &[&str])] = &[
    (
        16,
        "welcome",
        &[
            "version",
            "contract",
            "playerId",
            "principalId",
            "tickHz",
            "safeZones",
        ],
    ),
    (17, "ownership_dirty", &[]),
    (18, "weapon", &["state"]),
    (19, "lifecycle", &["revision", "tick", "upsert", "remove"]),
    (20, "action_result", &["sequence", "result"]),
    (21, "inventory_dirty", &[]),
    (22, "vitals", &["state"]),
    (23, "weapon_shot", &["sequence", "tick", "result"]),
    (24, "detonations", &["effects"]),
    (25, "travel", &["world"]),
    (26, "grenades", &["tick", "entries"]),
    (29, "weapon_fired", &["life", "item", "ammo", "launcher"]),
    (30, "weapon_reload", &["life", "item", "alias", "milliseconds", "sound", "cancelled"]),
    (31, "gunshots", &["effects"]),
    (32, "knife_swing", &["life", "item", "stab"]),
    (33, "grenade_hud", &["life", "item", "phase"]),
];
pub fn decode_command(bytes: &[u8]) -> Result<Value, &'static str> {
    if bytes.len() < 8 || bytes[..3] != [0x58, 0x5a, crate::protocol::VERSION] {
        return Err("header");
    }
    let u32_at = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let sequence = u32_at(4);
    let id_at=|at:usize|bytes[at..at+16].iter().map(|v|format!("{v:02x}")).collect::<String>();
    match (bytes[3], bytes.len()) {
        (10,48)=>{
            let generation=u64::from_le_bytes(bytes[40..48].try_into().unwrap());
            let generation=if generation==u64::MAX{None}else if generation<=9007199254740991{Some(generation)}else{return Err("generation")};
            let after=if bytes[24..40].iter().all(|b|*b==0){String::new()}else{id_at(24)};
            if !after.is_empty() && generation.is_none(){return Err("cursor generation");}
            Ok(json!({"type":"corpse_items","sequence":sequence,"source":id_at(8),"after":after,"generation":generation}))
        }
        (8|9,24)=>{
            let after=if bytes[8..24].iter().all(|b|*b==0){String::new()}else{id_at(8)};
            Ok(json!({"type":if bytes[3]==8 {"world_items"}else{"corpses"},"sequence":sequence,"after":after}))
        }
        (6,32)=>{
            let after=if bytes[8..24].iter().all(|b|*b==0){String::new()}else{id_at(8)};
            let generation=u64::from_le_bytes(bytes[24..32].try_into().unwrap());
            let generation=if generation==u64::MAX{None}else if generation<=9007199254740991{Some(generation)}else{return Err("generation")};
            if !after.is_empty() && generation.is_none(){return Err("cursor generation");}
            Ok(json!({"type":"inventory_list","sequence":sequence,"after":after,"generation":generation}))
        }
        (7,66|70)=>{
            if (bytes[48] == 11) != (bytes.len() == 70) {return Err("inventory length");}
            let action=match bytes[48] {
                0 if bytes[49]==0=>json!({"kind":"pickup","source":id_at(50)}),
                1 if bytes[49]==0=>json!({"kind":"drop"}),
                2 if bytes[49]==0=>json!({"kind":"place","placement":{"kind":"rucksack"}}),
                3 if (1..=13).contains(&bytes[49])=>json!({"kind":"place","placement":{"kind":"slot","slot":bytes[49]}}),
                4 if bytes[49]<5=>json!({"kind":"place","placement":{"kind":"belt","cell":bytes[49]}}),
                5 if bytes[49]==0=>json!({"kind":"reload"}),
                6 if bytes[49]==0=>json!({"kind":"unload"}),
                7 if bytes[49]==0=>json!({"kind":"nextAmmo"}),
                8 if bytes[49]==0=>json!({"kind":"store","destination":id_at(50)}),
                9 if bytes[49]==0=>json!({"kind":"consume"}),
                10 if bytes[49]<=1=>json!({"kind":"fireMode","next":bytes[49]==1}),
                11 if bytes[49]==0=>json!({"kind":"attach","addon":id_at(50),"addonRevision":u32_at(66)}),
                12 if bytes[49]<3=>{
                    let slot = ["scope", "silencer", "launcher"][usize::from(bytes[49])];
                    json!({"kind":"detach","slot":slot})
                }
                13 if bytes[49]<=1=>json!({"kind":"launcherMode","active":bytes[49]==1}),
                _=>return Err("inventory action"),
            };
            if !matches!(bytes[48],0|8|11) && bytes[50..66].iter().any(|b|*b!=0){return Err("reserved source");}
            Ok(json!({"type":"inventory_move","sequence":sequence,"command":{"requestId":id_at(8),"life":u32_at(24),"item":id_at(28),"revision":u32_at(44),"action":action}}))
        }
        (1, 12) => Ok(json!({"type":"attack","sequence":sequence,"target":u32_at(8)})),
        (2, 8) => Ok(json!({"type":"reload","sequence":sequence})),
        (3, 28) => Ok(json!({"type":"respawn","sequence":sequence,"request_id":id_at(8),"life":u32_at(24)})),
        (5, 8) => Ok(json!({"type":"leave","sequence":sequence})),
        (12, 8) => Ok(json!({"type":"trigger_stop","sequence":sequence})),
        (13, 8) => Ok(json!({"type":"use_travel","sequence":sequence})),
        (14, 13) if matches!(bytes[8], 0..=4 | 6) => {
            Ok(json!({"type":"select_weapon","sequence":sequence,"slot":bytes[8],"life":u32_at(9)}))
        }
        (28, 13) if bytes[8] <= 1 => {
            Ok(json!({"type":"select_detector","sequence":sequence,"active":bytes[8]==1,"life":u32_at(9)}))
        }
        (4 | 11, 36) | (15 | 27, 37) => {
            let yaw = f32::from_le_bytes(bytes[12..16].try_into().unwrap());
            let pitch = f32::from_le_bytes(bytes[16..20].try_into().unwrap());
            if !yaw.is_finite() || !pitch.is_finite() {
                return Err("nonfinite aim");
            }
            let item = bytes[20..36].iter().any(|&b| b != 0).then(|| id_at(20));
            if bytes[3] != 4 && item.is_none() {
                return Err("weapon id");
            }
            let aim = json!({"tick":u32_at(8),"yaw":yaw,"pitch":pitch});
            if bytes[3] == 15 {
                let phase = match bytes[36] { 0 => "prime", 1 => "release", 2 => "cancel", _ => return Err("grenade phase") };
                Ok(json!({"type":"grenade","sequence":sequence,"item":item,"aim":aim,"phase":phase}))
            } else if bytes[3] == 27 {
                let mode = match bytes[36] { 0 => "slash", 1 => "stab", _ => return Err("knife mode") };
                Ok(json!({"type":"knife","sequence":sequence,"item":item,"aim":aim,"mode":mode}))
            } else {
                Ok(json!({"type":if bytes[3] == 4 {"fire"} else {"trigger_start"},"sequence":sequence,"item":item,"aim":aim}))
            }
        }
        _ => Err("command or length"),
    }
}
pub fn encode_event(value: &Value) -> Result<Vec<u8>, &'static str> {
    let object = value.as_object().ok_or("event")?;
    let name = value["type"].as_str().ok_or("type")?;
    let (opcode, _, fields) = SCHEMAS
        .iter()
        .find(|(_, n, _)| *n == name)
        .ok_or("event type")?;
    if object.len() != fields.len() + 1 {
        return Err("event fields");
    }
    let mut out = vec![0x58, 0x5a, crate::protocol::VERSION, *opcode];
    for field in *fields {
        encode_value(object.get(*field).ok_or("missing field")?, &mut out, 0)?;
    }
    if out.len() > MAX_CONTROL {
        return Err("event too large");
    }
    Ok(out)
}
fn length(value: usize, out: &mut Vec<u8>) -> Result<(), &'static str> {
    out.extend(u16::try_from(value).map_err(|_| "length")?.to_le_bytes());
    Ok(())
}
fn string(value: &str, out: &mut Vec<u8>) -> Result<(), &'static str> {
    length(value.len(), out)?;
    out.extend(value.as_bytes());
    Ok(())
}
fn encode_value(value: &Value, out: &mut Vec<u8>, depth: usize) -> Result<(), &'static str> {
    if depth > 8 || out.len() > MAX_CONTROL {
        return Err("event bounds");
    }
    match value {
        Value::Null => out.push(0),
        Value::Bool(false) => out.push(1),
        Value::Bool(true) => out.push(2),
        Value::Number(number) => {
            if let Some(n) = number.as_u64().and_then(|n| u32::try_from(n).ok()) {
                out.push(3);
                out.extend(n.to_le_bytes());
            } else {
                out.push(4);
                out.extend(number.as_f64().ok_or("number")?.to_le_bytes());
            }
        }
        Value::String(s) => {
            out.push(5);
            string(s, out)?;
        }
        Value::Array(items) => {
            if items.len() > 1024 {
                return Err("array bound");
            }
            out.push(6);
            length(items.len(), out)?;
            for item in items {
                encode_value(item, out, depth + 1)?;
            }
        }
        Value::Object(items) => {
            if items.len() > 1024 {
                return Err("map bound");
            }
            out.push(7);
            length(items.len(), out)?;
            for (key, item) in items {
                string(key, out)?;
                encode_value(item, out, depth + 1)?;
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_reject_wrong_version_trailing_bytes_and_nonfinite_aim() {
        let mut reload = vec![0x58, 0x5a, 3, 2, 42, 0, 0, 0];
        assert_eq!(
            decode_command(&reload).unwrap(),
            json!({"type":"reload","sequence":42})
        );
        reload.push(0);
        assert!(decode_command(&reload).is_err());
        reload.pop();
        reload[2] = 2;
        assert!(decode_command(&reload).is_err());
        let mut fire = vec![0x58, 0x5a, 3, 4, 1, 0, 0, 0, 2, 0, 0, 0];
        fire.extend(f32::NAN.to_le_bytes());
        fire.extend(0f32.to_le_bytes());
        fire.extend([0; 16]);
        assert!(decode_command(&fire).is_err());
        for size in 0..8 {
            assert!(decode_command(&reload[..size]).is_err());
        }
    }
    #[test]
    fn event_opcodes_and_fields_are_strict() {
        assert_eq!(
            encode_event(&json!({"type":"ownership_dirty"})).unwrap(),
            vec![0x58, 0x5a, 3, 17]
        );
        assert!(encode_event(&json!({"type":"ownership_dirty","extra":1})).is_err());
        assert!(encode_event(&json!({"type":"weapon"})).is_err());
        assert!(
            encode_event(
                &json!({"type":"action_result","sequence":1,"result":"x".repeat(MAX_CONTROL)})
            )
            .is_err()
        );
    }
}
