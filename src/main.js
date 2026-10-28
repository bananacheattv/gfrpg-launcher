// Aeloria Launcher — processus principal Electron
// Manifeste distant (mis à jour à chaque push du mod) → Java (Mojang) → Minecraft + NeoForge → mods → auth Microsoft → lancement
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { Auth } = require("msmc");
const { Game, download, valid } = require("./game");
// Public game version is independent of Minecraft and installer updates.
const GAME_VERSION = "0.0";

const BUNDLED = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "launcher-config.json"), "utf8"));
// (le dossier garde son nom d'origine : il contient les mondes, les mods et la connexion Microsoft des joueurs)
const ROOT = path.join(app.getPath("appData"), ".grandfantacube");        // dossier du jeu
const SETTINGS_FILE = path.join(ROOT, "launcher-settings.json");
const MANIFEST_CACHE = path.join(ROOT, "modpack-manifest.json");

let CONFIG = { ...BUNDLED, gameVersion: GAME_VERSION };
let win = null;
let manifestReady = Promise.resolve();
let settings = { ram: 4, msToken: null, playerName: null };
let launching = false;
let activeGame = null;
let updating = false, updater = null, launcherUpdate = false, launcherDownloaded = false;
let updateStatus = { available: false, checking: true, busy: false, message: "Vérification des mises à jour…" };
function publishUpdates(extra = {}) {
  updateStatus = { ...updateStatus, ...extra, launcher: launcherUpdate, restart: launcherDownloaded };
  send("update-status", updateStatus);return updateStatus;
}
async function checkUpdates(refresh = true) {
  if (updating) return updateStatus;
  publishUpdates({ checking: true });
  const fresh = refresh ? await loadManifest() : true;
  try {
    const available = require("./updates").needsUpdate(ROOT, CONFIG, valid) || launcherUpdate;
    return publishUpdates({ checking: false, available, message: available ? "Une mise à jour est disponible." : fresh ? "Aeloria est à jour." : "Vérification impossible hors connexion.", offline: !fresh });
  } catch (error) {return publishUpdates({ checking: false, available: false, offline: true, message: error.message });}
}
async function updateGame() {
  if (updating || launching || activeGame) return { ok: false, message: "Ferme Minecraft avant de mettre à jour." };
  updating = true;
  publishUpdates({ busy: true, checking: false, message: "Mise à jour en cours…" });
  try {
    if (!await loadManifest()) throw new Error("Connexion au serveur de mises à jour impossible. Réessaie plus tard.");
    await syncMods((step,percent,label) => publishUpdates({busy:true,percent,message:label}));installLoadingTheme();
    const game = new Game(ROOT, ROOT, (step, percent, label) => publishUpdates({ busy: true, percent, message: label }), msg => console.log(msg));
    await game.prepare(CONFIG.minecraftVersion, CONFIG.neoforgeVersion);
    if (updater && launcherUpdate && !launcherDownloaded) await updater.downloadUpdate();
    updating = false;
    await checkUpdates(false);publishUpdates({ busy: false, percent: 100, message: launcherDownloaded ? "Launcher prêt : redémarre pour installer la mise à jour." : "Aeloria est à jour." });
    return { ok: true };
  } catch (error) {
    publishUpdates({ busy: false, checking: false, available: true, message: String(error.message || error) });
    return { ok: false, message: String(error.message || error) };
  } finally {updating = false;}
}
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
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
    gameVersion: m.gameVersion || GAME_VERSION,
    minecraftVersion: m.minecraft || BUNDLED.minecraftVersion,
    neoforgeVersion: m.neoforge || BUNDLED.neoforgeVersion,
    serverIp: m.serverIp || BUNDLED.serverIp,
    modpackVersion: m.version,
    modpackDate: m.date,
    modpackNotes: Array.isArray(m.notes) ? m.notes : [],
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
    return true;
  } catch (e) {
    console.warn("Manifeste distant indisponible :", e.message);
    try { applyManifest(JSON.parse(fs.readFileSync(MANIFEST_CACHE, "utf8"))); } catch {}
    return false;
  }
}

