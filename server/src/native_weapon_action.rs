//! Private native weapon actions. This codec is not a browser command endpoint.
//! The actor/weapon lane must retain results until a persistence commit or abort.
use serde::{Serialize, Deserialize};
const HEADER: usize = 68;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fence {
    pub epoch: u64,
    pub boot: u64,
    pub player: u32,
    pub life: u32,
    pub sequence: u64,
    pub generation: u64,
    pub item: u128,
    pub revision: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Operation { Reload = 1, Abort = 2, Commit = 3 }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request { pub fence: Fence, pub operation: Operation }
impl Request {
    pub fn encode(self) -> Option<[u8; HEADER]> {
        let f = self.fence;
        if f.epoch == 0 || f.boot == 0 || f.sequence == 0 || f.item == 0 || f.generation > 9_007_199_254_740_991 {
            return None;
        }
        let mut bytes = [0; HEADER];
        bytes[..4].copy_from_slice(b"ZWQ1");
        bytes[4..12].copy_from_slice(&f.epoch.to_le_bytes());
        bytes[12..20].copy_from_slice(&f.boot.to_le_bytes());
        bytes[20..24].copy_from_slice(&f.player.to_le_bytes());
        bytes[24..28].copy_from_slice(&f.life.to_le_bytes());
        bytes[28..36].copy_from_slice(&f.sequence.to_le_bytes());
        bytes[36..44].copy_from_slice(&f.generation.to_le_bytes());
        bytes[44..60].copy_from_slice(&f.item.to_be_bytes());
        bytes[60..64].copy_from_slice(&f.revision.to_le_bytes());
        bytes[64] = self.operation as u8;
        Some(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != HEADER || &bytes[..4] != b"ZWQ1" || bytes[65..] != [0,0,0] { return None; }
        let wide = |at| u64::from_le_bytes(bytes[at..at+8].try_into().unwrap());
        let word = |at| u32::from_le_bytes(bytes[at..at+4].try_into().unwrap());
        let operation = match bytes[64] {1 => Operation::Reload, 2 => Operation::Abort, 3 => Operation::Commit, _ => return None};
        let request = Self { operation, fence: Fence { epoch: wide(4), boot: wide(12), player: word(20), life: word(24),
            sequence: wide(28), generation: wide(36), item: u128::from_be_bytes(bytes[44..60].try_into().unwrap()), revision: word(60) } };
        request.encode()?;
        Some(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weapon_action_wire_fences_every_retry_and_rejects_noncanonical_packets() {
        let request = Request { operation: Operation::Reload, fence: Fence { epoch: 1, boot: 2, player: 3, life: 4,
            sequence: 5, generation: 6, item: 0x11111111111111111111111111111111, revision: 7 } };
        let bytes = request.encode().unwrap();
        assert_eq!(Request::decode(&bytes), Some(request));
        assert_eq!(&bytes[44..60], &[0x11;16]);
        assert_eq!((bytes[20],bytes[28],bytes[36],bytes[60],bytes[64]),(3,5,6,7,1));
        for size in 0..HEADER { assert!(Request::decode(&bytes[..size]).is_none()); }
        for offset in [0,64,65,66,67] { let mut bad=bytes; bad[offset]=255; assert!(Request::decode(&bad).is_none()); }
        let mut bad=bytes.to_vec(); bad.push(0); assert!(Request::decode(&bad).is_none());
        for operation in [Operation::Abort,Operation::Commit] {
            let changed=Request{operation,..request}; assert_eq!(Request::decode(&changed.encode().unwrap()),Some(changed));
        }
        for fence in [Fence{epoch:0,..request.fence},Fence{boot:0,..request.fence},Fence{sequence:0,..request.fence},
            Fence{item:0,..request.fence},Fence{generation:9_007_199_254_740_992,..request.fence}] {
            assert!(Request{fence,..request}.encode().is_none());
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase { Running, Complete, Rejected, Aborted, Committed }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AmmoResult {
    pub item: u128,
    pub revision: u32,
    pub native: u16,
    pub rounds: u16,
    pub section: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WeaponResult {
    pub condition: f32,
    pub mode: u8,
    pub jammed: bool,
    pub launcher: bool,
    pub selected: String,
    pub cartridges: Vec<String>,
    pub grenades: Vec<String>,
    pub reserve: Vec<AmmoResult>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reply { pub fence: Fence, pub phase: Phase, pub state: Option<WeaponResult> }
impl Reply {
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len()<HEADER || bytes.len()>65536 || &bytes[..4]!=b"ZWR1" { return None; }
        let phase=match bytes[64] {1=>Phase::Running,2=>Phase::Complete,3=>Phase::Rejected,4=>Phase::Aborted,5=>Phase::Committed,_=>return None};
        let mut header: [u8;HEADER]=bytes[..HEADER].try_into().ok()?;
        header[..4].copy_from_slice(b"ZWQ1"); header[64]=1;
        let fence=Request::decode(&header)?.fence;
        if phase!=Phase::Complete {
            return (bytes.len()==HEADER).then_some(Self{fence,phase,state:None});
        }
        struct Reader<'a>(&'a [u8]);
        impl Reader<'_> {
            fn take(&mut self,n:usize)->Option<&[u8]> {
                if self.0.len()<n {return None} let (a,b)=self.0.split_at(n);self.0=b;Some(a)
            }
            fn byte(&mut self)->Option<u8>{Some(self.take(1)?[0])}
            fn short(&mut self)->Option<u16>{Some(u16::from_le_bytes(self.take(2)?.try_into().ok()?))}
            fn word(&mut self)->Option<u32>{Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))}
            fn name(&mut self)->Option<String>{
                let n=usize::from(self.byte()?); if !(1..=63).contains(&n){return None}
                let text=self.take(n)?;if !text.iter().all(|c|(33..=126).contains(c)){return None}
                String::from_utf8(text.to_vec()).ok()
            }
            fn magazine(&mut self)->Option<Vec<String>>{
                let n=usize::from(self.short()?);if n>1024{return None}
                (0..n).map(|_|self.name()).collect()
            }
        }
        let mut r=Reader(&bytes[HEADER..]);
        let condition=f32::from_bits(r.word()?);
        if !condition.is_finite() || !(0.0..=1.0).contains(&condition){return None}
        let mode=r.byte()?;let flags=r.byte()?;if flags&!3!=0{return None}
        let selected=r.name()?;let cartridges=r.magazine()?;let grenades=r.magazine()?;
        let count=r.byte()?;if count>128{return None}
        let mut reserve=Vec::with_capacity(count.into());
        let mut ids=std::collections::HashSet::new();let mut natives=std::collections::HashSet::new();
        for _ in 0..count {
            let item=u128::from_be_bytes(r.take(16)?.try_into().ok()?);
            let revision=r.word()?;let native=r.short()?;let rounds=r.short()?;let section=r.name()?;
            if native==u16::MAX || !natives.insert(native) || (item!=0 && !ids.insert(item)) || (item==0 && revision!=0){return None}
            reserve.push(AmmoResult{item,revision,native,rounds,section});
        }
        if !r.0.is_empty(){return None}
        Some(Self{fence,phase,state:Some(WeaponResult{condition,mode,jammed:flags&1!=0,launcher:flags&2!=0,
            selected,cartridges,grenades,reserve})})
    }
}

#[cfg(test)]
mod result_tests {
    use super::*;
    const NATIVE: &[u8]=include_bytes!("../tests/fixtures/native-weapon-result.bin");
    #[test]
    fn reads_native_cpp_result_preserving_round_order_and_box_identity() {
        let reply=Reply::decode(NATIVE).unwrap();
        assert_eq!(reply.phase,Phase::Complete);
        assert_eq!(reply.fence, Fence{epoch:1,boot:2,player:3,life:4,sequence:5,generation:6,item:u128::from_be_bytes([0x11;16]),revision:7});
        let state=reply.state.unwrap();
        assert_eq!((state.condition,state.mode,state.jammed,state.launcher),(0.75,2,true,false));
        assert_eq!(state.cartridges,["ammo_fmj","ammo_ap","ammo_fmj"]);
        assert_eq!(state.grenades,["grenade"]);
        assert_eq!(state.reserve[0],AmmoResult{item:u128::from_be_bytes([0x22;16]),revision:9,native:10,rounds:0,section:"ammo_fmj".into()});
        assert_eq!(state.reserve[1],AmmoResult{item:0,revision:0,native:11,rounds:8,section:"ammo_ap".into()});
    }
    #[test]
    fn malformed_or_partial_results_never_reach_commit() {
        for size in 0..NATIVE.len(){assert!(Reply::decode(&NATIVE[..size]).is_none(),"size {size}");}
        let mut extra=NATIVE.to_vec();extra.push(0);assert!(Reply::decode(&extra).is_none());
        for offset in [0,64,65,66,67,73,74] {
            let mut bad=NATIVE.to_vec();bad[offset]=255;assert!(Reply::decode(&bad).is_none(),"offset {offset}");
        }
        let mut nan=NATIVE.to_vec();nan[68..72].copy_from_slice(&f32::NAN.to_bits().to_le_bytes());assert!(Reply::decode(&nan).is_none());
        for phase in [1,3,4,5] {
            let mut status=NATIVE[..HEADER].to_vec();status[64]=phase;
            assert!(Reply::decode(&status).unwrap().state.is_none());
            status.push(0);assert!(Reply::decode(&status).is_none());
        }
    }
}

/// Applies a native reload as one inventory transaction. Caller owns the SQLite
/// transaction and must send native Commit only after its durable commit succeeds.
pub(crate) fn commit_reload(tx: &rusqlite::Transaction<'_>, context: &crate::inventory::Context,
    catalog: &crate::catalog::Catalog, reply: Reply) -> anyhow::Result<serde_json::Value> {
    use anyhow::{Context as _,ensure};
    use rusqlite::{params,OptionalExtension};
    use crate::inventory::{self,ItemPayload,ItemState};
    use std::collections::{BTreeMap,HashSet};
    ensure!(reply.phase==Phase::Complete,"native reload is incomplete");
    let fence=reply.fence;
    ensure!(Request{fence,operation:Operation::Reload}.encode().is_some(),"invalid native reload fence");
    let request=serde_json::to_string(&(&context.world,context.visit,context.life,&reply))?;
    let key=format!("native-reload:{}:{}:{}:{}:{}",fence.epoch,fence.boot,fence.player,fence.life,fence.sequence);
    let prior:Option<(String,String)>=tx.query_row("SELECT request,response FROM outcomes WHERE principal=?1 AND request_id=?2",
        params![context.principal,key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((original,response))=prior {
        ensure!(original==request,"native reload sequence reused with different result");
        return Ok(serde_json::from_str(&response)?);
    }
    let (life,alive,generation):(u32,bool,i64)=tx.query_row(
        "SELECT life,alive,generation FROM inventory_characters WHERE principal=?1",[&context.principal],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if !alive || life!=context.life || u64::try_from(generation).ok()!=Some(fence.generation) {
        return Ok(serde_json::json!({"status":"stale"}));
    }
    let carried=inventory::personal_container(tx,&context.principal,"carried")?;
    let item=format!("{:032x}",fence.item);
    let slot=inventory::active_weapon_slot(tx,&context.principal)?;
    let row:Option<(String,u32,String)>=tx.query_row(
        "SELECT section,revision,state FROM inventory_items WHERE id=?1 AND container=?2 AND place=?3",
        params![item,carried,format!("slot:{slot}")],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((section,revision,raw))=row else{return Ok(serde_json::json!({"status":"stale"}))};
    if revision!=fence.revision {return Ok(serde_json::json!({"status":"stale"}))}
    let mut weapon:ItemState=serde_json::from_str(&raw)?;
    catalog.validate_state(&section,&weapon)?;
    let native=reply.state.context("missing native weapon state")?;
    ensure!(native.reserve.len()<=128 && native.cartridges.len()<=1024 && native.grenades.len()<=1024,"native result bounds");
    // Reload moves rounds; it cannot mint, destroy or change their section.
    let mut before=BTreeMap::<String,u64>::new();let mut after=BTreeMap::<String,u64>::new();
    let ItemPayload::Weapon{cartridges,launcher_cartridges,selected_ammunition,fire_mode,launcher_mode,jammed,..}=&mut weapon.payload else {anyhow::bail!("native reload target is not weapon")};
    for round in cartridges.iter().chain(launcher_cartridges.iter()){*before.entry(round.clone()).or_default()+=1;}
    for round in native.cartridges.iter().chain(native.grenades.iter()){*after.entry(round.clone()).or_default()+=1;}
    ensure!(native.condition==weapon.condition && native.mode==*fire_mode && native.launcher==*launcher_mode,
        "reload changed unrelated weapon state");
    *cartridges=native.cartridges;*launcher_cartridges=native.grenades;*selected_ammunition=native.selected;*jammed=native.jammed;
    catalog.validate_state(&section,&weapon)?;
    let mut query=tx.prepare("SELECT id,revision,section,state FROM inventory_items WHERE container=?1 AND (place='rucksack' OR place LIKE 'belt:%')")?;
    let rows=query.query_map([&carried],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?;
    let mut existing=BTreeMap::new();
    for row in rows {let(id,revision,section,raw)=row?;let state:ItemState=serde_json::from_str(&raw)?;
        if let ItemPayload::Ammunition{rounds}=&state.payload {
            *before.entry(section.clone()).or_default()+=u64::from(*rounds);
            existing.insert(id,(revision,section,state));
        }
    }
    let mut updates=Vec::new();let mut created=Vec::new();let mut natives=HashSet::new();
    for ammo in native.reserve {
        ensure!(ammo.native!=u16::MAX && natives.insert(ammo.native),"duplicate native ammo identity");
        *after.entry(ammo.section.clone()).or_default()+=u64::from(ammo.rounds);
        let mut persisted=None;
        let mut state=if ammo.item==0 {
            ensure!(ammo.revision==0,"new native ammo has revision");catalog.initial_state(&ammo.section)?
        }else{
            let id=format!("{:032x}",ammo.item);
            let(revision,section,state)=existing.remove(&id).context("missing/duplicate native ammo identity")?;
            ensure!(revision==ammo.revision && section==ammo.section,"native ammo identity changed");
            persisted=Some((id,revision));state
        };
        state.payload=ItemPayload::Ammunition{rounds:ammo.rounds.into()};
        if ammo.rounds>0 {catalog.validate_state(&ammo.section,&state)?;}
        if ammo.item==0 {if ammo.rounds>0{created.push((ammo.native,ammo.section,state));}}
        else if let Some((id,revision))=persisted {updates.push((id,revision,ammo.rounds,state));}
    }
    ensure!(existing.is_empty(),"native result omitted carried ammunition");
    before.retain(|_,n|*n!=0);after.retain(|_,n|*n!=0);
    ensure!(before==after,"native reload did not conserve ammunition");
    for(id,revision,rounds,state) in updates {
        let changed=if rounds==0 {
            tx.execute("DELETE FROM inventory_items WHERE id=?1 AND container=?2 AND revision=?3",params![id,carried,revision])?
        }else{
            let next=revision.checked_add(1).context("ammo revision exhausted")?;
            tx.execute("UPDATE inventory_items SET revision=?1,state=?2 WHERE id=?3 AND container=?4 AND revision=?5",
                params![next,serde_json::to_string(&state)?,id,carried,revision])?
        };
        ensure!(changed==1,"native ammo commit conflict");
    }
    let mut new_ids=Vec::new();
    for(native,section,state) in created {
        let id=inventory::provision(tx,&carried,&section,&state,"rucksack")?;
        new_ids.push(serde_json::json!({"native":native,"id":id}));
    }
    let next=revision.checked_add(1).context("weapon revision exhausted")?;
    ensure!(tx.execute("UPDATE inventory_items SET revision=?1,state=?2 WHERE id=?3 AND container=?4 AND revision=?5",
        params![next,serde_json::to_string(&weapon)?,item,carried,revision])?==1,"native weapon commit conflict");
    let generation:i64=tx.query_row("SELECT generation FROM inventory_characters WHERE principal=?1",[&context.principal],|r|r.get(0))?;
    let response=serde_json::json!({"status":"committed","generation":generation,"revision":next,"created":new_ids});
    tx.execute("INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)",
        params![context.principal,key,request,serde_json::to_string(&response)?])?;
    Ok(response)
}

/// One admitted host/actor action. Network retries never resubmit a completed
/// persistence transaction, and an uncertain database outcome must never abort.
#[derive(Debug,PartialEq,Eq)]
pub enum ReloadStage { Native, Persist, Commit, Abort, Finished }
#[derive(Debug)]
pub struct ReloadCoordinator {
    request: Request,
    stage: ReloadStage,
    result: Option<Reply>,
}
impl ReloadCoordinator {
    pub fn new(fence:Fence)->Option<Self> {
        let request=Request{fence,operation:Operation::Reload};request.encode()?;
        Some(Self{request,stage:ReloadStage::Native,result:None})
    }
    pub fn stage(&self)->&ReloadStage { &self.stage }
    pub fn request(&self)->Option<Request> {
        let operation=match self.stage {
            ReloadStage::Native=>Operation::Reload,
            ReloadStage::Commit=>Operation::Commit,
            ReloadStage::Abort=>Operation::Abort,
            ReloadStage::Persist|ReloadStage::Finished=>return None,
        };
        Some(Request{operation,..self.request})
    }
    pub fn receive(&mut self,reply:Reply)->bool {
        if reply.fence!=self.request.fence{return false}
        match (&self.stage,reply.phase) {
            (ReloadStage::Native,Phase::Complete) if reply.state.is_some()=>{
                self.result=Some(reply);self.stage=ReloadStage::Persist;true
            }
            (ReloadStage::Native,Phase::Rejected|Phase::Aborted)=>{self.stage=ReloadStage::Finished;true}
            (ReloadStage::Commit,Phase::Committed)|(ReloadStage::Abort,Phase::Aborted)=>{
                self.stage=ReloadStage::Finished;true
            }
            _=>false,
        }
    }
    /// Retained byte-equivalent proposal supports retry after lost DB response.
    pub fn proposal(&self)->Option<&Reply> {
        (self.stage==ReloadStage::Persist).then_some(self.result.as_ref()).flatten()
    }
    pub fn persisted(&mut self,committed:bool)->bool {
        if self.stage!=ReloadStage::Persist{return false}
        self.stage=if committed{ReloadStage::Commit}else{ReloadStage::Abort};true
    }
    pub fn cancel(&mut self)->bool {
        if self.stage!=ReloadStage::Native{return false}
        self.stage=ReloadStage::Abort;true
    }
}

#[cfg(test)]
mod coordinator_tests {
    use super::*;
    fn complete()->Reply{Reply::decode(include_bytes!("../tests/fixtures/native-weapon-result.bin")).unwrap()}
    #[test]
    fn reordered_replies_cannot_ack_commit_and_db_uncertainty_cannot_abort() {
        let reply=complete();let mut action=ReloadCoordinator::new(reply.fence).unwrap();
        let mut old=reply.clone();old.fence.life+=1;assert!(!action.receive(old));
        assert_eq!(action.request().unwrap().operation,Operation::Reload);
        assert!(action.receive(reply.clone()));assert!(action.request().is_none());
        assert!(!action.cancel());assert_eq!(action.proposal(),Some(&reply));
        assert!(!action.receive(reply.clone()));assert!(action.persisted(true));
        assert_eq!(action.request().unwrap().operation,Operation::Commit);
        assert!(!action.receive(reply.clone())); // delayed Complete is NOT commit ACK
        assert!(!action.cancel());
        assert!(action.receive(Reply{phase:Phase::Committed,state:None,..reply}));
        assert_eq!(action.stage(),&ReloadStage::Finished);assert!(action.request().is_none());
    }
    #[test]
    fn cancellation_and_failed_transaction_retry_abort_until_ack() {
        let reply=complete();let mut action=ReloadCoordinator::new(reply.fence).unwrap();
        assert!(action.cancel());assert!(!action.receive(reply.clone()));
        assert_eq!(action.request().unwrap().operation,Operation::Abort);
        assert!(action.receive(Reply{phase:Phase::Aborted,state:None,..reply.clone()}));
        let mut action=ReloadCoordinator::new(reply.fence).unwrap();assert!(action.receive(reply.clone()));
        assert!(action.persisted(false));assert_eq!(action.request().unwrap().operation,Operation::Abort);
        assert!(!action.persisted(true));
    }
}
