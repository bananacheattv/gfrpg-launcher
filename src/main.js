// GrandFantacube Launcher — processus principal Electron
// Manifeste distant (mis à jour à chaque push du mod) → Java (Mojang) → Minecraft + NeoForge → mods → auth Microsoft → lancement
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { Auth } = require("msmc");
const { Game, download, valid } = require("./game");

const BUNDLED = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "launcher-config.json"), "utf8"));
const ROOT = path.join(app.getPath("appData"), ".grandfantacube");        // dossier du jeu
const SETTINGS_FILE = path.join(ROOT, "launcher-settings.json");
const MANIFEST_CACHE = path.join(ROOT, "modpack-manifest.json");

let CONFIG = { ...BUNDLED };
let win = null;
let manifestReady = Promise.resolve();
let settings = { ram: 4, msToken: null, playerName: null };
const authManager = new Auth("select_account");

// ---------- utilitaires ----------
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) }; } catch {}
}
function saveSettings() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }
function progress(step, percent, label) { send("progress", { step, percent, label }); }

// ---------- manifeste du modpack (release "latest" du dépôt du mod) ----------
function applyManifest(m) {
  CONFIG = {
    ...BUNDLED,
    minecraftVersion: m.minecraft || BUNDLED.minecraftVersion,
    neoforgeVersion: m.neoforge || BUNDLED.neoforgeVersion,
    serverIp: m.serverIp || BUNDLED.serverIp,
    modpackVersion: m.version,
    mods: (m.mods || []).map(x => ({ name: x.name || x.file, filename: x.file, url: x.url, sha1: x.sha1, sha256: x.sha256, sha512: x.sha512 }))
  };
}
async function loadManifest() {
  try {
    const res = await fetch(`${BUNDLED.manifestUrl}?t=${Date.now()}`, { redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    applyManifest(JSON.parse(text));
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(MANIFEST_CACHE, text);
  } catch (e) {
    console.warn("Manifeste distant indisponible :", e.message);
    try { applyManifest(JSON.parse(fs.readFileSync(MANIFEST_CACHE, "utf8"))); } catch {}
  }
}

// ---------- mods ----------
async function syncMods() {
  const modsDir = path.join(ROOT, "mods");
  fs.mkdirSync(modsDir, { recursive: true });
  // Manifeste local : fichiers gérés par le launcher → les anciens sont supprimés,
  // les mods ajoutés à la main sont conservés.
  const manifestFile = path.join(modsDir, ".gfrpg-manifest.json");
  let managed = {};
  try { managed = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch {}
  const wanted = new Set(CONFIG.mods.map(m => m.filename));
  for (const old of Object.keys(managed)) {
    if (!wanted.has(old) && !old.includes("/") && !old.includes("\\")) {
      fs.rmSync(path.join(modsDir, old), { force: true });
      delete managed[old];
    }
  }
  for (const mod of CONFIG.mods) {
    if (!mod.filename || mod.filename.includes("/") || mod.filename.includes("\\")) continue;
    const dest = path.join(modsDir, mod.filename);
    const [algo, hash] = mod.sha512 ? ["sha512", mod.sha512] : mod.sha256 ? ["sha256", mod.sha256] : ["sha1", mod.sha1];
    if (!(hash ? valid(dest, algo, hash) : fs.existsSync(dest) && managed[mod.filename] === mod.url)) {
      progress("mods", 0, `Téléchargement de ${mod.name}…`);
      await download(mod.url, dest, algo, hash, (d, t) => t && progress("mods", Math.round((d / t) * 100), `${mod.name} — ${(d / 1048576).toFixed(1)} / ${(t / 1048576).toFixed(1)} Mo`));
    }
    managed[mod.filename] = mod.url;
  }
  fs.writeFileSync(manifestFile, JSON.stringify(managed, null, 2));
}

// ---------- auth Microsoft ----------
async function restoreSession() {
  if (!settings.msToken) return null;
  try {
    const xbox = await authManager.refresh(settings.msToken);
    const mc = await xbox.getMinecraft();
    settings.msToken = xbox.save();
    settings.playerName = mc.profile?.name || settings.playerName;
    saveSettings();
    return mc;
  } catch { return null; }
}
async function interactiveLogin() {
  const xbox = await authManager.launch("electron");
  const mc = await xbox.getMinecraft();
  settings.msToken = xbox.save();
  settings.playerName = mc.profile?.name || null;
  saveSettings();
  return mc;
}

// ---------- lancement ----------
async function play() {
  try {
    send("state", { playing: true });
    let mc = await restoreSession();
    if (!mc) {
      progress("auth", 0, "Connexion Microsoft…");
      mc = await interactiveLogin();
    }
    send("state", { playing: true, playerName: settings.playerName });

    await loadManifest();
    await syncMods();
    const game = new Game(ROOT, ROOT, progress, msg => console.log(msg));
    progress("launch", 0, "Préparation de Minecraft " + CONFIG.minecraftVersion + "…");
    await game.prepare(CONFIG.minecraftVersion, CONFIG.neoforgeVersion);

    const auth = mc.mclc();
    const acc = { name: auth.name, uuid: auth.uuid, token: auth.access_token, xuid: auth.meta?.xuid, type: "msa" };
    const server = CONFIG.autoConnect && CONFIG.serverIp && !CONFIG.serverIp.startsWith("A_REMPLACER") ? CONFIG.serverIp : null;
    const p = game.launch(acc, [`-Xmx${settings.ram}G`], server);
    p.stdout.on("data", d => { try { process.stdout.write("[mc] " + d); } catch {} });
    p.stderr.on("data", d => { try { process.stdout.write("[mc] " + d); } catch {} });
    p.on("error", e => send("error", "Lancement impossible : " + e.message));
    p.on("close", () => {
      send("state", { playing: false, playerName: settings.playerName });
      progress("idle", 0, "");
    });
    progress("launch", 100, "Jeu lancé ! Bon jeu sur GrandFantacube ⚔");
    setTimeout(() => { if (win) win.minimize(); }, 3000);
  } catch (err) {
    console.error(err);
    send("state", { playing: false, playerName: settings.playerName });
    send("error", String(err.message || err));
  }
}

// ---------- fenêtre & IPC ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1120, minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: "#0d0a1a",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  loadSettings();
  manifestReady = loadManifest();
  createWindow();
  // Mise à jour auto du launcher (GitHub Releases) — silencieux en dev
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.on("update-downloaded", () => {
        progress("update", 100, "Mise à jour du launcher téléchargée — elle s'installera à la fermeture.");
      });
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch {}
  }
  const mc = await restoreSession();
  send("state", { playing: false, playerName: settings.playerName, loggedIn: !!mc });
});
app.on("window-all-closed", () => app.quit());

ipcMain.handle("get-config", async () => { await manifestReady; return { ...CONFIG, launcherVersion: app.getVersion() }; });
ipcMain.handle("get-settings", () => ({ ram: settings.ram, playerName: settings.playerName, loggedIn: !!settings.msToken }));
ipcMain.handle("set-ram", (_e, ram) => { settings.ram = Math.min(16, Math.max(2, Number(ram) || 4)); saveSettings(); return settings.ram; });
ipcMain.handle("login", async () => {
  const mc = await interactiveLogin();
  return { playerName: settings.playerName };
});
ipcMain.handle("logout", () => { settings.msToken = null; settings.playerName = null; saveSettings(); return true; });
ipcMain.handle("play", () => { play(); return true; });
ipcMain.handle("open-link", (_e, url) => shell.openExternal(url));
