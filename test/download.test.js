const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { createDownloader } = require("../src/download");
const { runAll } = require("../src/game");
const digest = data => crypto.createHash("sha256").update(data).digest("hex");
const immediate = async () => {};

test("failed parallel installation waits for active writers before allowing another launch", async () => {
  let writing = false, skipped = false;
  await assert.rejects(runAll([
    async () => { await new Promise(r => setTimeout(r, 5)); throw Error("failed job"); },
    async () => { writing = true; await new Promise(r => setTimeout(r, 25)); writing = false; },
    async () => { skipped = true; }
  ], "fixture", () => {}, 2), /failed job/);
  assert.equal(writing, false); assert.equal(skipped, false);
});

test("verified downloads preserve installed mods across races and Windows replacement failures", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aeloria-download-"));
  const payload = crypto.randomBytes(1024 * 1024);
  let active = 0, maximum = 0, requests = 0;
  const server = http.createServer((req, res) => {
    requests++; active++; maximum = Math.max(maximum, active);
    res.on("close", () => active--);
    if (req.url === "/broken") { res.writeHead(200); res.write("partial"); setTimeout(() => res.destroy(), 5); return; }
    if (req.url === "/missing") { res.writeHead(404); res.end(); return; }
    const data = req.url === "/second" ? Buffer.from("newer mod") : payload;
    res.writeHead(200, { "content-length": data.length });
    setTimeout(() => res.end(data), 15);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  t.after(() => server.close());
  const dest = name => path.join(root, name, "mods", "mmorpg-1.0.0.jar");
  const staged = dir => fs.readdirSync(path.dirname(dir)).filter(f => f.endsWith(".part"));

  await t.test("creates missing folders and closes a complete stream before hashing/replacing", async () => {
    const file = dest("fresh"); let done = 0;
    await createDownloader({ sleep: immediate })(url, file, "sha256", digest(payload), n => { done = n; });
    assert.equal(digest(fs.readFileSync(file)), digest(payload)); assert.equal(done, payload.length);
    assert.deepEqual(staged(file), []);
  });
  await t.test("serializes two versions targeting the same JAR", async () => {
    active = 0; maximum = 0;
    const file = dest("concurrent"), download = createDownloader({ sleep: immediate });
    await Promise.all([download(url, file, "sha256", digest(payload)), download(url + "/second", file, "sha256", digest("newer mod"))]);
    assert.equal(fs.readFileSync(file, "utf8"), "newer mod"); assert.equal(maximum, 1); assert.deepEqual(staged(file), []);
  });
  await t.test("independent writers never share or delete each other's temporary file", async () => {
    const file = dest("independent"); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".part", "legacy download belongs to another process");
    await Promise.all([createDownloader({ sleep: immediate })(url, file, "sha256", digest(payload)), createDownloader({ sleep: immediate })(url, file, "sha256", digest(payload))]);
    assert.equal(digest(fs.readFileSync(file)), digest(payload));
    assert.equal(fs.readFileSync(file + ".part", "utf8"), "legacy download belongs to another process");
    assert.deepEqual(staged(file), ["mmorpg-1.0.0.jar.part"]);
  });
  await t.test("a hash mismatch leaves the installed JAR intact", async () => {
    const file = dest("hash"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "installed");
    await assert.rejects(createDownloader({ sleep: immediate })(url, file, "sha256", digest("wrong")), /Fichier corrompu/);
    assert.equal(fs.readFileSync(file, "utf8"), "installed"); assert.deepEqual(staged(file), []);
  });
  await t.test("interrupted responses do not publish partial files or leak open streams", async () => {
    const file = dest("broken"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "installed");
    await assert.rejects(createDownloader({ attempts: 2, sleep: immediate })(url + "/broken", file, "sha256", null));
    assert.equal(fs.readFileSync(file, "utf8"), "installed"); assert.deepEqual(staged(file), []);
  });
  await t.test("temporary EPERM is retried without another download or deleting the old mod", async () => {
    const file = dest("transient"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "installed");
    let renames = 0; const before = requests;
    const download = createDownloader({ sleep: immediate, renameFile: async (from, to) => {
      if (++renames < 3) { assert.equal(fs.readFileSync(file, "utf8"), "installed"); throw Object.assign(new Error("locked"), { code: "EPERM" }); }
      await fs.promises.rename(from, to);
    } });
    await download(url, file, "sha256", digest(payload));
    assert.equal(renames, 3); assert.equal(requests - before, 1); assert.equal(digest(fs.readFileSync(file)), digest(payload));
  });
  await t.test("permanent Windows lock gives a useful error and preserves the old JAR", async () => {
    const file = dest("locked"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "installed");
    const before = requests;
    const download = createDownloader({ sleep: immediate, renameFile: async () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); } });
    await assert.rejects(download(url, file, "sha256", digest(payload)), error => error.code === "EPERM" && /Ferme Minecraft/.test(error.message));
    assert.equal(requests - before, 1); assert.equal(fs.readFileSync(file, "utf8"), "installed"); assert.deepEqual(staged(file), []);
  });
  await t.test("a failed queued download does not block the next attempt", async () => {
    const file = dest("queue"), download = createDownloader({ sleep: immediate, attempts: 1 });
    const first = download(url + "/missing", file, "sha256", null);
    const second = download(url, file, "sha256", digest(payload));
    await assert.rejects(first, /404/); await second; assert.equal(digest(fs.readFileSync(file)), digest(payload));
  });
});
