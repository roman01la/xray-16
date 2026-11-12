// The browser engine now requires the native WebGPU worker runtime.
if (!globalThis.XRAY_WEBGPU) {
  const nativeURL = new URL("./webgpu/", location.href);
  nativeURL.search = location.search;
  nativeURL.hash = location.hash;
  location.replace(nativeURL.href);
  await new Promise(() => {});
}

import "./storage-manager.js";
import { acquireSaveSession } from "./save-format.js";
let releaseSaveSession;
window.addEventListener("pagehide", () => { releaseSaveSession?.(); releaseSaveSession = undefined; });
window.addEventListener("pageshow", event => { if(event.persisted)location.reload(); });
const streamURL = new URLSearchParams(location.search).get("stream");
// The staged page identifies the title; never infer it from a save name.
const gameId = document.documentElement.dataset.game === "soc" ? "soc" : "cop";
const streamRoot = `stream-${gameId}`;
const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const logEl = $("log");

const pending = [];
let flushScheduled = false;
function print(line) {
  if(line.startsWith('XRAY_STREAM_PROGRESS ')){
    try{window.dispatchEvent(new CustomEvent('xray-stream-progress',{detail:JSON.parse(line.slice(21))}));}catch{}
    return;
  }
  window.dispatchEvent(new CustomEvent('xray-engine-log',{detail:line}));
  pending.push(line);
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    logEl.textContent += pending.join("\n") + "\n";
    pending.length = 0;
    flushScheduled = false;
    if (logEl.textContent.length > 400000)
      logEl.textContent = logEl.textContent.slice(-200000);
    logEl.scrollTop = logEl.scrollHeight;
  }, 50);
}

window.addEventListener('xray-stream-progress',({detail:progress})=>{
  if(progress.phase!=='install')return;
  const meter=$("progress");
  meter.hidden=!!(progress.ready||progress.error);
  if(progress.packBytes){
    meter.max=progress.packBytes;
    meter.value=progress.checkedBytes;
    const gb=bytes=>(bytes/1e9).toFixed(2);
    $("ingest-status").textContent=`Preparing game data (${gb(progress.checkedBytes)} / ${gb(progress.packBytes)} GB ready)`;
  }else if(!meter.hidden){
    meter.removeAttribute("value");
    $("ingest-status").textContent="Reading the game manifest…";
  }
});

print(`crossOriginIsolated=${crossOriginIsolated}`);
if (location.protocol === "file:")
  print(
    "WARNING: open this page over http://localhost, not file:// (the ingest worker and SharedArrayBuffer are blocked)",
  );
else if (!crossOriginIsolated)
  print(
    "WARNING: page is not cross-origin isolated; serve it with web/serve.mjs so COOP/COEP are set, or threads will fail",
  );

const worker = new Worker("./ingest-worker.js", { type: "module" });
const requests = new Map();
let nextRequestId = 0;

worker.addEventListener("message", (e) => {
  if(e.data.type==='engine-progress'){
    window.dispatchEvent(new CustomEvent('xray-engine-progress',{detail:e.data}));return;
  }
  if(e.data.type==='stream-progress'){
    window.dispatchEvent(new CustomEvent('xray-stream-progress',{detail:e.data.detail}));return;
  }
  if (e.data.type === "progress") {
    $("progress").hidden = false;
    $("progress").value = e.data.done / e.data.total;
    $("ingest-status").textContent =
      `${e.data.file} (${(e.data.done / 1e9).toFixed(2)} / ${(e.data.total / 1e9).toFixed(2)} GB)`;
    return;
  }
  const request = requests.get(e.data.id);
  if (!request) return;
  requests.delete(e.data.id);
  if (e.data.type === "error") request.reject(new Error(e.data.error));
  else request.resolve(e.data);
});

function failRequests(reason) {
  for (const request of requests.values()) request.reject(new Error(reason));
  requests.clear();
}
worker.addEventListener("error", (e) =>
  failRequests(`ingest worker failed: ${e.message || "script did not load"}`),
);
worker.addEventListener("messageerror", () =>
  failRequests("ingest worker sent an unreadable message"),
);

function askWorker(message, timeoutMs) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    worker.postMessage({ ...message, id });
    if (!timeoutMs) return;
    setTimeout(() => {
      if (!requests.delete(id)) return;
      reject(
        new Error(
          `ingest worker did not answer '${message.type}' within ${timeoutMs / 1000}s`,
        ),
      );
    }, timeoutMs);
  });
}

async function refreshState(select) {
  try {
    const { roots } = await askWorker({ type: "status" }, 15000);
    if (streamURL && !roots.includes(streamRoot)) roots.push(streamRoot);
    const picker = $("game");
    picker.replaceChildren(...roots.map((root) => new Option(root, root)));
    picker.hidden = roots.length === 0;
    if (select && roots.includes(select)) picker.value = select;
    else if (streamURL) picker.value = streamRoot;
    $("ingest-status").textContent = roots.length
      ? `${roots.length} game${roots.length > 1 ? "s" : ""} in OPFS`
      : 'no game ingested yet; press "Add game folder"';
    $("launch").disabled = roots.length === 0;
    if (!roots.length) document.documentElement.classList.remove("game-only");
    return roots.length > 0;
  } catch (e) {
    $("ingest-status").textContent = "OPFS unavailable: " + e.message;
    print("OPFS unavailable: " + e.message);
  }
}

