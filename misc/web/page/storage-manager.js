import { importSaveBackup, openSaveDirectory, prepareSaveBackup } from "./save-format.js";
const toolbar = document.getElementById("toolbar");
const button = document.createElement("button");
button.textContent = "Saves";
toolbar.append(button);
const dialog = document.createElement("dialog");
dialog.innerHTML = `<h2>Saved games</h2><p>Saves stay in this browser. Download a backup before clearing site data or changing websites.</p><p id="save-storage"></p><button id="backup-saves">Prepare backup</button> <a id="save-download" hidden>Download backup file</a> <button id="restore-saves">Import backup</button> <button id="persist-saves">Keep browser storage</button><input id="save-file" type="file" accept=".json" hidden><p id="save-message" role="status"></p><button id="close-saves">Close</button>`;
document.body.append(dialog);
const $ = (id) => dialog.querySelector("#" + id);
const report = (text) => ($("save-message").textContent = text);
const saveDirectory = (create = false) => openSaveDirectory(document.getElementById("game").value, create);
async function storageStatus() {
  const { usage, quota } = await navigator.storage.estimate();
  const persistent = await navigator.storage.persisted();
  $("save-storage").textContent =
    `Storage: ${(usage / 2 ** 30).toFixed(1)} GB of ${(quota / 2 ** 30).toFixed(1)} GB; ${persistent ? "persistent" : "browser may reclaim it under storage pressure"}.`;
}
button.onclick = () => {
  dialog.showModal();
  storageStatus().catch((e) => report(e.message));
};
$("close-saves").onclick = () => dialog.close();
$("persist-saves").onclick = async () => {
  try {
    const granted = await navigator.storage.persist();
    report(
      granted
        ? "Persistent storage enabled."
        : "Browser did not grant persistence. Keep a downloaded backup.",
    );
    await storageStatus();
  } catch (e) {
    report(e.message);
  }
};
$("backup-saves").onclick = async () => {
  try {
    const backup = await prepareSaveBackup(await saveDirectory());
    const url = URL.createObjectURL(backup.blob);
    const link = $("save-download");
    if (link.href.startsWith("blob:")) URL.revokeObjectURL(link.href);
    link.href = url;
    link.download = backup.filename;
    link.hidden = false;
    report(
      `Backup ready: ${backup.count} save files. Select Download backup file.`,
    );
  } catch (e) {
    report(e.message);
  }
};
$("restore-saves").onclick = () => {
  if (document.getElementById("game").disabled) {
    report(
      "Import before starting the game. Open this page with ?autostart=0, then select Import backup.",
    );
    return;
  }
  $("save-file").click();
};
$("save-file").onchange = async () => {
  try {
    const file = $("save-file").files[0];
    if (!file) return;
    const { imported, skipped } = await importSaveBackup(document.getElementById("game").value, file);
    report(`Imported saves: ${imported}. Existing saves kept: ${skipped}. Launch the game and use Load game.`);
  } catch (e) {
    report("Import failed: " + e.message);
  } finally {
    $("save-file").value = "";
  }
};
