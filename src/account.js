// Compte Aéloria (créé sur le site) dans le launcher : back-end = dossier backend/ du dépôt MMORPG_MOD.
// Le personnage Minecraft est lié par le protocole de session Mojang, comme sur un vrai serveur :
// le launcher « rejoint » un identifiant donné par le back-end, qui vérifie ensuite auprès de Mojang.
// Le jeton Minecraft ne quitte donc jamais le launcher (il n'est envoyé qu'à Mojang).

const MOJANG_SESSION = "https://sessionserver.mojang.com";

/** Adresse du back-end : https uniquement (http accepté en local pour les tests). Vide ou invalide → comptes désactivés. */
function normalizeApi(url) {
  if (typeof url !== "string") return null;
  const value = url.trim().replace(/\/+$/, "");
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) return value;
  return null;
}

const compact = uuid => String(uuid || "").replace(/-/g, "").toLowerCase();

class AccountClient {
  constructor(base, { fetchImpl = fetch, sessionUrl = MOJANG_SESSION } = {}) {
    this.base = base;
    this.fetch = fetchImpl;
    this.sessionUrl = sessionUrl;
  }

  async call(path, { method = "GET", body, token } = {}) {
    let res;
    try {
      res = await this.fetch(`${this.base}/api${path}`, {
        method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw Object.assign(new Error("Serveur des comptes Aéloria injoignable. Réessaie dans un instant."), { status: 0 });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Erreur du serveur des comptes (${res.status}).`), { status: res.status });
    return json;
  }

  login(login, password) {
    return this.call("/auth/login", { method: "POST", body: { login, password, client: "launcher" } });
  }

  me(token) {
    return this.call("/account", { token });
  }

  logout(token) {
    return this.call("/auth/logout", { method: "POST", token });
  }

  /** Défi du back-end → « join » Mojang avec le jeton Minecraft → identifiant à faire vérifier. */
  async prove(challengePath, token, mc) {
    const { serverId } = await this.call(challengePath, { method: "POST", token });
    let res;
    try {
      res = await this.fetch(`${this.sessionUrl}/session/minecraft/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: mc.accessToken, selectedProfile: compact(mc.uuid), serverId }),
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new Error("Serveurs Mojang injoignables : vérification du compte Minecraft impossible.");
    }
    if (!res.ok) throw new Error(`Mojang a refusé la vérification du compte Minecraft (${res.status}). Reconnecte-toi à Microsoft.`);
    return serverId;
  }

  async link(token, mc) {
    const serverId = await this.prove("/account/minecraft/challenge", token, mc);
    return this.call("/account/minecraft", { method: "POST", token, body: { serverId, minecraftName: mc.name } });
  }

  async resetPassword(mc, newPassword) {
    const serverId = await this.prove("/auth/minecraft-challenge", null, mc);
    return this.call("/auth/reset-with-minecraft", { method: "POST", body: { serverId, minecraftName: mc.name, newPassword, client: "launcher" } });
  }
}

/** Avant de jouer : compte valide, personnage lié (automatiquement la première fois) et identique au compte Microsoft. */
async function ensureLinked(client, token, mc) {
  const { account, credits } = await client.me(token);
  if (!account.minecraft) return { account: (await client.link(token, mc)).account, credits: null };
  if (compact(account.minecraft.uuid) !== compact(mc.uuid)) {
    throw Object.assign(new Error(`Ce compte Aéloria est lié au joueur ${account.minecraft.name}. Connecte-toi à Microsoft avec ce compte Minecraft.`), { status: 409 });
  }
  return { account, credits };
}

module.exports = { normalizeApi, AccountClient, ensureLinked };
