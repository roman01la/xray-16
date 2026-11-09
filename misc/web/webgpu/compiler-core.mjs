import { packUniforms } from "./pack-uniforms.mjs";
import { reflectProgram, shaderValueType } from "./reflection.mjs";
import { shaderKey } from "./shader-key.js";

function prepare(source, stage, attributes, varyings, uniforms, samplers) {
  let s = source.replace(/^#version[^\n]*/m, "#version 450");
  s = s.replace(/^\s*precision\s+\w+\s+\w+\s*;/gm, "");
  s = s.replace(/\b(lowp|mediump|highp)\s+/g, "");
  s = s.replace(/\buniform\s+(\w+)\s+(\w+)\s*(\[[^\]]+\])?\s*;/g, "");
  s = s.replace(
    /^(\s*)(in|out)\s+(\w+)\s+(\w+)\s*;/gm,
    (all, space, dir, type, name) => {
      if (name.startsWith("gl_")) return all;
      const loc =
        stage === "vert" && dir === "in"
          ? attributes[name]
          : stage === "frag" && dir === "out"
            ? Number(name.match(/\d+$/)?.[0] || 0)
            : varyings[name];
      return `${space}layout(location=${loc ?? 0}) ${dir} ${type} ${name};`;
    },
  );
  const block = uniforms.length
    ? "layout(std140,set=0,binding=0) uniform XrayUniforms {\n" +
      uniforms
        .map(
          (u) =>
            `layout(offset=${u.offset}) ${u.type} ${u.name}${u.count > 1 ? "[" + u.count + "]" : ""};`,
        )
        .join("\n") +
      "\n};\n"
    : "";
  const textures = samplers
    .map((u, i) => {
      const type = u.type.replace("sampler", "texture").replace("Shadow", "");
      return `layout(set=0,binding=${1 + i * 2}) uniform ${type} ${u.name}_texture;\nlayout(set=0,binding=${2 + i * 2}) uniform ${u.type.includes("Shadow") ? "samplerShadow" : "sampler"} ${u.name}_sampler;\n#define ${u.name} ${u.type}(${u.name}_texture,${u.name}_sampler)`;
    })
    .join("\n");
  s = s.replace(/^#version[^\n]*\n/, `#version 450\n${block}${textures}\n`);
  if (stage === "vert") {
    s = s.replace(/\bvoid\s+main\s*\(/, "void xray_main(");
    s +=
      "\nvoid main(){ xray_main(); gl_Position.y=-gl_Position.y; gl_Position.z=(gl_Position.z+gl_Position.w)*0.5; }\n";
  }
  return s;
}
function arrayCount(expression) {
  const tokens = expression.match(/\d+|[()+*\/-]/g) || [];
  let pos = 0;
  function atom() {
    const t = tokens[pos++];
    if (t === "(") {
      const n = sum();
      if (tokens[pos++] !== ")") throw Error("Invalid array size");
      return n;
    }
    if (!/^\d+$/.test(t)) throw Error("Invalid array size");
    return Number(t);
  }
  function mul() {
    let n = atom();
    while (["*", "/"].includes(tokens[pos])) {
      const op = tokens[pos++];
      const b = atom();
      n = op === "*" ? n * b : n / b;
    }
    return n;
  }
  function sum() {
    let n = mul();
    while (["+", "-"].includes(tokens[pos])) {
      const op = tokens[pos++];
      const b = mul();
      n = op === "+" ? n + b : n - b;
    }
    return n;
  }
  const n = sum();
  if (pos !== tokens.length || !Number.isInteger(n) || n < 1 || n > 16384)
    throw Error("Unsupported uniform array size");
  return n;
}
function applyOptionalQualityDefaults(source, error) {
  // A #line directive would make shaderc's location ambiguous.
  if (/^\s*#\s*line\b/m.test(source)) throw error;
  const diagnostics = String(error.message).split("\n").filter(line => line.includes(": error:"));
  const optionalQuality = /:(\d+):\s*error:.*undefined macro in expression not allowed in es profile (SUN_QUALITY|SSAO_QUALITY)\s*$/;
  if (!diagnostics.length) throw error;
  const lines = source.split("\n"), defaults = new Map();
  for (const diagnostic of diagnostics) {
    const match = diagnostic.match(optionalQuality);
    if (!match) throw error;
    const index = Number(match[1]) - 1;
    if (!defaults.has(index)) defaults.set(index,new Set());
    defaults.get(index).add(match[2]);
  }
  for (const [index,names] of defaults) {
    const line = lines[index];
    if (!/^\s*#\s*(?:if|elif)\b/.test(line)) throw error;
    // CoP treats the disabled quality option as zero in numeric tests while
    // keeping it undefined for feature tests. Keep the original ES profile.
    const words = /\bdefined(?:\s*\(\s*\w+\s*\)|\s+\w+)|\b\w+\b/g;
    lines[index] = line.replace(words, word => names.has(word) ? "0" : word);
    if (lines[index] === line) throw error;
  }
  return lines.join("\n");
}

async function preprocess(source, stage, toolchain) {
  let es = source.replace("#version 300 es", "#version 310 es");
  for (;;) {
    try {
      return await toolchain.preprocess(es, stage);
    } catch (error) {
      // Every successful retry removes at least one diagnosed identifier.
      es = applyOptionalQualityDefaults(es, error);
    }
  }
}
// Shared by offline native and browser WASM toolchains. Same key and output schema.
export async function compileProgram(request, toolchain) {
  const key = shaderKey(request);
  const attrs = Object.fromEntries(
    request.attributes.map((a) => [a.name, a.location]),
  );
  const sources = {};
  for (const [stage, src] of Object.entries(request.sources)) {
    sources[stage] = (await preprocess(src, stage, toolchain)).replace(/\buniform\s+(\w+)\s+([^;{}]+);/g, (all, type, names) =>
      names
        .split(",")
        .map((name) => `uniform ${type} ${name.trim()};`)
        .join("\n"),
    );
  }
  const reflectedAttributes = [];
  for (const m of sources.vert.matchAll(
    /(?:layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*)?\bin\s+(\w+)\s+(\w+)\s*;/g,
  )) {
    const location =
      m[1] !== undefined
        ? Number(m[1])
        : (attrs[m[3]] ?? reflectedAttributes.length);
    attrs[m[3]] = location;
    reflectedAttributes.push({
      name: m[3],
      location,
      type: shaderValueType(m[2]),
      size: 1,
    });
  }
  const varyNames = new Set();
  for (const [stage, s] of Object.entries(sources))
    for (const m of s.matchAll(/^\s*(in|out)\s+\w+\s+(\w+)\s*;/gm))
      if (
        (stage === "vert" && m[1] === "out") ||
        (stage === "frag" && m[1] === "in")
      )
        varyNames.add(m[2]);
  const varyings = Object.fromEntries(
    [...varyNames].sort().map((n, i) => [n, i]),
  );
  const declarations = new Map();
  for (const s of Object.values(sources))
    for (const m of s.matchAll(
      /\buniform\s+(\w+)\s+(\w+)\s*(?:\[\s*([\d\s+*\-/()]+)\s*\])?\s*;/g,
    ))
      declarations.set(m[2], {
        type: m[1],
        name: m[2],
        count: arrayCount(m[3] || "1"),
      });
  const uniforms = [],
    samplers = [];
  let offset = 0;
  for (const u of declarations.values()) {
    if (u.type.includes("sampler")) {
      samplers.push(u);
      continue;
    }
    const matrix = u.type.match(/^mat(\d)(?:x(\d))?$/);
    u.columns = matrix ? Number(matrix[1]) : 1;
    u.rows = matrix
      ? Number(matrix[2] || matrix[1])
      : Number(u.type.match(/vec(\d)/)?.[1] || 1);
    u.offset = offset;
    u.stride = u.columns * 16;
    offset += u.stride * u.count;
    uniforms.push(u);
  }
  const result = {
    uniforms,
    samplers,
    uniformBytes: Math.max(16, offset),
    stages: {},
    key,
  };
  for (const [stage, src] of Object.entries(sources)) {
    result.stages[stage] = await toolchain.translate(
      prepare(src, stage, attrs, varyings, uniforms, samplers), stage);
  }
  result.activeBindings = [
    ...new Set(
      Object.values(result.stages).flatMap((s) =>
        [...s.matchAll(/@binding\((\d+)\)/g)].map((m) => Number(m[1])),
      ),
    ),
  ];
  reflectProgram(result, reflectedAttributes);
  packUniforms(result);
  return result;
}
