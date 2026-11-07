import { createServer } from "node:http";
import { stat } from "node:fs/promises";
process.env.XRAY_WORKSPACE = process.argv[2] || process.cwd();
createServer(async (req, res) => {
  const headers = {
    "Access-Control-Allow-Origin": "http://localhost:8081",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers).end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/compile") {
    res.writeHead(404, headers).end();
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const b of req) {
      size += b.length;
      if (size > 4 << 20) throw Error("Shader request too large");
      chunks.push(b);
    }
    const { compile } = await import(
      "./compiler.mjs?mtime=" +
        (await stat(new URL("./compiler.mjs", import.meta.url))).mtimeMs
    );
    const result = await compile(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, headers).end(JSON.stringify(result));
  } catch (e) {
    console.error(e.stderr || e.message);
    res
      .writeHead(422, headers)
      .end(JSON.stringify({ error: e.stderr || e.message }));
  }
}).listen(8093, "127.0.0.1", () =>
  console.log("Local shader compiler: http://localhost:8093"),
);
