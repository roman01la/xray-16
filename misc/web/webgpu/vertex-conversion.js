// Perform EngineFormat's unnormalized integer-to-float vertex conversion in the vertex
// shader, retaining the original compact buffers and eliminating CPU expansion.
export function specializeVertex(source, conversions) {
  const start = source.indexOf("fn main("),
    body = source.indexOf("{", start);
  let signature = source.slice(start, body),
    code = source.slice(body);
  for (const { location, scalar } of conversions) {
    const pattern = new RegExp(
      "(@location\\(" + location + "\\)\\s+)(\\w+)(:\\s*)(vec[234]<f32>|f32)",
    );
    const match = signature.match(pattern);
    if (!match) throw Error("No float vertex input at location " + location);
    signature = signature.replace(
      pattern,
      (_, annotation, name, colon, type) =>
        annotation + name + colon + type.replace("f32", scalar),
    );
    code = code.replace(
      new RegExp("\\b" + match[2] + "\\b", "g"),
      `${match[4]}(${match[2]})`,
    );
  }
  return source.slice(0, start) + signature + code;
}
