// Rich Presence Discord du launcher (« Dans le launcher »), sans dépendance : dialogue direct avec le socket IPC local de Discord.
// Même application que le jeu (le mod prend le relais en jeu) : le launcher coupe sa présence au lancement du jeu et la remet à sa fermeture.
const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");

const DEFAULT_APP_ID = "1565874848167755776";

function pipePaths(env = process.env, platform = process.platform) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    if (platform === "win32") out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    else {
      const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, "/tmp"].filter(Boolean);
      for (const b of bases) for (const sub of ["", "snap.discord", "app/com.discordapp.Discord", "app/com.discordapp.DiscordCanary"]) out.push(path.join(b, sub, `discord-ipc-${i}`));
    }
  }
  return out;
}

function frame(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0); head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

class Presence {
  constructor({ clientId = DEFAULT_APP_ID, log = () => {}, paths = pipePaths(), retryMs = 10000, details = "Dans le launcher" } = {}) {
    this.clientId = clientId; this.log = m => log("[Discord] " + m); this.paths = paths; this.retryMs = retryMs; this.details = details;
    this.active = true; this.stopped = false; this.sock = null; this.timer = null; this.start_ = Math.floor(Date.now() / 1000); this.lastLog = "";
  }
  say(m) { if (m !== this.lastLog) { this.lastLog = m; this.log(m); } }
  start() { this.say(`Présence démarrée (application ${this.clientId}, ${process.platform})`); this.connect(); }
  setActive(on) {
    this.active = on;
    if (!on) { this.drop(); this.say("Présence du launcher coupée (le jeu prend le relais)."); }
    else if (!this.sock && !this.stopped) { this.say("Présence du launcher reprise."); this.connect(); }
  }
  stop() { this.stopped = true; this.drop(); }
  drop() { clearTimeout(this.timer); if (this.sock) { try { this.sock.destroy(); } catch {} this.sock = null; } }
  retry() { if (this.stopped || !this.active) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.connect(), this.retryMs); }
  connect() {
    if (this.stopped || !this.active || this.sock) return;
    this.tryPath(0);
  }
  tryPath(i) {
    if (this.stopped || !this.active) return;
    if (i >= this.paths.length) { this.say("Discord introuvable (aucun discord-ipc-0..9). Lance Discord (pas en administrateur) ; nouvel essai toutes les 10 s."); return this.retry(); }
    const p = this.paths[i];
    const sock = net.connect({ path: p });
    let opened = false, buf = Buffer.alloc(0), ready = false;
    sock.once("connect", () => {
      opened = true; this.sock = sock;
      this.say(`Connecté à Discord (${p}), handshake…`);
      sock.write(frame(0, { v: 1, client_id: this.clientId }));
    });
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const msg = buf.subarray(8, 8 + len).toString("utf8"); buf = buf.subarray(8 + len);
        let j = {}; try { j = JSON.parse(msg); } catch {}
        if (!ready && j.evt === "READY") { ready = true; this.say("Discord prêt (READY), envoi du statut…"); this.sendActivity(sock); }
        else if (j.evt === "ERROR" || (j.data && j.data.code)) this.say("Discord a refusé : " + msg);
        else if (j.cmd === "SET_ACTIVITY") this.say("Statut affiché : « " + this.details + " »");
        else this.say("Réponse Discord : " + msg.slice(0, 200));
      }
    });
    sock.on("error", e => { if (!opened) return this.tryPath(i + 1); this.say("Erreur Discord : " + e.message); });
    sock.on("close", () => {
      if (!opened) return;
      if (this.sock === sock) this.sock = null;
      if (!this.stopped && this.active) { this.say("Connexion Discord fermée, nouvel essai…"); this.retry(); }
    });
  }
  sendActivity(sock) {
    sock.write(frame(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: { details: this.details, timestamps: { start: this.start_ } } }, nonce: require("crypto").randomUUID() }));
  }
}
module.exports = { Presence, pipePaths, frame, DEFAULT_APP_ID };
