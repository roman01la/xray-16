#!/usr/bin/env bash
set -euo pipefail
sidecar_dir="$(cd "$(dirname "$0")" && pwd)"
workspace_dir="$(cd "$sidecar_dir/../../../../.." && pwd)"
cd "$workspace_dir"
if [ ! -d .tools/shaderc-src ]; then
  git clone https://github.com/google/shaderc.git .tools/shaderc-src
  git -C .tools/shaderc-src checkout 301b4ede53d59b68bf55f95bb26412d9233c8187
fi
test "$(git -C .tools/shaderc-src rev-parse HEAD)" = 301b4ede53d59b68bf55f95bb26412d9233c8187
(cd .tools/shaderc-src && python3 utils/git-sync-deps)
source .tools/emsdk/emsdk_env.sh
# shaderc 2026.1 uses an unevaluated generator expression for glslang's
# install switch. Enable exports consistently; no install target is executed.
emcmake cmake -S .tools/shaderc-src -B .tools/shaderc-wasm -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON \
  -DSHADERC_SKIP_EXECUTABLES=ON -DSHADERC_SKIP_INSTALL=OFF \
  -DSHADERC_ENABLE_WERROR_COMPILE=OFF -DSPIRV_SKIP_TESTS=ON \
  -DENABLE_GLSLANG_BINARIES=OFF -DENABLE_HLSL=ON \
  -DCMAKE_CXX_FLAGS=-fexceptions -DCMAKE_C_FLAGS=-fexceptions
cmake --build .tools/shaderc-wasm --target shaderc_combined -j 8
em++ -O3 -fexceptions "$sidecar_dir/shaderc-wrapper.cpp" \
  -I .tools/shaderc-src/libshaderc/include .tools/shaderc-wasm/libshaderc/libshaderc_combined.a \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=1073741824 \
  -sSTACK_SIZE=1048576 -sDISABLE_EXCEPTION_CATCHING=0 \
  '-sEXPORTED_FUNCTIONS=["_malloc","_free"]' '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPU8"]' \
  -o "$sidecar_dir/shaderc.mjs"
cargo build --manifest-path "$sidecar_dir/naga/Cargo.toml" --target wasm32-unknown-unknown --release --locked
cp "$sidecar_dir/naga/target/wasm32-unknown-unknown/release/xray_shader_translator.wasm" "$sidecar_dir/naga.wasm"
python3 - "$sidecar_dir" <<'PY'
import pathlib,sys
dest=pathlib.Path(sys.argv[1])
files=list((dest/'naga/vendor/naga').glob('LICENSE*'))
files += [pathlib.Path('.tools/shaderc-src/LICENSE'),pathlib.Path('.tools/shaderc-src/third_party/LICENSE.glslang'),pathlib.Path('.tools/shaderc-src/third_party/LICENSE.spirv-tools')]
files+=list(pathlib.Path('.tools/shaderc-src/third_party/spirv-headers').glob('LICENSE*'))
registry=pathlib.Path.home()/'.cargo/registry/src'
import tomllib
lock=tomllib.loads((dest/'naga/Cargo.lock').read_text())
for package in lock['package']:
    if 'source' not in package: continue
    for source in registry.glob('*/'+package['name']+'-'+package['version']):
        files+=list(source.glob('LICENSE*'))+list(source.glob('COPYING*'))
(dest/'LICENSES.txt').write_text('\n\n'.join('=== '+str(p)+' ===\n'+p.read_text(errors='replace') for p in files if p.is_file()))
PY