$("pick").onclick = async () => {
  let root;
  try {
    if (!window.showDirectoryPicker)
      throw new Error("this browser has no File System Access API; use Chrome");
    const dir = await window.showDirectoryPicker({
      id: "stalker",
      mode: "read",
    });
    root =
      dir.name
        .toLowerCase()
        .replace(/[^a-z0-9._]+/g, "-")
        .replace(/^-|-$/g, "") || "game";
    $("pick").disabled = true;
    $("ingest-status").textContent = `scanning ${dir.name}...`;
    await askWorker({ type: "ingest", dir, root });
    $("progress").hidden = true;
    print(`ingestion complete: ${root}`);
  } catch (e) {
    print("ingestion failed: " + e.message);
  } finally {
    $("pick").disabled = false;
    await refreshState(root);
  }
};

$("launch").onclick = async () => {
  const root = $("game").value;
  try {
    if (!crossOriginIsolated)
      throw Error(
        "This page needs cross-origin isolation headers. Reload from the supported host.",
      );
    if (globalThis.XRAY_WEBGPU) {
      if (!navigator.gpu)
        throw Error(
          "WebGPU is unavailable. Use a supported desktop browser with hardware acceleration.",
        );
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw Error("No WebGPU adapter available.");
      for (const feature of [
        "texture-compression-bc",
        "texture-compression-bc-sliced-3d",
      ])
        if (!adapter.features.has(feature))
          throw Error("Your GPU/browser lacks required support: " + feature);
    }
  } catch (e) {
    $("status").textContent = e.message;
    return;
  }
  $("launch").disabled = true;
  $("pick").disabled = true;
  $("game").disabled = true;
  $("ingest-status").textContent = "syncing engine data...";
  let streaming, saveTimes;
  try {
    releaseSaveSession ??= await acquireSaveSession(root);
    const pack = streamURL && root === streamRoot ? new URL(streamURL, location.href).href : undefined;
    ({ streaming, saveTimes } = await askWorker({ type: "sync-engine-data", root, pack, includeSaveTimes: true }));
  } catch (e) {
    releaseSaveSession?.(); releaseSaveSession = undefined;
    $("ingest-status").textContent = "engine data sync failed: " + e.message;
    print("engine data sync failed: " + e.message);
    $("launch").disabled = false;
    $("pick").disabled = false;
    $("game").disabled = false;
    return;
  }
  $("ingest-status").textContent = "running " + root;

  const args = [
    "-nosplash",
    "-nointro",
    "-nogameintro",
    "-fsltx",
    streaming?.config ?? `/opfs/${root}/fsgame.ltx`,
  ];
  if (streaming) args.push("-stream_mount", streaming.mount);
  if (gameId === "soc") args.push("-soc");
  args.push(...$("extra-args").value.split(/\s+/).filter(Boolean));
  print("launching: " + args.join(" "));

  canvas.width = 1280;
  canvas.height = 720;

  try {
    const { default: createModule } = await import("./xr_3da.js");
    const printArgs = (...parts) => print(parts.join(" "));
    await createModule({
      canvas,
      arguments: args,
      xraySaveTimes: saveTimes,
      print: printArgs,
      printErr: printArgs,
    });
    canvas.focus();

    $("status").textContent = "engine running";
  } catch (e) {
    window.dispatchEvent(new CustomEvent("xray-crash", {
      detail: {kind: "launch", message: e.message, stack: e.stack},
    }));
    $("status").textContent =
      "Launch failed: " + e.message + ". Use Restart to retry.";
    print(e.stack || e.message);
  }
};

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("click", () => {
  canvas.focus();
  if (document.pointerLockElement !== canvas)
    canvas
      .requestPointerLock()
      ?.catch((e) =>
        print("Click the game to capture the mouse: " + e.message),
      );
});
document.addEventListener("pointerlockchange", () => {
  canvas.style.cursor =
    document.pointerLockElement === canvas ? "none" : "default";
});

// Existing OPFS data is ready to use without reopening the folder picker.
refreshState()
  .then(async (hasGame) => {
    if (
      hasGame &&
      new URLSearchParams(location.search).get("autostart") !== "0"
    )
      await $("launch").onclick();
  })
  .catch((error) => {
    $("status").textContent = "Launch failed; reload to retry";
    print("launch failed: " + error.message);
  });

window.saveFromOpfs = async (path, name) => {
  let dir = await navigator.storage.getDirectory();
  const parts = path.split("/");
  const file = parts.pop();
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  const blob = await (await dir.getFileHandle(file)).getFile();
  await fetch("/save/" + (name ?? file), { method: "POST", body: blob });
  return `${file}: ${blob.size} bytes`;
};

$("restart").onclick = () => location.reload();
