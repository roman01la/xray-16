//! CoP gamemtl.xr chunk layout, matching xrMaterialSystem/GameMtlLib.cpp.
use anyhow::{Result, ensure};
use std::collections::BTreeMap;
pub const PASSABLE: u32 = 1 << 7;
pub const DYNAMIC: u32 = 1 << 8;
pub const ACTOR_OBSTACLE: u32 = 1 << 12;
#[derive(Debug)]
pub struct Material {
    pub flags: u32,
    pub shoot_factor: f32,
}

pub fn blocks_actor(flags: u32) -> bool {
    flags & PASSABLE == 0 || flags & ACTOR_OBSTACLE != 0
}
fn chunks(bytes: &[u8]) -> Result<BTreeMap<u32, &[u8]>> {
    let mut out = BTreeMap::new();
    let mut at = 0;
    while at < bytes.len() {
        ensure!(bytes.len() - at >= 8, "truncated material chunk");
        let id = u32::from_le_bytes(bytes[at..at + 4].try_into()?);
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into()?) as usize;
        at += 8;
        ensure!(
            id & 0x80000000 == 0 && len <= bytes.len() - at,
            "invalid/compressed material chunk"
        );
        ensure!(
            out.insert(id, &bytes[at..at + len]).is_none(),
            "duplicate material chunk"
        );
        at += len;
    }
    Ok(out)
}
pub fn parse(bytes: &[u8]) -> Result<BTreeMap<u32, Material>> {
    ensure!(bytes.len() <= 4 * 1024 * 1024, "oversized material library");
    let root = chunks(bytes)?;
    ensure!(
        root.get(&0x1000).copied() == Some(&[1, 0][..]),
        "unsupported material version"
    );
    let records = chunks(
        root.get(&0x1002)
            .ok_or_else(|| anyhow::anyhow!("missing materials"))?,
    )?;
    let mut out = BTreeMap::new();
    for record in records.values() {
        let fields = chunks(record)?;
        let main = fields
            .get(&0x1000)
            .ok_or_else(|| anyhow::anyhow!("missing material ID"))?;
        let flags = fields
            .get(&0x1001)
            .ok_or_else(|| anyhow::anyhow!("missing material flags"))?;
        let factors = fields
            .get(&0x1003)
            .ok_or_else(|| anyhow::anyhow!("missing material factors"))?;
        ensure!(
            main.len() >= 5 && main[4..].contains(&0) && flags.len() == 4,
            "invalid material record"
        );
        ensure!(factors.len() >= 4, "truncated material factors");
        let shoot_factor = f32::from_le_bytes(factors[..4].try_into()?);
        ensure!((0.0..=1.0).contains(&shoot_factor), "invalid material shoot factor");
        let id = u32::from_le_bytes(main[..4].try_into()?);
        let material = Material { flags: u32::from_le_bytes(flags[..4].try_into()?), shoot_factor };
        ensure!(
            out.insert(id, material).is_none(),
            "duplicate material ID"
        );
    }
    ensure!(!out.is_empty(), "empty material library");
    Ok(out)
}
#[cfg(test)]
pub(crate) use tests::{fixture, fixture_with_factors};
#[cfg(test)]
mod tests {
    use super::*;
    pub(crate) fn fixture(records: &[(u32, u32)]) -> Vec<u8> {
        let records: Vec<_> = records.iter().map(|&(id, flags)| (id, flags, 1.0)).collect();
        fixture_with_factors(&records)
    }
    pub(crate) fn fixture_with_factors(records: &[(u32, u32, f32)]) -> Vec<u8> {
        fn chunk(id: u32, b: &[u8]) -> Vec<u8> {
            [
                id.to_le_bytes().as_slice(),
                (b.len() as u32).to_le_bytes().as_slice(),
                b,
            ]
            .concat()
        }
        let mut mtls = Vec::new();
        for (i, (id, flags, shoot_factor)) in records.iter().enumerate() {
            let main = [id.to_le_bytes().as_slice(), b"test\0"].concat();
            let r = [
                chunk(0x1000, &main), chunk(0x1001, &flags.to_le_bytes()),
                chunk(0x1003, &shoot_factor.to_le_bytes()),
            ].concat();
            mtls.extend(chunk(i as u32, &r));
        }
        [chunk(0x1000, &[1, 0]), chunk(0x1002, &mtls)].concat()
    }
    #[test]
    fn flag_precedence_and_ids() {
        let m = parse(&fixture(&[
            (50, PASSABLE),
            (99, PASSABLE | ACTOR_OBSTACLE),
            (3, 0),
        ]))
        .unwrap();
        assert!(!blocks_actor(m[&50].flags));
        assert!(blocks_actor(m[&99].flags));
        assert!(blocks_actor(m[&3].flags));
        assert_eq!(m[&3].shoot_factor, 1.0);
        assert!(parse(&fixture_with_factors(&[(1, 0, f32::NAN)])).is_err());
        assert!(parse(&fixture(&[(1, 0), (1, 0)])).is_err());
        let mut b = fixture(&[(1, 0)]);
        b.pop();
        assert!(parse(&b).is_err());
    }
}
