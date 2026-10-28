const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { needsUpdate } = require("../src/updates");
const valid = (file, algorithm, hash) => fs.existsSync(file) && crypto.createHash(algorithm).update(fs.readFileSync(file)).digest("hex") === hash;

test("update detection checks actual installed bytes, runtime, removals and preserves personal mods", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aeloria-updates-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { minecraftVersion: "26.3", neoforgeVersion: "26.3.test", mods: [{ filename: "aeloria.jar", url: "https://fixture/mod.jar", sha256: crypto.createHash("sha256").update("good").digest("hex") }] };
  assert.equal(needsUpdate(root, config, valid), true);
  for (const id of ["26.3", "neoforge-26.3.test"]) { const dir = path.join(root, "versions", id);fs.mkdirSync(dir, { recursive: true });fs.writeFileSync(path.join(dir, id + ".json"), "{}"); }
  fs.mkdirSync(path.join(root, "mods"));
  fs.writeFileSync(path.join(root, "mods", "aeloria.jar"), "good");
  fs.writeFileSync(path.join(root, "mods", "my-shader.jar"), "personal");
  fs.writeFileSync(path.join(root, "mods", ".aeloria-manifest.json"), JSON.stringify({ "aeloria.jar": config.mods[0].url }));
  assert.equal(needsUpdate(root, config, valid), false);
  fs.writeFileSync(path.join(root, "mods", "aeloria.jar"), "partial");
  assert.equal(needsUpdate(root, config, valid), true);
  fs.writeFileSync(path.join(root, "mods", "aeloria.jar"), "good");
  fs.writeFileSync(path.join(root, "mods", ".aeloria-manifest.json"), JSON.stringify({ "aeloria.jar": config.mods[0].url, "retired.jar": "https://fixture/retired.jar" }));
  assert.equal(needsUpdate(root, config, valid), true);
  assert.equal(fs.readFileSync(path.join(root, "mods", "my-shader.jar"), "utf8"), "personal");
});
