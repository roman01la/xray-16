const compilerPanel = document.createElement("pre");
compilerPanel.id = "webgpu-compiler";
document.body.append(compilerPanel);
function showCompilerStatus(data) { compilerPanel.textContent = JSON.stringify(data); }
showCompilerStatus(globalThis.__xrayShaderCompilerStatus || {ready:false});
addEventListener('xray-shader-compiler-status', event => showCompilerStatus(event.detail));
const gpuStats = document.createElement("span");
gpuStats.id = "webgpu-stats";
document.getElementById("toolbar").append(gpuStats);
const profilePanel = document.createElement("pre");
profilePanel.id = "webgpu-profile";
document.body.append(profilePanel);
const subsystemPanel = document.createElement("pre");
subsystemPanel.id = "webgpu-subsystems";
document.body.append(subsystemPanel);
const profileSamples = [];
const profileHistory = document.createElement("pre");
profileHistory.id = "webgpu-profile-samples";
document.body.append(profileHistory);
const gpuErrors = new Set();
const gpuErrorPanel = document.createElement("pre");
gpuErrorPanel.id = "webgpu-errors";
gpuErrorPanel.style.whiteSpace = "pre-wrap";
document.body.append(gpuErrorPanel);
const gpuChannel = new BroadcastChannel("xray-webgpu");
gpuChannel.onmessage = ({ data }) => {
  if (data.nativeSelfTest) { nativeTestPanel.textContent = JSON.stringify(data.nativeSelfTest); return; }
  if (data.capture) {
    print(
      "WebGPU screenshot saved: " +
        data.capture.path +
        " (" +
        data.capture.bytes +
        " bytes)",
    );
    return;
  }
  if (data.benchmark) return;
  if (data.passBatchEnabled !== undefined) {
    passPanel.textContent = JSON.stringify({nativeOnly: data.nativeOnly, enabled: data.passBatchEnabled,
      bufferUploads: data.nativeBufferUploads, textureAllocations: data.nativeTextureAllocations,
      textureUploads: data.nativeTextureUploads, queries: data.nativeQueries, textureCopies: data.nativeTextureCopies,
      records: data.nativePassRecords, clears: data.nativeClears, presents: data.nativePresents,
      programs: data.nativeProgramSelections, vertexArrays: data.nativeVertexSelections});
  }
  if (data.bindingBatchEnabled !== undefined) {
    bindingPanel.textContent = JSON.stringify({enabled: data.bindingBatchEnabled,
      batches: data.bindingBatches, records: data.bindingRecords});
  }
  if (data.stateBatchEnabled !== undefined) {
    statePanel.textContent = JSON.stringify({enabled: data.stateBatchEnabled,
      batches: data.stateBatches, records: data.stateRecords});
  }
  if (data.preparedEnabled !== undefined) {
    preparedPanel.textContent = JSON.stringify({enabled: data.preparedEnabled,
      uniformBatches: data.uniformBatches, uniformRecords: data.uniformRecords,
      uniformBytesCopied: data.uniformBytesCopied, uniformReuses: data.uniformReuses,
      preparedHits: data.preparedHits, preparedMisses: data.preparedMisses, materialHits: data.materialHits});
  }
  if (data.directDrawsEnabled !== undefined) {
    submissionPanel.textContent = JSON.stringify({mode: "native",
      directDraws: data.directDraws});
  }
  if (data.subsystems) subsystemPanel.textContent = JSON.stringify(data.subsystems);
  if (data.debug) {
    gpuErrorPanel.textContent += "DEBUG " + data.debug + "\n";
    return;
  }
  if (data.status) {
    gpuStats.textContent = data.status;
    if (data.status.startsWith("GPU device lost"))
      document.getElementById("status").textContent =
        data.status + ". Restart to recover; unsaved progress is not restored.";
    return;
  }
  if (profiling && data.profile?.engineRenderMs > 0) {
    profilePanel.textContent = JSON.stringify(data.profile);
    profileSamples.push(data.profile);
    if (profileSamples.length > 10) profileSamples.shift();
    profileHistory.textContent = JSON.stringify(profileSamples);
  }
  gpuStats.textContent = `WebGPU: ${data.fps?.toFixed(1) ?? "—"} FPS, ${data.frames} frames, ${data.draws} draws, ${data.validationErrors} validation errors`;
  if (data.lastError && !gpuErrors.has(data.lastError)) {
    document.getElementById("status").textContent =
      "Rendering failed: " +
      data.lastError.split("\n")[0] +
      ". Use Restart to retry.";
    gpuErrors.add(data.lastError);
    if (gpuErrors.size <= 50)
      gpuErrorPanel.textContent +=
        "[WebGPU validation] " + data.lastError + "\n";
  }
};

