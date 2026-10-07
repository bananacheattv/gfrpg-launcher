// Installation + lancement direct de Minecraft / NeoForge (compatible numérotation 26.x) :
// Java de Mojang, client vanilla, NeoForge, bibliothèques, ressources, ligne de commande.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const VERSIONS = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const RUNTIMES = "https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

const OS = { win32: "windows", darwin: "osx" }[process.platform] || "linux";
const ARM = process.arch === "arm64";

function hashFile(file, algo) {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest("hex");
}
function valid(file, algo, expected, size) {
  if (!fs.existsSync(file)) return false;
  if (expected) return hashFile(file, algo) === expected.toLowerCase();
  return !size || fs.statSync(file).size === size;
}
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} : ${url}`);
  return res.json();
}
async function download(url, dest, algo, expected, onBytes) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`Téléchargement échoué (${res.status}) : ${url}`);
      const tmp = dest + ".part";
      const out = fs.createWriteStream(tmp);
      let done = 0;
      for await (const chunk of res.body) {
        out.write(chunk);
        done += chunk.length;
        if (onBytes) onBytes(done, Number(res.headers.get("content-length")) || 0);
      }
      await new Promise((r, j) => out.end(err => (err ? j(err) : r())));
      if (expected && hashFile(tmp, algo) !== expected.toLowerCase()) {
        fs.rmSync(tmp, { force: true });
        throw new Error("Fichier corrompu : " + path.basename(dest));
      }
      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw last;
}

function versionNum(s) {
  let v = 0, scale = 1;
  for (const p of String(s).split(".")) { v += (parseInt(p) || 0) * scale; scale /= 100000; }
  return v;
}
function osVersion() { return versionNum(require("os").release()); }

function rulesAllow(rules, features = {}) {
  if (!rules) return true;
  let allow = false;
  for (const rule of rules) {
    let match = true;
    const os = rule.os || {};
    if (os.name && os.name !== OS) match = false;
    if (os.arch && (os.arch === "x86") !== (process.arch === "ia32")) match = false;
    if (os.versionRange) {
      const v = osVersion();
      if (os.versionRange.min && v < versionNum(os.versionRange.min)) match = false;
      if (os.versionRange.max && v >= versionNum(os.versionRange.max)) match = false;
    }
    for (const [k, val] of Object.entries(rule.features || {})) if ((features[k] || false) !== val) match = false;
    if (match) allow = rule.action === "allow";
  }
  return allow;
}

async function runAll(jobs, what, progress, parallel = 8) {
  if (!jobs.length) return;
  let done = 0, i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      await job();
      done++;
      progress(what, Math.round((done / jobs.length) * 100), `Téléchargement des ${what} (${done}/${jobs.length})`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

class Game {
  /** dir : versions/libraries/assets/runtime ; gameDir : mods, config, saves. */
  constructor(dir, gameDir, progress, log = console.log) {
    this.dir = dir;
    this.gameDir = gameDir;
    this.progress = progress;
    this.log = log;
  }

  vpath(id) { return path.join(this.dir, "versions", id, id + ".json"); }

  async prepare(mcVersion, neoforge) {
    const vanillaJson = this.vpath(mcVersion);
    if (!fs.existsSync(vanillaJson)) {
      this.progress("minecraft", 0, `Recherche de Minecraft ${mcVersion}…`);
      const m = await getJson(VERSIONS);
      const v = m.versions.find(x => x.id === mcVersion);
      if (!v) throw new Error("Version Minecraft introuvable : " + mcVersion);
      await download(v.url, vanillaJson, "sha1", v.sha1);
    }
    const vanilla = JSON.parse(fs.readFileSync(vanillaJson, "utf8"));
    this.java = await this.ensureRuntime(vanilla.javaVersion || {});
    const id = "neoforge-" + neoforge;
    if (!fs.existsSync(this.vpath(id))) await this.installNeoForge(neoforge);
    this.version = this.resolve(id);
    await this.downloadLibraries();
    await this.downloadClientAndAssets();
  }

  async ensureRuntime(jv) {
    const component = jv.component || "java-runtime-delta";
    const root = path.join(this.dir, "runtime", component);
    const exe = OS === "osx" ? path.join(root, "jre.bundle/Contents/Home/bin/java")
      : path.join(root, "bin", OS === "windows" ? "javaw.exe" : "java");
    const marker = path.join(root, ".ok");
    if (fs.existsSync(marker) && fs.existsSync(exe)) return exe;
    this.progress("java", 0, `Téléchargement de Java ${jv.majorVersion || ""}…`);
    const platform = OS === "windows" ? (ARM ? "windows-arm64" : "windows-x64") : OS === "osx" ? (ARM ? "mac-os-arm64" : "mac-os") : "linux";
    const all = await getJson(RUNTIMES);
    const entry = ((all[platform] || {})[component] || [])[0];
    if (!entry) throw new Error(`Java ${component} indisponible pour ${platform}`);
    const files = (await getJson(entry.manifest.url)).files;
    const jobs = [];
    for (const [rel, f] of Object.entries(files)) {
      const p = path.join(root, rel);
      if (f.type === "directory") fs.mkdirSync(p, { recursive: true });
      else if (f.type === "file") jobs.push(async () => {
        if (!valid(p, "sha1", f.downloads.raw.sha1)) await download(f.downloads.raw.url, p, "sha1", f.downloads.raw.sha1);
        if (f.executable) fs.chmodSync(p, 0o755);
      });
      else if (f.type === "link") jobs.push(async () => {
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.rmSync(p, { force: true }); fs.symlinkSync(f.target, p); } catch {}
      });
    }
    await runAll(jobs, "fichiers Java", this.progress);
    fs.writeFileSync(marker, "ok");
    return exe;
  }

  async installNeoForge(neo) {
    fs.mkdirSync(this.dir, { recursive: true });
    const profiles = path.join(this.dir, "launcher_profiles.json");
    if (!fs.existsSync(profiles)) fs.writeFileSync(profiles, JSON.stringify({ profiles: {} }));
    const installer = path.join(this.dir, "neoforge-installer.jar");
    this.progress("neoforge", 0, `Téléchargement de NeoForge ${neo}…`);
    await download(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${neo}/neoforge-${neo}-installer.jar`, installer, "sha1", null,
      (d, t) => t && this.progress("neoforge", Math.round((d / t) * 100), `Téléchargement de NeoForge ${neo}…`));
    this.progress("neoforge", 100, "Installation de NeoForge (quelques minutes)…");
    const javaCli = this.java.replace(/javaw\.exe$/, "java.exe");
    await new Promise((resolve, reject) => {
      const p = spawn(javaCli, ["-jar", installer, "--install-client", this.dir], { cwd: this.dir });
      p.stdout.on("data", d => this.log("[neoforge] " + String(d).trim()));
      p.stderr.on("data", d => this.log("[neoforge] " + String(d).trim()));
      p.on("error", reject);
      p.on("close", c => (c === 0 ? resolve() : reject(new Error("L'installateur NeoForge a échoué (code " + c + ")"))));
    });
    fs.rmSync(installer, { force: true });
    fs.rmSync(installer + ".log", { force: true });
  }

  /** Charge une version et fusionne ses parents (inheritsFrom). */
  resolve(id) {
    const v = JSON.parse(fs.readFileSync(this.vpath(id), "utf8"));
    if (!v.inheritsFrom) return v;
    const parent = this.resolve(v.inheritsFrom);
    const pa = parent.arguments || {}, va = v.arguments || {};
    return {
      ...parent, ...v,
      jarId: parent.jarId || v.inheritsFrom,
      libraries: [...(v.libraries || []), ...(parent.libraries || [])],
      arguments: {
        "default-user-jvm": pa["default-user-jvm"],
        jvm: [...(pa.jvm || []), ...(va.jvm || [])],
        game: [...(pa.game || []), ...(va.game || [])]
      }
    };
  }

  libraries() {
    const seen = new Set(), out = [];
    for (const lib of this.version.libraries) {
      if (!rulesAllow(lib.rules)) continue;
      const n = lib.name.split(":");
      const key = n.length > 3 ? `${n[0]}:${n[1]}:${n[3]}` : `${n[0]}:${n[1]}`;
      if (!seen.has(key)) { seen.add(key); out.push(lib); }
    }
    return out;
  }

  libPath(lib) {
    let p = lib.downloads?.artifact?.path;
    if (!p) {
      const n = lib.name.split(":");
      p = `${n[0].replaceAll(".", "/")}/${n[1]}/${n[2]}/${n[1]}-${n[2]}${n[3] ? "-" + n[3] : ""}.jar`;
    }
    return path.join(this.dir, "libraries", p);
  }

  async downloadLibraries() {
    const jobs = [];
    for (const lib of this.libraries()) {
      const art = lib.downloads?.artifact;
      if (!art?.url) continue; // généré par l'installeur NeoForge
      const p = this.libPath(lib);
      if (!valid(p, "sha1", null, art.size)) jobs.push(() => download(art.url, p, "sha1", art.sha1));
    }
    await runAll(jobs, "bibliothèques", this.progress);
  }

  async downloadClientAndAssets() {
    const jarId = this.version.jarId || this.version.id;
    const client = this.version.downloads?.client;
    const jar = path.join(this.dir, "versions", jarId, jarId + ".jar");
    if (client && !valid(jar, "sha1", null, client.size)) {
      this.progress("minecraft", 0, "Téléchargement du client Minecraft…");
      await download(client.url, jar, "sha1", client.sha1, (d, t) => t && this.progress("minecraft", Math.round((d / t) * 100), "Téléchargement du client Minecraft…"));
    }
    const ai = this.version.assetIndex;
    const index = path.join(this.dir, "assets", "indexes", ai.id + ".json");
    if (!valid(index, "sha1", ai.sha1)) await download(ai.url, index, "sha1", ai.sha1);
    const objects = JSON.parse(fs.readFileSync(index, "utf8")).objects;
    const seen = new Set(), jobs = [];
    for (const o of Object.values(objects)) {
      const h = o.hash;
      if (seen.has(h)) continue;
      seen.add(h);
      const p = path.join(this.dir, "assets", "objects", h.slice(0, 2), h);
      if (!valid(p, "sha1", null, o.size)) jobs.push(() => download(`https://resources.download.minecraft.net/${h.slice(0, 2)}/${h}`, p, "sha1", h));
    }
    await runAll(jobs, "ressources", this.progress, 16);
  }

  /** acc = { name, uuid, token, xuid, type } */
  launch(acc, extraJvm = [], quickPlayServer = null) {
    const sep = OS === "windows" ? ";" : ":";
    const natives = path.join(this.dir, "natives");
    fs.mkdirSync(natives, { recursive: true });
    fs.mkdirSync(this.gameDir, { recursive: true });
    const cp = this.libraries().map(l => this.libPath(l)).filter(p => fs.existsSync(p));
    const jarId = this.version.jarId || this.version.id;
    cp.push(path.join(this.dir, "versions", jarId, jarId + ".jar"));
    const vars = {
      auth_player_name: acc.name, version_name: this.version.id, game_directory: this.gameDir,
      assets_root: path.join(this.dir, "assets"), assets_index_name: this.version.assetIndex.id,
      auth_uuid: acc.uuid, auth_access_token: acc.token, clientid: "0", auth_xuid: acc.xuid || "0",
      user_type: acc.type || "msa", version_type: "release", natives_directory: natives,
      launcher_name: "GrandFantacube", launcher_version: "1", classpath: cp.join(sep),
      library_directory: path.join(this.dir, "libraries"), classpath_separator: sep,
      quickPlayMultiplayer: quickPlayServer || ""
    };
    const features = { is_quick_play_multiplayer: !!quickPlayServer };
    const sub = s => String(s).replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    const add = (out, list) => {
      for (const a of list || []) {
        if (typeof a === "string") { out.push(sub(a)); continue; }
        if (!rulesAllow(a.rules, features)) continue;
        for (const v of [].concat(a.value)) out.push(sub(v));
      }
    };
    const args = [];
    add(args, this.version.arguments["default-user-jvm"]);
    args.push(...extraJvm);
    add(args, this.version.arguments.jvm);
    args.push(this.version.mainClass);
    add(args, this.version.arguments.game);
    this.log(`Lancement de ${this.version.id} en tant que ${acc.name}`);
    return spawn(this.java, args, { cwd: this.gameDir, detached: true });
  }
}

module.exports = { Game, download, valid, hashFile };
