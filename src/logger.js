// Journal du launcher : fichier launcher.log (réécrit à chaque ouverture) + tampon en mémoire affiché dans l'onglet Logs.
const fs = require("fs");
const path = require("path");

function createLogger(dir, onLine) {
  const file = path.join(dir, "launcher.log");
  const lines = [];
  let stream = null;
  try { fs.mkdirSync(dir, { recursive: true }); stream = fs.createWriteStream(file, { flags: "w" }); stream.on("error", () => { stream = null; }); } catch { stream = null; }
  function add(level, args) {
    const text = args.map(a => (typeof a === "string" ? a : a && a.stack ? a.stack : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
    for (const part of text.split(/\r?\n/)) {
      if (!part.trim()) continue;
      const line = `${new Date().toLocaleTimeString("fr-FR")} ${level === "info" ? "" : "[" + level + "] "}${part}`;
      lines.push(line);
      if (lines.length > 3000) lines.splice(0, 1000);
      try { stream && stream.write(line + "\n"); } catch {}
      try { onLine && onLine(line); } catch {}
    }
  }
  return { file, dir, lines, info: (...a) => add("info", a), warn: (...a) => add("warn", a), error: (...a) => add("erreur", a), text: () => lines.join("\n") };
}
module.exports = { createLogger };
