//! The browser predictor compiles the exact server geometry and motor sources.
//! This small owned-memory ABI keeps JS/engine heaps separate from Rust state.
#[path = "../../src/collision.rs"]
pub mod collision;
#[path = "../../src/ladder.rs"]
pub mod ladder;
#[path = "../../src/materials.rs"]
pub mod materials;
#[path = "../../src/movement.rs"]
pub mod movement;
use parry3d::math::Vector;
use std::cell::RefCell;
thread_local! { static STATE:RefCell<Option<(collision::CollisionMap,movement::Character)>>=const{RefCell::new(None)}; }
#[unsafe(no_mangle)]
pub extern "C" fn zone_version() -> u32 {
    6
}
#[unsafe(no_mangle)]
pub extern "C" fn zone_alloc(size: usize) -> *mut u8 {
    if size == 0 || size > 256 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0u8; size].into_boxed_slice()) as *mut u8
}
/// # Safety
/// Pointer and length must describe a live allocation returned by zone_alloc.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zone_free(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, size)));
        }
    }
}
/// # Safety
/// Each buffer must be a valid zone_alloc allocation of the supplied length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zone_load(
    m: *const u8,
    ml: usize,
    g: *const u8,
    gl: usize,
    a: *const u8,
    al: usize,
) -> u32 {
    STATE.with(|s| *s.borrow_mut() = None);
    if m.is_null()
        || g.is_null()
        || a.is_null()
        || ml > 32 * 1024
        || gl > 256 * 1024 * 1024
        || al > 4 * 1024 * 1024
    {
        return 0;
    }
    let result = (|| -> anyhow::Result<_> {
        let manifest = serde_json::from_slice(unsafe { std::slice::from_raw_parts(m, ml) })?;
        let mut map = collision::CollisionMap::from_bytes(manifest, unsafe {
            std::slice::from_raw_parts(g, gl)
        })?;
        map.attach_materials(unsafe { std::slice::from_raw_parts(a, al) })?;
        Ok(map)
    })();
    match result {
        Ok(map) => {
            STATE.with(|s| *s.borrow_mut() = Some((map, movement::Character::new(Vector::ZERO))));
            1
        }
        Err(_) => 0,
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn zone_reset(x: f32, y: f32, z: f32, vertical_speed: f32, flags: u32) -> u32 {
    if ![x, y, z, vertical_speed].iter().all(|v| v.is_finite()) || flags & !30 != 0 {
        return 0;
    }
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some((_, c)) = s.as_mut() else {
            return 0;
        };
        *c = movement::Character {
            feet: Vector::new(x, y, z),
            vertical_speed,
            grounded: flags & 2 != 0,
            crouched: flags & 4 != 0,
            jump_held: flags & 8 != 0,
            climbing: flags & 16 != 0,
        };
        1
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn zone_step(x: f32, z: f32, sprint: u32, jump: u32, crouch: u32, walk: u32) -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some((map, c)) = s.as_mut() else {
            return 0;
        };
        u32::from(
            c.step_command(map, x, z, sprint != 0, jump != 0, crouch != 0, walk != 0)
                .is_ok(),
        )
    })
}
/// # Safety
/// out must point to at least 32 writable bytes from zone_alloc.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zone_state(out: *mut f32) -> u32 {
    if out.is_null() {
        return 0;
    }
    STATE.with(|s| {
        let s = s.borrow();
        let Some((_, c)) = s.as_ref() else {
            return 0;
        };
        let v = [
            c.feet.x,
            c.feet.y,
            c.feet.z,
            c.vertical_speed,
            u32::from(c.grounded) as f32,
            u32::from(c.crouched) as f32,
            u32::from(c.jump_held) as f32,
            u32::from(c.climbing) as f32,
        ];
        unsafe { std::ptr::copy_nonoverlapping(v.as_ptr(), out, v.len()) };
        1
    })
}
