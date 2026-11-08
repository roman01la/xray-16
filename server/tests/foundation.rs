use zone_server::{protocol::*, world::*};
fn pos(x: f32) -> Vec3 {
    Vec3 { x, y: 0., z: 0. }
}
fn input(sequence: u32) -> Input {
    Input {
        sequence,
        x: 1.,
        z: 1.,
        yaw: 0.,
        sprint: true,
        jump: false,
        crouch: false,
    }
}
#[test]
fn inputs_cannot_accelerate_the_server_clock() {
    let mut w = World::new();
    let a = w.spawn(Kind::Player, pos(0.));
    for sequence in 1..1000 {
        assert!(w.input(a, input(sequence)));
    }
    assert_eq!(w.entities[&a].position, pos(0.));
    w.step();
    assert!((w.entities[&a].position.distance_squared(pos(0.)).sqrt() - 0.2).abs() < 0.00001);
    assert!(!w.input(a, input(998)));
    assert!(!w.input(a, input(999)));
    for _ in 0..INPUT_TIMEOUT_TICKS {
        w.step();
    }
    let stopped = w.entities[&a].position;
    for _ in 0..30 {
        w.step();
    }
    assert_eq!(w.entities[&a].position, stopped);
}
#[test]
fn input_wrap_nan_and_npc_guard() {
    let mut w = World::new();
    let a = w.spawn(Kind::Player, pos(0.));
    let npc = w.spawn(Kind::Npc, pos(0.));
    assert!(w.input(a, input(u32::MAX)));
    assert!(w.input(a, input(0)));
    assert!(!w.input(a, input(u32::MAX)));
    assert!(!w.input(npc, input(1)));
    assert!(!w.input(
        a,
        Input {
            x: f32::NAN,
            ..input(1)
        }
    ));
}
#[test]
fn safe_zone_protects_both_sides_and_npcs() {
    let mut w = World::new();
    let a = w.spawn(Kind::Player, pos(10.));
    let b = w.spawn(Kind::Player, pos(11.));
    let npc = w.spawn(Kind::Npc, pos(9.));
    assert_eq!(w.attack(a, b), DamageResult::SafeZone);
    assert_eq!(w.attack(b, a), DamageResult::SafeZone);
    assert_eq!(w.attack(b, npc), DamageResult::SafeZone);
    assert_eq!(w.attack(npc, b), DamageResult::SafeZone);
    assert_eq!(w.entities[&a].health, 100);
    assert_eq!(w.entities[&b].health, 100);
}
#[test]
fn authoritative_damage_cooldown_range_and_death() {
    let mut w = World::new();
    let a = w.spawn(Kind::Player, pos(20.));
    let b = w.spawn(Kind::Npc, pos(22.));
    let far = w.spawn(Kind::Player, pos(30.));
    assert_eq!(w.attack(a, far), DamageResult::OutOfRange);
    assert_eq!(w.attack(a, a), DamageResult::InvalidTarget);
    for health in [75, 50, 25, 0] {
        assert_eq!(w.attack(a, b), DamageResult::Applied { health });
        if health > 0 {
            assert_eq!(w.attack(a, b), DamageResult::Cooldown);
        }
        for _ in 0..15 {
            w.step();
        }
    }
    assert_eq!(w.attack(a, b), DamageResult::Dead);
    assert_eq!(w.attack(b, a), DamageResult::Dead);
}
#[test]
fn interest_boundary_and_removal() {
    let mut w = World::new();
    let a = w.spawn(Kind::Player, pos(-64.));
    let near = w.spawn(Kind::Npc, pos(36.));
    let far = w.spawn(Kind::Npc, pos(36.1));
    let ids: Vec<_> = w.visible_to(a).iter().map(|e| e.id).collect();
    assert_eq!(ids, vec![a, near]);
    assert!(!ids.contains(&far));
    w.remove(near);
    assert_eq!(w.visible_to(a).len(), 1);
    w.step();
    assert_eq!(w.visible_to(a).len(), 1);
}
#[test]
fn wire_input_validation() {
    let mut b = vec![0; 20];
    b[0..2].copy_from_slice(&MAGIC.to_le_bytes());
    b[2] = VERSION;
    b[3] = 1;
    b[4..8].copy_from_slice(&42u32.to_le_bytes());
    b[8..10].copy_from_slice(&32767i16.to_le_bytes());
    assert_eq!(decode_input(&b).unwrap().sequence, 42);
    assert_eq!(decode_input(&b).unwrap().x, 1.);
    for size in 0..20 {
        assert!(decode_input(&b[..size]).is_none());
    }
    b[18] = 1;
    assert!(decode_input(&b).is_none());
    b[18] = 0;
    b[16] = 7;
    let stance = decode_input(&b).unwrap();
    assert!(stance.sprint && stance.jump && stance.crouch);
    b[16] = 8;
    assert!(decode_input(&b).is_none());
    b[16] = 0;
    b[12..16].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(decode_input(&b).is_none());
    b[12..16].copy_from_slice(&0.5f32.to_le_bytes());
    b.extend(61u32.to_le_bytes());
    b.extend(100u32.to_le_bytes());
    b.extend((-0.25f32).to_le_bytes());
    let (input, trigger) = decode_player_input(&b).unwrap();
    assert_eq!(input.sequence, 42);
    let trigger = trigger.unwrap();
    assert_eq!(trigger.sequence, 61);
    assert_eq!(trigger.aim.tick, 100);
    assert_eq!(trigger.aim.pitch, -0.25);
    b[28..32].copy_from_slice(&1.6f32.to_le_bytes());
    assert!(decode_input(&b).is_none());
}
#[test]
fn crowded_snapshots_are_bounded_and_complete() {
    let mut w = World::new();
    for _ in 0..200 {
        w.spawn(Kind::Player, pos(0.));
    }
    let snapshots = encode_snapshots(12, 1, 7, &w.visible_to(1));
    assert_eq!(snapshots.len(), 7);
    let mut ids = vec![];
    for (part, b) in snapshots.iter().enumerate() {
        assert!(b.len() <= MAX_PACKET);
        assert_eq!(
            u16::from_le_bytes(b[16..18].try_into().unwrap()) as usize,
            part
        );
        assert_eq!(u16::from_le_bytes(b[18..20].try_into().unwrap()), 7);
        for e in b[HEADER..].chunks_exact(ENTITY_BYTES) {
            ids.push(u32::from_le_bytes(e[..4].try_into().unwrap()));
        }
    }
    assert_eq!(ids, (1..=200).collect::<Vec<_>>());
    assert_eq!(encode_snapshots(1, 1, 1, &[])[0].len(), HEADER);
}

#[test]
fn overcrowded_interest_keeps_local_player_and_bounds_metadata() {
    let mut w = World::new();
    for _ in 0..600 {
        w.spawn(Kind::Player, pos(0.));
    }
    let visible = w.visible_to(600);
    assert_eq!(visible.len(), zone_server::world::MAX_VISIBLE_ENTITIES);
    assert!(visible.iter().any(|e| e.id == 600));
    assert!(visible.windows(2).all(|a| a[0].id < a[1].id));
}
