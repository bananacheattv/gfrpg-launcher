// Verified downloads with private staging files and safe replacement of Windows-locked targets.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

function createDownloader({ fetchFile = (...args) => fetch(...args), renameFile = fs.promises.rename,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 3, replaceAttempts = 6 } = {}) {
  const pending = new Map();
  async function replace(tmp, dest) {
    for (let i = 0; i < replaceAttempts; i++) {
      try { await renameFile(tmp, dest); return; }
      catch (cause) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(cause.code)) throw cause;
        if (i + 1 === replaceAttempts) {
          const error = new Error(`Impossible de mettre à jour ${path.basename(dest)} : le fichier est utilisé ou son remplacement est refusé. Ferme Minecraft et les autres fenêtres du launcher, puis réessaie.`, { cause });
          error.code = cause.code; error.replacementBlocked = true; throw error;
        }
        await sleep(Math.min(100 * 2 ** i, 1000));
      }
    }
  }
  async function once(url, dest, algo, expected, onBytes) {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    // Never reuse or delete another process's .part file.
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${crypto.randomUUID()}.part`);
    try {
      const res = await fetchFile(url, { redirect: "follow", signal: AbortSignal.timeout(300000) });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new Error(`Téléchargement échoué (${res.status}) : ${url}`);
      }
      let done = 0;
      const progress = new Transform({ transform(chunk, encoding, callback) {
        try { done += chunk.length; if (onBytes) onBytes(done, Number(res.headers.get("content-length")) || 0); callback(null, chunk); }
        catch (error) { callback(error); }
      } });
      // pipeline waits for close, propagates stream errors and honours disk backpressure.
      await pipeline(Readable.fromWeb(res.body), progress, fs.createWriteStream(tmp, { flags: "wx" }));
      if (expected) {
        const hash = crypto.createHash(algo);
        for await (const chunk of fs.createReadStream(tmp)) hash.update(chunk);
        if (hash.digest("hex") !== expected.toLowerCase()) throw new Error("Fichier corrompu : " + path.basename(dest));
      }
      await replace(tmp, dest); // no unlink of the existing, usable JAR
    } finally {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
  async function retry(...args) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { await once(...args); return; }
      catch (error) {
        if (error.replacementBlocked || attempt + 1 === attempts) throw error;
        await sleep(300 * 2 ** attempt);
      }
    }
  }
  return function download(url, dest, algo, expected, onBytes) {
    const target = path.resolve(dest);
    const task = (pending.get(target) || Promise.resolve()).catch(() => {}).then(() => retry(url, target, algo, expected, onBytes));
    pending.set(target, task);
    const cleanup = () => { if (pending.get(target) === task) pending.delete(target); };
    task.then(cleanup, cleanup);
    return task;
  };
}

module.exports = { download: createDownloader(), createDownloader };
