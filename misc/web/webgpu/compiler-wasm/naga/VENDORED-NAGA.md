# Pinned gather and sample-mask support

`vendor/naga` is the crates.io Naga 26.0.0 source (upstream commit `03f1b535ca2356d4d490540e76480b0116cf7d7f`), with a small SPIR-V frontend extension in `src/front/spv/mod.rs` and `image.rs`. The source is vendored so browser-side compilation is reproducible without patching a user's Cargo registry.

The extension maps `OpImageGather` (constant component 0–3) and `OpImageDrefGather` to Naga's existing `ImageSample.gather` representation. Gather uses level zero and retains constant offsets. Depth gather returns four values directly, without the scalar-depth splat used for ordinary samples. Dynamic offsets and `ImageGatherExtended` remain rejected; the game uses literal offsets.

Build the translator with `cargo build --manifest-path misc/web/webgpu/compiler-wasm/naga/Cargo.toml --target wasm32-unknown-unknown --release --locked`, then copy the resulting `xray_shader_translator.wasm` to `compiler-wasm/naga.wasm`. The full sidecar `build.sh` performs both steps as well.

`node --test misc/web/webgpu/compiler-gather.test.mjs` exercises the actual shipped shaderc/Naga WASM pair, including all four sampled components, comparison gathers and rejection of dynamic offsets. Offline `compiler.mjs` deliberately uses the same pair as runtime compilation.

The frontend also bridges SPIR-V’s signed one-element `SampleMask` output array to WGSL’s unsigned scalar builtin. The private array and its all-covered initializer are retained for translated shader instructions; the entry-point wrapper loads element zero and bitcasts it to `u32`. This is needed by original high-quality alpha-tested geometry shaders. The compiler test and `multisample-gpu.mjs` verify the translation and actual two-of-four coverage readback.
