//! Admission to the private native simulation stream.
use anyhow::Result;
use rusqlite::{Transaction, params};

pub(crate) const SCHEMA: &str = "
CREATE TABLE alife_world_fences (
    world TEXT PRIMARY KEY,
    lineage BLOB NOT NULL CHECK(length(lineage)=8),
    generation INTEGER NOT NULL CHECK(generation>=0)
) WITHOUT ROWID;
PRAGMA user_version=22;";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub lineage: u64,
    pub generation: i64,
}

impl Checkpoint {
    pub(crate) fn admit(self, tx: &Transaction<'_>, world: &str) -> Result<bool> {
        Ok(tx.execute(
            "INSERT INTO alife_world_fences(world,lineage,generation) VALUES(?1,?2,?3)
             ON CONFLICT(world) DO UPDATE SET generation=excluded.generation
             WHERE alife_world_fences.lineage=excluded.lineage
               AND alife_world_fences.generation<=excluded.generation",
            params![world, self.lineage.to_le_bytes(), self.generation],
        )? == 1)
    }

    pub(crate) fn is_current(self, tx: &Transaction<'_>, world: &str) -> Result<bool> {
        Ok(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM alife_world_fences
             WHERE world=?1 AND lineage=?2 AND generation=?3)",
            params![world, self.lineage.to_le_bytes(), self.generation],
            |row| row.get(0),
        )?)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Offer {
    pub boot: u64,
    pub checkpoint: Checkpoint,
}

pub(crate) fn wide(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("eight bytes"))
}

pub(crate) fn challenge(epoch: u64, round: u64) -> [u8; 20] {
    let mut bytes = [0; 20];
    bytes[..4].copy_from_slice(b"ZWF1");
    bytes[4..12].copy_from_slice(&epoch.to_le_bytes());
    bytes[12..20].copy_from_slice(&round.to_le_bytes());
    bytes
}

impl Offer {
    pub(crate) fn decode(bytes: &[u8], epoch: u64, round: u64, level: &str) -> Option<Self> {
        if bytes.len() != 66
            || &bytes[..4] != b"ZWO1"
            || round == 0
            || wide(&bytes[4..12]) != epoch
            || wide(&bytes[12..20]) != round
            || level.len() > 22
            || !bytes[44..].starts_with(level.as_bytes())
            || bytes[44 + level.len()..].iter().any(|&byte| byte != 0)
        {
            return None;
        }
        let boot = wide(&bytes[20..28]);
        let lineage = wide(&bytes[28..36]);
        let generation = i64::try_from(wide(&bytes[36..44])).ok()?;
        (boot != 0 && lineage != 0).then_some(Self {
            boot,
            checkpoint: Checkpoint {
                lineage,
                generation,
            },
        })
    }

    pub(crate) fn approval(self, epoch: u64) -> [u8; 36] {
        let mut bytes = [0; 36];
        bytes[..4].copy_from_slice(b"ZWR1");
        bytes[4..12].copy_from_slice(&epoch.to_le_bytes());
        bytes[12..20].copy_from_slice(&self.boot.to_le_bytes());
        bytes[20..28].copy_from_slice(&self.checkpoint.lineage.to_le_bytes());
        bytes[28..36].copy_from_slice(&self.checkpoint.generation.to_le_bytes());
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_admitted_lineage_can_advance_a_world() {
        let mut database = rusqlite::Connection::open_in_memory().unwrap();
        database.execute_batch(SCHEMA).unwrap();
        let checkpoint = Checkpoint {
            lineage: 41,
            generation: 2,
        };
        {
            let tx = database.transaction().unwrap();
            assert!(checkpoint.admit(&tx, "zaton").unwrap());
            tx.commit().unwrap();
        }
        let tx = database.transaction().unwrap();
        assert!(checkpoint.is_current(&tx, "zaton").unwrap());
        assert!(checkpoint.admit(&tx, "zaton").unwrap());
        let older = Checkpoint {
            generation: 1,
            ..checkpoint
        };
        let other_lineage = Checkpoint {
            lineage: 42,
            generation: 99,
        };
        assert!(!older.admit(&tx, "zaton").unwrap());
        assert!(!other_lineage.admit(&tx, "zaton").unwrap());
        assert!(other_lineage.admit(&tx, "jupiter").unwrap());
        let next = Checkpoint {
            generation: 3,
            ..checkpoint
        };
        assert!(next.admit(&tx, "zaton").unwrap());
        assert!(!checkpoint.is_current(&tx, "zaton").unwrap());
        assert!(!checkpoint.admit(&tx, "zaton").unwrap());
        assert!(next.is_current(&tx, "zaton").unwrap());
    }

    #[test]
    fn offers_are_bound_to_the_active_map_and_challenge() {
        let mut packet = [0; 66];
        packet[..4].copy_from_slice(b"ZWO1");
        for (offset, value) in [(4, 6u64), (12, 7), (20, 8), (28, 9), (36, 0)] {
            packet[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        packet[44..49].copy_from_slice(b"zaton");
        let offer = Offer::decode(&packet, 6, 7, "zaton").unwrap();
        assert_eq!(offer.boot, 8);
        assert_eq!(
            offer.checkpoint,
            Checkpoint {
                lineage: 9,
                generation: 0
            }
        );
        assert!(Offer::decode(&packet, 6, 8, "zaton").is_none());
        assert!(Offer::decode(&packet, 8, 7, "zaton").is_none());
        assert!(Offer::decode(&packet, 6, 7, "jupiter").is_none());
        packet[65] = 1;
        assert!(Offer::decode(&packet, 6, 7, "zaton").is_none());
    }
}