const measure = document.createElement("button");
measure.textContent = "Benchmark 30 s";
document.getElementById("toolbar").append(measure);
const benchmarkResults = document.createElement("pre");
benchmarkResults.id = "webgpu-benchmark";
document.body.append(benchmarkResults);
measure.onclick = () => {
  measure.blur();
  profiling = false;
  profileToggle.textContent = "Profile CPU";
  phaseToggle.textContent = "Profile phases";
  measure.disabled = true;
  measure.textContent = "Measuring…";
  gpuChannel.postMessage({
    command: "benchmark",
    id: Date.now(),
    durationMs: 30000,
  });
};
gpuChannel.addEventListener("message", ({ data }) => {
  if (data.benchmark) {
    benchmarkResults.textContent = JSON.stringify(data.benchmark, null, 2);
    measure.disabled = false;
    measure.textContent = "Benchmark 30 s";
  }
});

const profileToggle = document.createElement("button");
profileToggle.textContent = "Profile CPU";
document.getElementById("toolbar").append(profileToggle);
let profiling = false;
profileToggle.onclick = () => {
  profileToggle.blur();
  profiling = profileToggle.textContent === "Profile CPU";
  phaseToggle.textContent = "Profile phases";
  profileSamples.length = 0;
  profileHistory.textContent = "";
  profileToggle.textContent = profiling ? "Stop profiling" : "Profile CPU";
  gpuChannel.postMessage({ command: "profile", enabled: profiling });
};

const phaseToggle = document.createElement("button");
phaseToggle.textContent = "Profile phases";
document.getElementById("toolbar").append(phaseToggle);
phaseToggle.onclick = () => {
  phaseToggle.blur();
  profiling = phaseToggle.textContent === "Profile phases";
  profileSamples.length = 0;
  profileHistory.textContent = "";
  profileToggle.textContent = "Profile CPU";
  phaseToggle.textContent = profiling ? "Stop phase profiling" : "Profile phases";
  gpuChannel.postMessage({ command: "profile", enabled: profiling, phasesOnly: true });
};

const submissionPanel = document.createElement("pre");
submissionPanel.id = "webgpu-submission";
document.body.append(submissionPanel);

const preparedPanel = document.createElement("pre");
preparedPanel.id = "webgpu-prepared";
document.body.append(preparedPanel);

const statePanel = document.createElement("pre");
statePanel.id = "webgpu-state-batches";
document.body.append(statePanel);

const bindingPanel = document.createElement("pre");
bindingPanel.id = "webgpu-binding-batches";
document.body.append(bindingPanel);

const passPanel = document.createElement("pre");
passPanel.id = "webgpu-native-passes";
document.body.append(passPanel);


const nativeTestPanel = document.createElement("pre");
nativeTestPanel.id = "webgpu-native-selftest";
document.body.append(nativeTestPanel);
const nativeTestButton = document.createElement("button");
nativeTestButton.textContent = "Validate native GPU";
document.getElementById("toolbar").append(nativeTestButton);
nativeTestButton.onclick = () => { nativeTestButton.blur(); nativeTestPanel.textContent = "Running GPU readback checks..."; gpuChannel.postMessage({command:"native-selftest"}); };