// ---------- mods ----------
async function syncMods(report = progress) {
  const modsDir = path.join(ROOT, "mods");
  fs.mkdirSync(modsDir, { recursive: true });
  // Manifeste local : fichiers gérés par le launcher → les anciens sont supprimés,
  // les mods ajoutés à la main sont conservés.
  const manifestFile = path.join(modsDir, ".aeloria-manifest.json");
  const legacyManifest = path.join(modsDir, ".gfrpg-manifest.json");
  let managed = {};
  try { managed = JSON.parse(fs.readFileSync(fs.existsSync(manifestFile) ? manifestFile : legacyManifest, "utf8")); } catch {}
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
      report("mods", 0, `Téléchargement de ${mod.name}…`);
      await download(mod.url, dest, algo, hash, (d, t) => t && report("mods", Math.round((d / t) * 100), `${mod.name} — ${(d / 1048576).toFixed(1)} / ${(t / 1048576).toFixed(1)} Mo`));
    }
    managed[mod.filename] = mod.url;
  }
  fs.writeFileSync(manifestFile, JSON.stringify(managed, null, 2));
  if(fs.existsSync(legacyManifest))fs.rmSync(legacyManifest);
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

// ---------- écran de chargement de NeoForge aux couleurs d'Aeloria ----------
// NeoForge lit config/fml/theme-default.json avant de charger les mods : le launcher le dépose à chaque lancement (le mod fait pareil).
// Un thème personnalisé sans la marque "_aeloria" n'est jamais remplacé.
function installLoadingTheme() {
  try {
    const src = path.join(__dirname, "theme");
    const dir = path.join(ROOT, "config", "fml");
    const current = path.join(dir, "theme-default.json");
    if (fs.existsSync(current) && !fs.readFileSync(current, "utf8").includes('"_aeloria"')) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  } catch (e) { console.log("Thème de chargement non installé : " + e.message); }
}

// ---------- lancement ----------
async function play() {
  if (updating) {send("error", "Mise à jour en cours. Attends sa fin avant de lancer Minecraft.");return;}
  if (launching || activeGame) {
    send("error", "Minecraft est déjà lancé ou en cours de préparation. Ferme le jeu avant de le relancer.");
    send("state", { playing: true, playerName: settings.playerName });
    return;
  }
  launching = true; // set synchronously, before authentication or any download
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
    installLoadingTheme();
    const game = new Game(ROOT, ROOT, progress, msg => console.log(msg));
    progress("launch", 0, "Préparation de Minecraft " + CONFIG.minecraftVersion + "…");
    await game.prepare(CONFIG.minecraftVersion, CONFIG.neoforgeVersion);

    const auth = mc.mclc();
    const acc = { name: auth.name, uuid: auth.uuid, token: auth.access_token, xuid: auth.meta?.xuid, type: "msa" };
    const server = CONFIG.autoConnect && CONFIG.serverIp && !CONFIG.serverIp.startsWith("A_REMPLACER") ? CONFIG.serverIp : null;
    const p = game.launch(acc, [`-Xmx${settings.ram}G`, `-Daeloria.server=${CONFIG.serverIp || "192.168.0.249:25565"}`], server);
    activeGame = p;
    p.stdout.on("data", d => { try { process.stdout.write("[mc] " + d); } catch {} });
    p.stderr.on("data", d => { try { process.stdout.write("[mc] " + d); } catch {} });
    p.on("error", e => {
      if (activeGame === p) activeGame = null;
      send("state", { playing: false, playerName: settings.playerName });
      send("error", "Lancement impossible : " + e.message);
    });
    p.on("close", () => {
      if (activeGame === p) activeGame = null;
      send("state", { playing: false, playerName: settings.playerName });
      progress("idle", 0, "");
    });
    progress("launch", 100, "Jeu lancé ! Bon jeu sur Aeloria.");
    setTimeout(() => { if (win) win.minimize(); }, 3000);
  } catch (err) {
    console.error(err);
    send("state", { playing: false, playerName: settings.playerName });
    send("error", String(err.message || err));
  } finally {
    launching = false;
  }
}

