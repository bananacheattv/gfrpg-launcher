const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Presence, frame, pipePaths } = require("../src/discord");

function fakeDiscord(file, events) {
  return new Promise(resolve => {
    const srv = net.createServer(c => {
      let buf = Buffer.alloc(0);
      events.push("connect");
      c.on("data", d => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
          const len = buf.readInt32LE(4); if (buf.length < 8 + len) break;
          const j = JSON.parse(buf.subarray(8, 8 + len).toString()); const op = buf.readInt32LE(0); buf = buf.subarray(8 + len);
          events.push(op === 0 ? "handshake:" + j.client_id : "activity:" + j.args.activity.details);
          c.write(frame(1, op === 0 ? { cmd: "DISPATCH", evt: "READY", data: {} } : { cmd: "SET_ACTIVITY", data: {} }));
        }
      });
      c.on("close", () => events.push("close"));
    }).listen(file, () => resolve(srv));
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test("la présence se connecte, envoie « Dans le launcher », se coupe et reprend", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-"));
  const sock = path.join(dir, "discord-ipc-0"); const events = []; const logs = [];
  const srv = await fakeDiscord(sock, events);
  const p = new Presence({ clientId: "123", log: m => logs.push(m), paths: [path.join(dir, "discord-ipc-9"), sock], retryMs: 100 });
  p.start(); await wait(400);
  assert.deepStrictEqual(events.slice(0, 3), ["connect", "handshake:123", "activity:Dans le launcher"]);
  assert.ok(logs.some(l => l.includes("Statut affiché")));
  p.setActive(false); await wait(200);
  assert.ok(events.includes("close"));
  const n = events.filter(e => e === "connect").length;
  p.setActive(true); await wait(400);
  assert.strictEqual(events.filter(e => e === "connect").length, n + 1);
  p.stop(); srv.close();
});

test("Discord absent : message clair et nouvel essai", async () => {
  const logs = [];
  const p = new Presence({ log: m => logs.push(m), paths: ["/nonexistent/discord-ipc-0"], retryMs: 50 });
  p.start(); await wait(200); p.stop();
  assert.ok(logs.some(l => l.includes("Discord introuvable")));
});

test("chemins Windows : pipes nommés discord-ipc-0 à 9", () => {
  const w = pipePaths({}, "win32");
  assert.strictEqual(w.length, 10); assert.strictEqual(w[0], "\\\\?\\pipe\\discord-ipc-0");
});
