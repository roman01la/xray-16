//! Revision-fenced condition proposals calculated by the native actor.
//! The checkpoint validator is the same C++ codec used by the host.
use serde::{Deserialize, Serialize};

const HEADER: usize = 60;
pub const MAX_CHECKPOINT: usize = 16_000;
unsafe extern "C" {
    fn zone_condition_policy(bytes: *const u8, size: u32, protected: bool, health_loss: f32,
        output: *mut u8, capacity: u32) -> u32;
    fn zone_condition_import_valid(bytes: *const u8, size: u32) -> bool;
    fn zone_condition_inspect(bytes: *const u8, size: u32, values: *mut f32,
        flags: *mut u32, bleeding: *mut f32, icons: *mut u32) -> bool;
    fn zone_condition_request_valid(bytes: *const u8, size: u32) -> bool;
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Checkpoint(Vec<u8>);

impl<'de> Deserialize<'de> for Checkpoint {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let bytes = Vec::<u8>::deserialize(deserializer)?;
        Self::parse(bytes).ok_or_else(|| serde::de::Error::custom("invalid native condition checkpoint"))
    }
}

/// Initial conversion payload; names are resolved by the actual actor skeleton.
#[derive(Clone)]
pub struct Import(Vec<u8>);
impl Import {
    pub(crate) fn parse(bytes: Vec<u8>) -> Option<Self> {
        if bytes.len() > 32_000 || !unsafe { zone_condition_import_valid(bytes.as_ptr(), bytes.len() as u32) } {
            return None;
        }
        Some(Self(bytes))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Projection {
    pub health: f32,
    pub power: f32,
    pub radiation: f32,
    pub psy_health: f32,
    pub alcohol: f32,
    pub satiety: f32,
    pub bleeding: f32,
    pub carry_limit: f32,
    pub walk_limit: f32,
    pub booster_icons: u32,
    pub limping: bool,
    pub walk_blocked: bool,
    pub sprint_blocked: bool,
}

impl Checkpoint {
    pub fn parse(bytes: Vec<u8>) -> Option<Self> {
        if bytes.len() > MAX_CHECKPOINT { return None; }
        let result = Self(bytes);
        result.projection()?;
        Some(result)
    }
    pub fn with_policy(&self, protected: bool, health_loss: f32) -> Option<Self> {
        let mut bytes=vec![0u8;MAX_CHECKPOINT];
        let count=unsafe { zone_condition_policy(self.0.as_ptr(),self.0.len() as u32,
            protected,health_loss,bytes.as_mut_ptr(),bytes.len() as u32) } as usize;
        if count==0 || count>bytes.len() { return None; }
        bytes.truncate(count);
        Self::parse(bytes)
    }
    pub fn bytes(&self) -> &[u8] { &self.0 }
    pub fn projection(&self) -> Option<Projection> {
        let size = u32::try_from(self.0.len()).ok()?;
        let mut values = [0.0; 23];
        let mut flags = 0;
        let mut bleeding = 0.0;
        let mut icons = 0;
        // The shared codec validates all lengths before accessing variable data;
        // it writes exactly 23 scalar values and retains no pointers.
        if !unsafe { zone_condition_inspect(self.0.as_ptr(), size, values.as_mut_ptr(), &mut flags, &mut bleeding, &mut icons) } {
            return None;
        }
        Some(Projection { health: values[0], power: values[1], radiation: values[2],
            psy_health: values[3], alcohol: values[6], satiety: values[7], bleeding,
            carry_limit: values[19], walk_limit: values[20], booster_icons: icons,
            limping: flags & 1 != 0, walk_blocked: flags & 2 != 0, sprint_blocked: flags & 4 != 0 })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fence {
    pub epoch: u64,
    pub boot: u64,
    pub player: u32,
    pub incarnation: u32,
    pub revision: u64,
    pub sequence: u64,
    pub equipment: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResultState {
    pub checkpoint: Checkpoint,
    /// Outfit/helmet conditions; None is an absent piece of equipment.
    pub wear: Option<[Option<f32>; 2]>,
}

pub struct Hit<'a> {
    pub kind: u32,
    pub power: f32,
    pub penetration: f32,
    pub aimed: bool,
    pub bone: &'a str,
}

#[derive(Clone)]
pub struct Request {
    pub fence: Fence,
    bytes: Vec<u8>,
}

impl Request {
    pub fn new(fence: Fence, seconds: f32, weight: f32, state: Option<&Checkpoint>) -> Option<Self> {
        let mut bytes = Vec::with_capacity(HEADER + state.map_or(0, |s| s.0.len()));
        bytes.extend_from_slice(b"ZCT1");
        bytes.extend_from_slice(&fence.epoch.to_le_bytes());
        bytes.extend_from_slice(&fence.boot.to_le_bytes());
        bytes.extend_from_slice(&fence.player.to_le_bytes());
        bytes.extend_from_slice(&fence.incarnation.to_le_bytes());
        bytes.extend_from_slice(&fence.revision.to_le_bytes());
        bytes.extend_from_slice(&fence.sequence.to_le_bytes());
        bytes.extend_from_slice(&fence.equipment.to_le_bytes());
        bytes.extend_from_slice(&seconds.to_le_bytes());
        bytes.extend_from_slice(&weight.to_le_bytes());
        if let Some(state) = state { bytes.extend_from_slice(state.bytes()); }
        if !unsafe { zone_condition_request_valid(bytes.as_ptr(), bytes.len() as u32) } { return None; }
        Some(Self { fence, bytes })
    }
    pub fn import(fence: Fence, weight: f32, state: &Import) -> Option<Self> {
        let mut request = Self::new(fence, 0.0, weight, None)?;
        request.bytes[2] = b'I';
        request.bytes.extend_from_slice(&state.0);
        if !unsafe { zone_condition_request_valid(request.bytes.as_ptr(), request.bytes.len() as u32) } { return None; }
        Some(request)
    }
    pub fn consume(fence: Fence, weight: f32, state: &Checkpoint, section: &str) -> Option<Self> {
        if section.is_empty() || section.len() > 128 { return None; }
        let mut request = Self::new(fence, 0.0, weight, None)?;
        request.bytes[2] = b'M';
        request.bytes.extend_from_slice(&(state.bytes().len() as u32).to_le_bytes());
        request.bytes.extend_from_slice(state.bytes());
        request.bytes.extend_from_slice(section.as_bytes());
        if !unsafe { zone_condition_request_valid(request.bytes.as_ptr(), request.bytes.len() as u32) } { return None; }
        Some(request)
    }
    pub fn hit(fence: Fence, weight: f32, state: &Checkpoint, hit: Hit<'_>) -> Option<Self> {
        if hit.bone.len()>63 { return None; }
        let mut request=Self::new(fence,0.0,weight,None)?;
        request.bytes[2]=b'H';
        request.bytes.extend_from_slice(&(state.bytes().len() as u32).to_le_bytes());
        request.bytes.extend_from_slice(state.bytes());
        request.bytes.extend_from_slice(&hit.kind.to_le_bytes());
        request.bytes.extend_from_slice(&hit.power.to_le_bytes());
        request.bytes.extend_from_slice(&hit.penetration.to_le_bytes());
        request.bytes.extend_from_slice(&u32::from(hit.aimed).to_le_bytes());
        request.bytes.extend_from_slice(hit.bone.as_bytes());
        if !unsafe { zone_condition_request_valid(request.bytes.as_ptr(),request.bytes.len() as u32) } { return None; }
        Some(request)
    }
    /// Ordered physical hits, including shotgun pellets. The native actor
    /// carries armour wear and wounds forward before producing one checkpoint.
    pub fn batch(fence: Fence, weight: f32, state: &Checkpoint, hits: &[Hit<'_>]) -> Option<Self> {
        if hits.is_empty() || hits.len()>64 { return None; }
        let mut request=Self::new(fence,0.0,weight,None)?;
        request.bytes[2]=b'B';
        request.bytes.extend_from_slice(&(state.bytes().len() as u32).to_le_bytes());
        request.bytes.extend_from_slice(state.bytes());
        request.bytes.extend_from_slice(&(hits.len() as u32).to_le_bytes());
        for hit in hits {
            if hit.bone.len()>63 { return None; }
            request.bytes.extend_from_slice(&hit.kind.to_le_bytes());
            request.bytes.extend_from_slice(&hit.power.to_le_bytes());
            request.bytes.extend_from_slice(&hit.penetration.to_le_bytes());
            request.bytes.extend_from_slice(&u32::from(hit.aimed).to_le_bytes());
            request.bytes.extend_from_slice(&(hit.bone.len() as u32).to_le_bytes());
            request.bytes.extend_from_slice(hit.bone.as_bytes());
        }
        if !unsafe {zone_condition_request_valid(request.bytes.as_ptr(),request.bytes.len() as u32)} {return None;}
        Some(request)
    }
    pub fn fields(fence:Fence,weight:f32,state:&Checkpoint,pulses:&[crate::environment::Pulse])->Option<Self> {
        if pulses.is_empty() || pulses.len()>64 {return None;}
        let mut request=Self::new(fence,0.0,weight,None)?;
        request.bytes[2]=b'F';
        request.bytes.extend_from_slice(&(state.bytes().len() as u32).to_le_bytes());
        request.bytes.extend_from_slice(state.bytes());
        request.bytes.extend_from_slice(&(pulses.len() as u32).to_le_bytes());
        for pulse in pulses {
            use crate::environment::Kind;
            let kind:u32=match pulse.kind {Kind::Radiation=>3,Kind::Acid=>2,Kind::Heat=>10,Kind::Psy=>4,Kind::Shock=>1};
            request.bytes.extend_from_slice(&kind.to_le_bytes()); request.bytes.extend_from_slice(&pulse.power.to_le_bytes());
        }
        if !unsafe {zone_condition_request_valid(request.bytes.as_ptr(),request.bytes.len() as u32)} {return None;}
        Some(request)
    }
    pub fn accept_result(&self, packet: &[u8], current: Fence) -> Option<ResultState> {
        if !matches!(self.bytes[2],b'H'|b'F'|b'B') {
            return self.accept(packet,current).map(|checkpoint| ResultState{checkpoint,wear:None});
        }
        if current != self.fence || packet.len() <= HEADER+8 || packet.len() > HEADER+8+MAX_CHECKPOINT
            || &packet[..4] != b"ZCV1" || packet[4..HEADER] != self.bytes[4..HEADER] { return None; }
        let mut wear=[None;2];
        for (index,item) in wear.iter_mut().enumerate() {
            let at=HEADER+index*4;
            let value=f32::from_le_bytes(packet[at..at+4].try_into().ok()?);
            if value != -1.0 {
                if !value.is_finite() || !(0.0..=1.0).contains(&value) { return None; }
                *item=Some(value);
            }
        }
        Some(ResultState{checkpoint:Checkpoint::parse(packet[HEADER+8..].to_vec())?,wear:Some(wear)})
    }
    pub fn bytes(&self) -> &[u8] { &self.bytes }
    pub fn accept(&self, packet: &[u8], current: Fence) -> Option<Checkpoint> {
        if matches!(self.bytes[2],b'H'|b'F'|b'B') || current != self.fence || packet.len() <= HEADER || packet.len() > HEADER+MAX_CHECKPOINT
            || &packet[..4] != b"ZCU1" || packet[4..HEADER] != self.bytes[4..HEADER] { return None; }
        Checkpoint::parse(packet[HEADER..].to_vec())
    }
}


/// Internal persistence command; never accepted directly from a browser.
#[derive(Clone, Serialize)]
pub struct Commit {
    pub before: crate::survival::Record,
    pub equipment: u64,
    pub checkpoint: Checkpoint,
    pub location: crate::survival::Location,
}

/// Native item effects, committed together with exactly one inventory use.
#[derive(Clone)]
pub struct Consumption {
    pub before: crate::survival::Record,
    pub equipment: u64,
    pub section: String,
    pub checkpoint: Checkpoint,
}

#[derive(Clone, Serialize)]
pub struct Impact {
    pub condition: Commit,
    pub wear: [Option<f32>;2],
    pub combat_until_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Attack {
    Firearm(crate::ballistics::RoundProfile),
    Knife { mode:crate::knife::Mode, splash:bool },
}

/// Native victim result bound to the weapon revision and ballistic profile
/// reserved by the server before asking X-Ray to resolve the hit batch.
#[derive(Clone)]
pub struct Shot {
    pub attack: Attack,
    pub equipment: u64,
    pub result: ResultState,
}

pub(crate) const SCHEMA:&str="
CREATE TABLE native_condition_receipts (
 principal TEXT PRIMARY KEY REFERENCES principals(id), life INTEGER NOT NULL,
 visit INTEGER NOT NULL, world TEXT NOT NULL, revision INTEGER NOT NULL,
 fingerprint BLOB NOT NULL, response TEXT NOT NULL);
PRAGMA user_version=23;";

fn fingerprint(kind:&str, proposal:&impl Serialize)->anyhow::Result<Vec<u8>> {
    use sha2::{Digest,Sha256};
    Ok(Sha256::digest(serde_json::to_vec(&(kind,proposal))?).to_vec())
}
fn replay(tx:&rusqlite::Transaction<'_>,context:&crate::inventory::Context,key:&[u8])
    ->anyhow::Result<Option<serde_json::Value>> {
    use rusqlite::OptionalExtension;
    let raw:Option<String>=tx.query_row("SELECT r.response FROM native_condition_receipts r
        JOIN inventory_characters c ON c.principal=r.principal
        WHERE r.principal=?1 AND r.life=?2 AND r.visit=?3 AND r.world=?4 AND r.fingerprint=?5
        AND c.life=r.life AND c.condition_revision=r.revision",
        rusqlite::params![context.principal,context.life,context.visit,context.world,key],|r|r.get(0)).optional()?;
    raw.map(|raw|serde_json::from_str(&raw).map_err(Into::into)).transpose()
}
fn receipt(tx:&rusqlite::Transaction<'_>,context:&crate::inventory::Context,key:&[u8],value:&serde_json::Value)
    ->anyhow::Result<()> {
    tx.execute("INSERT INTO native_condition_receipts(principal,life,visit,world,revision,fingerprint,response)
        VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(principal) DO UPDATE SET life=excluded.life,
        visit=excluded.visit,world=excluded.world,revision=excluded.revision,
        fingerprint=excluded.fingerprint,response=excluded.response",
        rusqlite::params![context.principal,context.life,context.visit,context.world,
            value["revision"].as_u64().unwrap() as i64,key,serde_json::to_string(value)?])?;
    Ok(())
}

pub(crate) fn commit_impact(
    tx: &rusqlite::Transaction<'_>, context: &crate::inventory::Context,
    catalog: &crate::catalog::Catalog, rules: Option<&crate::survival_rules::SurvivalRules>,
    proposal: Impact,
) -> anyhow::Result<serde_json::Value> {
    anyhow::ensure!(proposal.condition.location.world == context.world, "native hit world differs from visit");
    let key=fingerprint("hit",&proposal)?;
    if let Some(value)=replay(tx,context,&key)? {return Ok(value);}
    if !crate::survival::impact_current(tx, context, &proposal.condition.before)? {
        return Ok(serde_json::json!({"status":"stale"}));
    }
    let character=crate::world::CharacterKey{principal:context.principal.clone(),life:context.life};
    let Some((gear_changed, field_armour))=crate::armour::apply_native_wear(tx,catalog,&character,
        proposal.condition.equipment,proposal.wear)? else {
        return Ok(serde_json::json!({"status":"stale"}));
    };
    let mut record=proposal.condition.before;
    record.state.install_native_checkpoint(proposal.condition.checkpoint)?;
    let state=record.state.clone();
    let mut location=proposal.condition.location;
    location.combat_until_ms=location.combat_until_ms.max(proposal.combat_until_ms);
    // Wear has already changed the generation inside this transaction. Commit
    // against the original condition revision, without rechecking old equipment.
    let result=crate::survival::commit_condition_change(tx,context,rules,record,location)?;
    let value=serde_json::json!({"status":"committed","revision":result.revision,"alive":result.alive,
        "state":state,"gear_changed":gear_changed,"field_armour":field_armour});
    receipt(tx,context,&key,&value)?;
    Ok(value)
}

pub(crate) fn commit(
    tx: &rusqlite::Transaction<'_>, context: &crate::inventory::Context,
    rules: Option<&crate::survival_rules::SurvivalRules>, proposal: Commit,
) -> anyhow::Result<serde_json::Value> {
    use anyhow::ensure;
    ensure!(proposal.location.world == context.world, "native condition world differs from visit");
    let key=fingerprint("step",&proposal)?;
    if let Some(value)=replay(tx,context,&key)? {return Ok(value);}
    if !crate::survival::impact_current(tx, context, &proposal.before)? {
        return Ok(serde_json::json!({"status":"stale"}));
    }
    let generation: i64 = tx.query_row("SELECT generation FROM inventory_characters WHERE principal=?1",
        [&context.principal], |row| row.get(0))?;
    if u64::try_from(generation).ok() != Some(proposal.equipment) {
        return Ok(serde_json::json!({"status":"stale"}));
    }
    let mut record = proposal.before;
    record.state.install_native_checkpoint(proposal.checkpoint)?;
    let state = record.state.clone();
    let result = crate::survival::commit_condition_change(tx, context, rules, record, proposal.location)?;
    let value=serde_json::json!({"status":"committed", "revision":result.revision,
        "alive":result.alive, "state":state});
    receipt(tx,context,&key,&value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn checkpoint() -> Checkpoint {
        let mut bytes = b"ZCS1".to_vec();
        let mut values = [0.0f32; 23+8+12+9];
        values[0] = 0.8765432; values[1] = 0.7654321; values[5] = 1.0;
        values[18] = 1.0; values[19] = 50.0; values[20] = 60.0;
        for value in values { bytes.extend_from_slice(&value.to_le_bytes()); }
        for value in [0u32, 31, 0, 0] { bytes.extend_from_slice(&value.to_le_bytes()); }
        Checkpoint::parse(bytes).unwrap()
    }
    fn fence() -> Fence {
        Fence { epoch: 1, boot: 2, player: 3, incarnation: 4, revision: 5, sequence: 6, equipment: 7 }
    }
    #[test]
    fn physical_batch_rejects_partial_or_malformed_pellets_and_requires_atomic_wear() {
        let state=checkpoint();
        let hits=[Hit{kind:6,power:0.23,penetration:0.7,aimed:true,bone:"bip01_head"},
            Hit{kind:6,power:0.17,penetration:0.4,aimed:false,bone:"bip01_spine"}];
        let request=Request::batch(fence(),12.0,&state,&hits).unwrap();
        assert_eq!(&request.bytes()[..4],b"ZCB1");
        for size in 0..request.bytes().len() {
            assert!(!unsafe {zone_condition_request_valid(request.bytes().as_ptr(),size as u32)});
        }
        let start=HEADER+8+state.bytes().len();
        for offset in [start,start+4,start+8,start+12,start+16] {
            let mut bad=request.bytes().to_vec();
            bad[offset..offset+4].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(!unsafe {zone_condition_request_valid(bad.as_ptr(),bad.len() as u32)});
        }
        let gauss=Hit{kind:6,power:1.0,penetration:150.0,aimed:true,bone:"bip01_head"};
        assert!(Request::batch(fence(),0.0,&state,&[gauss]).is_some());
        assert!(Request::hit(fence(),0.0,&state,Hit{kind:6,power:1.0,penetration:150.0,aimed:true,bone:""}).is_some());
        assert!(Request::batch(fence(),0.0,&state,&[Hit{kind:6,power:1.0,penetration:1000.1,aimed:false,bone:""}]).is_none());
        let mut trailing=request.bytes().to_vec(); trailing.push(0);
        assert!(!unsafe {zone_condition_request_valid(trailing.as_ptr(),trailing.len() as u32)});
        assert!(Request::batch(fence(),0.0,&state,&[]).is_none());
        let many:Vec<_>=(0..65).map(|_|Hit{kind:6,power:0.1,penetration:0.4,aimed:false,bone:""}).collect();
        assert!(Request::batch(fence(),0.0,&state,&many[..64]).is_some());
        assert!(Request::batch(fence(),0.0,&state,&many).is_none());
        let mut reply=request.bytes()[..HEADER].to_vec(); reply[2]=b'U'; reply.extend_from_slice(state.bytes());
        assert!(request.accept_result(&reply,fence()).is_none());
        reply.truncate(HEADER); reply[2]=b'V';
        reply.extend_from_slice(&0.2f32.to_le_bytes()); reply.extend_from_slice(&0.1f32.to_le_bytes());
        reply.extend_from_slice(state.bytes());
        assert_eq!(request.accept_result(&reply,fence()).unwrap().wear,Some([Some(0.2),Some(0.1)]));
        assert!(request.accept(&reply,fence()).is_none());
        assert!(request.accept_result(&reply,Fence{sequence:7,..fence()}).is_none());
    }
    #[test]
    fn ordered_field_batch_is_bounded_and_requires_wear_reply() {
        use crate::environment::{Kind,Pulse};
        let state=checkpoint();
        let pulses=[Pulse{kind:Kind::Radiation,power:0.12},Pulse{kind:Kind::Heat,power:0.31},Pulse{kind:Kind::Acid,power:0.07}];
        let request=Request::fields(fence(),1.0,&state,&pulses).unwrap();
        let at=HEADER+4+state.bytes().len();
        assert_eq!(&request.bytes()[..4],b"ZCF1");
        assert_eq!(u32::from_le_bytes(request.bytes()[at..at+4].try_into().unwrap()),3);
        for (i,kind) in [3u32,10,2].into_iter().enumerate() {
            let pos=at+4+i*8;
            assert_eq!(u32::from_le_bytes(request.bytes()[pos..pos+4].try_into().unwrap()),kind);
            assert_eq!(f32::from_le_bytes(request.bytes()[pos+4..pos+8].try_into().unwrap()),pulses[i].power);
        }
        for size in 0..request.bytes().len() {
            assert!(!unsafe {zone_condition_request_valid(request.bytes().as_ptr(),size as u32)});
        }
        assert!(Request::fields(fence(),1.0,&state,&[]).is_none());
        assert!(Request::fields(fence(),1.0,&state,&vec![pulses[0];64]).is_some());
        assert!(Request::fields(fence(),1.0,&state,&vec![pulses[0];65]).is_none());
        assert!(Request::fields(fence(),1.0,&state,&[Pulse{kind:Kind::Shock,power:f32::NAN}]).is_none());
        let mut reply=request.bytes()[..HEADER].to_vec();reply[2]=b'V';
        reply.extend_from_slice(&0.3f32.to_le_bytes());reply.extend_from_slice(&(-1.0f32).to_le_bytes());reply.extend_from_slice(state.bytes());
        assert_eq!(request.accept_result(&reply,fence()).unwrap().wear,Some([Some(0.3),None]));
        assert!(request.accept(&reply,fence()).is_none());
    }
    #[test]
    fn custom_policy_is_retryable_and_preserves_native_wounds_and_timers() {
        let mut original=checkpoint().bytes().to_vec();
        original[220..224].copy_from_slice(&1u32.to_le_bytes());
        original[224..228].copy_from_slice(&1u32.to_le_bytes());
        original.extend_from_slice(&7u32.to_le_bytes()); original.extend_from_slice(&0u32.to_le_bytes());
        for _ in 0..12 { original.extend_from_slice(&0.1234567f32.to_le_bytes()); }
        original.extend_from_slice(&4u32.to_le_bytes()); original.extend_from_slice(&20f32.to_le_bytes());
        original.extend_from_slice(&32.5f32.to_le_bytes());
        let state=Checkpoint::parse(original.clone()).unwrap();
        let input=state.with_policy(false,0.02).unwrap();
        let delta=f32::from_le_bytes(input.bytes()[36..40].try_into().unwrap());
        assert_eq!(delta,-0.02);
        let mut expected=original.clone(); expected[36..40].copy_from_slice(&(-0.02f32).to_le_bytes());
        assert_eq!(input.bytes(),expected);

        assert_eq!(state.bytes(),original);
        assert_eq!(state.with_policy(false,0.02),Some(input.clone()));
        assert_eq!(input.projection().unwrap().health,state.projection().unwrap().health);
        let protected=state.with_policy(true,0.02).unwrap();
        assert_eq!(f32::from_le_bytes(protected.bytes()[36..40].try_into().unwrap()),0.0);
        let flags=u32::from_le_bytes(protected.bytes()[216..220].try_into().unwrap());
        assert_eq!(flags&16,0);
        let vulnerable=protected.with_policy(false,0.0).unwrap();
        assert_ne!(u32::from_le_bytes(vulnerable.bytes()[216..220].try_into().unwrap())&16,0);
        for loss in [-1.0,1.1,f32::NAN,f32::INFINITY] { assert!(state.with_policy(false,loss).is_none()); }
    }
    #[test]
    fn native_hit_requires_complete_wear_and_checkpoint_result() {
        let state=checkpoint();
        let request=Request::hit(fence(),5.0,&state,Hit{kind:6,power:0.5,penetration:0.7,aimed:false,bone:"bip01_spine"}).unwrap();
        let mut response=request.bytes()[..HEADER].to_vec(); response[2]=b'V';
        response.extend_from_slice(&0.75f32.to_le_bytes()); response.extend_from_slice(&(-1.0f32).to_le_bytes());
        response.extend_from_slice(state.bytes());
        assert_eq!(request.accept_result(&response,fence()),Some(ResultState{checkpoint:state,wear:Some([Some(0.75),None])}));
        assert!(request.accept(&response,fence()).is_none());
        for n in 0..response.len() { assert!(request.accept_result(&response[..n],fence()).is_none()); }
        let mut stale=fence(); stale.equipment+=1; assert!(request.accept_result(&response,stale).is_none());
        response[HEADER..HEADER+4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(request.accept_result(&response,fence()).is_none());
    }
    #[test]
    fn consumable_proposal_requires_checkpoint_and_config_section() {
        let state = checkpoint();
        let request = Request::consume(fence(), 12.0, &state, "medkit_army").unwrap();
        assert_eq!(&request.bytes()[..4], b"ZCM1");
        assert_eq!(&request.bytes()[HEADER+4..HEADER+4+state.bytes().len()], state.bytes());
        for section in ["", "../medkit", "medkit\0", "медкит"] {
            assert!(Request::consume(fence(), 12.0, &state, section).is_none());
        }
        assert!(Request::consume(fence(), 12.0, &state, &"a".repeat(129)).is_none());
        let mut response = request.bytes()[..HEADER].to_vec();
        response[2] = b'U'; response.extend_from_slice(state.bytes());
        assert_eq!(request.accept(&response, fence()), Some(state));
    }
    #[test]
    fn persisted_checkpoint_uses_native_validation_and_preserves_exact_floats() {
        let original = checkpoint();
        let json = serde_json::to_vec(&original).unwrap();
        let copy: Checkpoint = serde_json::from_slice(&json).unwrap();
        assert_eq!(copy, original);
        assert_eq!(copy.projection().unwrap().health, 0.8765432);
        let mut bad = original.0; bad[4..8].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(serde_json::from_value::<Checkpoint>(serde_json::json!(bad)).is_err());
    }
    #[test]
    fn host_reply_requires_exact_current_fence_and_complete_native_checkpoint() {
        let input = checkpoint();
        let request = Request::new(fence(), 0.1, 25.0, Some(&input)).unwrap();
        let mut reply = request.bytes.clone(); reply[2] = b'U';
        assert_eq!(request.accept(&reply, fence()).unwrap(), input);
        for field in 0..7 {
            let mut current = fence();
            match field { 0=>current.epoch+=1, 1=>current.boot+=1, 2=>current.player+=1,
                3=>current.incarnation+=1, 4=>current.revision+=1, 5=>current.sequence+=1,
                _=>current.equipment+=1 }
            assert!(request.accept(&reply, current).is_none());
        }
        for n in 0..reply.len() { assert!(request.accept(&reply[..n], fence()).is_none()); }
        reply[52] ^= 1; assert!(request.accept(&reply, fence()).is_none());
        assert!(Request::new(fence(), 0.1, 25.0, None).is_none());
        assert!(Request::new(fence(), 0.0, 25.0, None).is_some());
        assert!(Request::new(fence(), 1.1, 25.0, Some(&input)).is_some());
        assert!(Request::new(fence(), 60.0, 25.0, Some(&input)).is_some());
        assert!(Request::new(fence(), 60.1, 25.0, Some(&input)).is_none());
    }
}
