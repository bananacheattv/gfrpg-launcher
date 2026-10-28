const fs = require("fs");
const path = require("path");

// Compare installed bytes, not just the displayed version: interrupted or damaged downloads need repair too.
function needsUpdate(root, config, valid) {
  for (const id of [config.minecraftVersion, "neoforge-" + config.neoforgeVersion]) {
    if (!fs.existsSync(path.join(root, "versions", id, id + ".json"))) return true;
  }
  let managed = {};
  try { managed = JSON.parse(fs.readFileSync(path.join(root, "mods", ".aeloria-manifest.json"), "utf8")); } catch {}
  const wanted = new Set();
  for (const mod of config.mods || []) {
    if (!mod.filename || /[\\/:]/.test(mod.filename) || mod.filename === "." || mod.filename === "..") throw new Error("Nom de fichier du manifeste invalide.");
    wanted.add(mod.filename);
    const file = path.join(root, "mods", mod.filename);
    const [algorithm, hash] = mod.sha512 ? ["sha512", mod.sha512] : mod.sha256 ? ["sha256", mod.sha256] : ["sha1", mod.sha1];
    if (hash ? !valid(file, algorithm, hash) : !fs.existsSync(file) || managed[mod.filename] !== mod.url) return true;
  }
  return Object.keys(managed).some(file => !wanted.has(file));
}
module.exports = { needsUpdate };
