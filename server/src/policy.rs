//! Generic authorization checkpoint. No survival/balance policy is selected here.
use std::time::Instant;
#[derive(Clone)]
pub struct ActionContext {
    pub principal: String,
    pub world: Option<String>,
    pub session: Option<u64>,
    pub expires: Instant,
}
pub fn scene_action_allowed(
    principal: &str,
    scene_world: Option<&str>,
    context: Option<&ActionContext>,
) -> bool {
    let Some(world) = scene_world else {
        return true;
    };
    context.is_some_and(|c| {
        c.principal == principal
            && c.session.is_some()
            && c.world.as_deref() == Some(world)
            && Instant::now() <= c.expires
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn scene_policy_requires_bound_live_context_and_world() {
        assert!(scene_action_allowed("a", None, None));
        assert!(!scene_action_allowed("a", Some("zaton"), None));
        let mut c = ActionContext {
            principal: "a".into(),
            world: Some("zaton".into()),
            session: Some(1),
            expires: Instant::now() + Duration::from_secs(1),
        };
        assert!(scene_action_allowed("a", Some("zaton"), Some(&c)));
        assert!(!scene_action_allowed("b", Some("zaton"), Some(&c)));
        assert!(!scene_action_allowed("a", Some("elsewhere"), Some(&c)));
        c.expires = Instant::now() - Duration::from_secs(1);
        assert!(!scene_action_allowed("a", Some("zaton"), Some(&c)));
    }
}

/// Database identity and epoch are read in one transaction. A queued offer must
/// not outlive a revocation already observed by the simulation.
pub struct Admission {
    pub principal: String,
    pub auth_epoch: i64,
    pub campaign_visit: u32,
}
impl Admission {
    pub fn valid_at(&self, epoch: i64) -> bool {
        self.auth_epoch == epoch
    }
}
#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn queued_authentication_cannot_cross_revocation_epoch() {
        let ticket = Admission {
            principal: "a".into(),
            auth_epoch: 4,
            campaign_visit: 0,
        };
        assert!(ticket.valid_at(4));
        assert!(!ticket.valid_at(5));
        assert!(!ticket.valid_at(3));
    }
}
