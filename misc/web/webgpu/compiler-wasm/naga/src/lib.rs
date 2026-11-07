use naga::{back::wgsl, front::spv, valid::{Validator, ValidationFlags, Capabilities}};
use std::{cell::RefCell, slice};
thread_local! { static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) }; }

#[no_mangle]
pub extern "C" fn allocate(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}
#[no_mangle]
pub unsafe extern "C" fn release(ptr: *mut u8, len: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
}
#[no_mangle]
pub unsafe extern "C" fn translate(ptr: *const u8, len: usize) -> u32 {
    let result = (|| -> Result<String, String> {
        let module = spv::parse_u8_slice(slice::from_raw_parts(ptr, len), &spv::Options {
            adjust_coordinate_space: false, ..Default::default()
        }).map_err(|e| e.to_string())?;
        let info = Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&module).map_err(|e| e.to_string())?;
        wgsl::write_string(&module, &info, wgsl::WriterFlags::empty()).map_err(|e| e.to_string())
    })();
    let status = u32::from(result.is_err());
    OUTPUT.with(|out| *out.borrow_mut() = result.unwrap_or_else(|e| e).into_bytes());
    status
}
#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 { OUTPUT.with(|out| out.borrow().as_ptr()) }
#[no_mangle]
pub extern "C" fn output_len() -> usize { OUTPUT.with(|out| out.borrow().len()) }
