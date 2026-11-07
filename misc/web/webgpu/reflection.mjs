import { EngineFormat } from "./engine-formats.js";

export function activeBindings(source) {
  return [
    ...source.matchAll(/@binding\((\d+)\)\s+var(?:<[^>]+>)?\s+(\w+)\s*:/g),
  ]
    .filter((m) => source.split(new RegExp("\\b" + m[2] + "\\b")).length > 2)
    .map((m) => Number(m[1]));
}

export function entryIO(source) {
  const entry = source.match(/fn main\(([^\n]*)\)\s*(?:->\s*([^\{]+))?\{/);
  if (!entry) throw Error("Missing WGSL entry point");
  const locations = (text) =>
    [
      ...text.matchAll(
        /@location\((\d+)\)\s*(?:\w+\s*:\s*)?([^,\n]+(?:<[^>]+>)?)/g,
      ),
    ].map((m) => Number(m[1]));
  const type = entry[2]?.trim() || "";
  const output = type.startsWith("@")
    ? type
    : source.match(new RegExp("struct " + type + " \\{([\\s\\S]*?)\\}"))?.[1] ||
      "";
  return { inputs: locations(entry[1]), outputs: locations(output) };
}

export function usedUniforms(source, uniforms) {
  const global = source.match(/@binding\(0\)\s+var<uniform>\s+(\w+):\s*(\w+);/);
  if (!global) return [];
  const structure =
    source.match(
      new RegExp("struct " + global[2] + " \\{([\\s\\S]*?)\\}"),
    )?.[1] || "";
  const fields = [...structure.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
  return uniforms.filter((u, i) =>
    new RegExp("\\b" + global[1] + "\\." + fields[i] + "\\b").test(source),
  );
}

export function shaderValueType(type) {
  const simple = {
    float: "FLOAT",
    int: "INT",
    uint: "UNSIGNED_INT",
    bool: "BOOL",
    sampler2D: "SAMPLER_2D",
    sampler3D: "SAMPLER_3D",
    samplerCube: "SAMPLER_CUBE",
    sampler2DShadow: "SAMPLER_2D_SHADOW",
    samplerCubeShadow: "SAMPLER_CUBE_SHADOW",
  };
  let name = simple[type];
  const vector = type.match(/^([biu]?)vec(\d)$/),
    matrix = type.match(/^mat(\d)(x\d)?$/);
  if (vector)
    name =
      { b: "BOOL", i: "INT", u: "UNSIGNED_INT", "": "FLOAT" }[vector[1]] +
      "_VEC" +
      vector[2];
  if (matrix) name = "FLOAT_MAT" + matrix[1] + (matrix[2] || "");
  if (EngineFormat[name] === undefined)
    throw Error("Unsupported reflected shader type " + type);
  return EngineFormat[name];
}

export function reflectProgram(result, attributes) {
  result.activeBindings = [
    ...new Set(Object.values(result.stages).flatMap(activeBindings)),
  ];
  const vertex = entryIO(result.stages.vert),
    fragment = entryIO(result.stages.frag);
  const missing = fragment.inputs.filter((n) => !vertex.outputs.includes(n));
  if (missing.length)
    throw Error("Fragment inputs have no vertex outputs: " + missing.join(","));
  result.attributes = attributes.filter((a) =>
    vertex.inputs.includes(a.location),
  );
  result.outputs = fragment.outputs;
  const used = new Set(
    Object.values(result.stages)
      .flatMap((s) => usedUniforms(s, result.uniforms))
      .map((u) => u.name),
  );
  result.activeUniforms = [
    ...result.uniforms.filter((u) => used.has(u.name)),
    ...result.samplers.filter((u, i) =>
      result.activeBindings.includes(1 + i * 2),
    ),
  ].map((u) => ({
    name: u.name + (u.count > 1 ? "[0]" : ""),
    size: u.count,
    type: shaderValueType(u.type),
  }));
  return result;
}