// ---------- fenêtre & IPC ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 690, minWidth: 920, minHeight: 600,
    frame: false,                                        // barre de titre dessinée par l'interface (reduire / agrandir / fermer)
    autoHideMenuBar: true,
    backgroundColor: "#0a0810",
    icon: path.join(__dirname, "renderer", "assets", "aeloria_emblem.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  loadSettings();
  manifestReady = loadManifest();
  createWindow();
  // Mise à jour auto du launcher (GitHub Releases) — silencieux en dev
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");updater = autoUpdater;
      updater.autoDownload = false;
      updater.on("update-available", () => { launcherUpdate = true;publishUpdates({ available: true, message: "Mise à jour du launcher disponible." }); });
      updater.on("download-progress", info => publishUpdates({ busy: true, percent: info.percent, message: "Téléchargement du launcher… " + Math.round(info.percent) + " %" }));
      updater.on("update-downloaded", () => { launcherDownloaded = true;publishUpdates({ busy: false, available: true, message: "Redémarre le launcher pour installer sa mise à jour." }); });
      updater.checkForUpdates().catch(() => {});
    } catch {}
  }
  const mc = await restoreSession();
  send("state", { playing: launching || !!activeGame, playerName: settings.playerName, loggedIn: !!mc });
});
app.on("second-instance", () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on("window-all-closed", () => app.quit());

ipcMain.handle("get-config", async () => { await manifestReady; return { ...CONFIG, launcherVersion: app.getVersion() }; });
ipcMain.handle("get-update-status", async () => { await manifestReady;return checkUpdates(); });
ipcMain.handle("update-game", () => updateGame());
ipcMain.handle("install-launcher-update", () => { if (updater && launcherDownloaded && !activeGame && !launching && !updating) {updater.quitAndInstall(true, true);return true;}return false; });
ipcMain.handle("get-settings", () => ({ ram: settings.ram, playerName: settings.playerName, loggedIn: !!settings.msToken }));
ipcMain.handle("set-ram", (_e, ram) => { settings.ram = Math.min(16, Math.max(2, Number(ram) || 4)); saveSettings(); return settings.ram; });
ipcMain.handle("login", async () => {
  const mc = await interactiveLogin();
  return { playerName: settings.playerName };
});
ipcMain.handle("logout", () => { settings.msToken = null; settings.playerName = null; saveSettings(); return true; });
ipcMain.handle("play", () => { play(); return true; });
ipcMain.handle("open-link", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);          // jamais autre chose qu'un lien web
});
ipcMain.handle("install-shaders",async()=>{
  if(updating||launching||activeGame)return{ok:false,message:"Ferme Minecraft avant d’installer les shaders."};
  updating=true;publishUpdates({busy:true,message:"Installation du support des shaders…"});
  try{await manifestReady;await require("./graphics").installGraphics(ROOT,CONFIG.minecraftVersion);return{ok:true,message:"Support installé. Choisis ton pack dans Options → Graphismes → Shaders."};}
  catch(e){return{ok:false,message:e.message};}finally{updating=false;publishUpdates({busy:false});}
});
ipcMain.handle("open-shaders-folder",()=>{const folder=path.join(ROOT,"shaderpacks");fs.mkdirSync(folder,{recursive:true});return shell.openPath(folder);});
ipcMain.handle("open-folder", () => { fs.mkdirSync(ROOT, { recursive: true }); return shell.openPath(ROOT); });
ipcMain.handle("win-minimize", () => { if (win) win.minimize(); });
ipcMain.handle("win-maximize", () => { if (win) (win.isMaximized() ? win.unmaximize() : win.maximize()); });
ipcMain.handle("win-close", () => { if (win) win.close(); });
ipcMain.handle("server-status", async () => {
  const addr = CONFIG.serverIp;
  if (!addr || addr.startsWith("A_REMPLACER")) return { online: false };
  const [host, port] = addr.split(":");
  return pingServer(host, Number(port) || 25565);
});

// ---------- etat du serveur (Server List Ping de Minecraft) : joueurs en ligne ----------
function pingServer(host, port, timeoutMs = 3500) {
  const net = require("net");
  const varint = n => { const out = []; do { let t = n & 0x7f; n >>>= 7; if (n) t |= 0x80; out.push(t); } while (n); return Buffer.from(out); };
  const packet = body => Buffer.concat([varint(body.length), body]);
  return new Promise(resolve => {
    let done = false, buf = Buffer.alloc(0);
    const finish = r => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(r); };
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs, () => finish({ online: false }));
    sock.on("error", () => finish({ online: false }));
    sock.on("connect", () => {
      const h = Buffer.from(host, "utf8");
      const port2 = Buffer.alloc(2); port2.writeUInt16BE(port);
      sock.write(packet(Buffer.concat([varint(0), varint(767), varint(h.length), h, port2, varint(1)])));
      sock.write(packet(varint(0)));
    });
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      try {
        let i = 0, len = 0, shift = 0, b;
        do { b = buf[i++]; if (b === undefined) return; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        if (buf.length < i + len) return;
        let j = i; do { b = buf[j++]; } while (b & 0x80);                 // identifiant du paquet
        let slen = 0; shift = 0; do { b = buf[j++]; slen |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        const json = JSON.parse(buf.slice(j, j + slen).toString("utf8"));
        finish({ online: true, players: json.players?.online ?? 0, max: json.players?.max ?? 0 });
      } catch { finish({ online: false }); }
    });
  });
}
