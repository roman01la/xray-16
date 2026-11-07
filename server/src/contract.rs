//! Shared compatibility contract; no synthetic server can advertise a CoP map.
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contract {
    pub schema: u8,
    pub wire: u8,
    pub mode: String,
    pub authority: String,
    pub world: String,
    pub content_revision: String,
    pub coordinates: String,
    pub tick_hz: u32,
    pub snapshot_hz: u32,
}
pub fn current() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../misc/web/multiplayer/contract.json"))
            .expect("invalid embedded session contract")
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contract_matches_runtime() {
        let c = current();
        assert_eq!(c.wire, crate::protocol::VERSION);
        assert_eq!(c.tick_hz, crate::world::TICK_HZ);
        assert_eq!(
            c.snapshot_hz,
            crate::world::TICK_HZ / crate::world::SNAPSHOT_EVERY
        );
        assert_eq!(c.authority, "server");
        assert_eq!(c.world, "synthetic-flat-v1");
    }
    #[test]
    fn wrong_world_and_extra_fields_do_not_match() {
        let mut c = current().clone();
        c.world = "zaton".into();
        assert_ne!(&c, current());
        let mut v = serde_json::to_value(current()).unwrap();
        v["clientOwnsMovement"] = true.into();
        assert!(serde_json::from_value::<Contract>(v).is_err());
    }
}
