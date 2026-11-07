import createShaderc from './compiler-wasm/shaderc.mjs';

export async function createWasmToolchain({shadercOptions, nagaBytes} = {}) {
  const shaderc = await createShaderc(shadercOptions);
  const bytes = nagaBytes || await (await fetch(new URL('./compiler-wasm/naga.wasm', import.meta.url))).arrayBuffer();
  const {instance} = await WebAssembly.instantiate(bytes, {});
  const naga = instance.exports;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  function run(source, stage, preprocess) {
    const input = encoder.encode(source + '\0');
    const ptr = shaderc._malloc(input.length);
    try {
      shaderc.HEAPU8.set(input, ptr);
      if (shaderc._compile_shader(ptr, stage === 'frag' ? 1 : 0, preprocess ? 1 : 0))
        throw Error(shaderc.UTF8ToString(shaderc._result_error()));
      return shaderc.HEAPU8.slice(shaderc._result_bytes(), shaderc._result_bytes() + shaderc._result_length());
    } finally { shaderc._free(ptr); }
  }
  return {
    preprocess(source, stage) { return decoder.decode(run(source, stage, true)); },
    translate(source, stage) {
      const spv = run(source, stage, false);
      const ptr = naga.allocate(spv.length);
      try {
        new Uint8Array(naga.memory.buffer, ptr, spv.length).set(spv);
        const status = naga.translate(ptr, spv.length);
        const output = decoder.decode(new Uint8Array(naga.memory.buffer, naga.output_ptr(), naga.output_len()));
        if (status) throw Error('Naga: ' + output);
        return output;
      } finally { naga.release(ptr, spv.length); }
    }
  };
}
