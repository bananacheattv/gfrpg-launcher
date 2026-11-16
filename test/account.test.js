const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeApi, AccountClient, ensureLinked } = require("../src/account");

const MC = { accessToken: "mc-token-secret", uuid: "01234567-89ab-cdef-0123-456789abcdef", name: "Copassist" };

// Faux back-end + faux Mojang : le jeton Minecraft ne doit partir que vers Mojang.
function fakeServers({ linkedTo = null } = {}) {
  const calls = [], joined = new Set();
  let linked = linkedTo;
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, auth: init.headers?.Authorization, body });
    if (url === "https://session.test/session/minecraft/join") { joined.add(body.serverId); assert.equal(body.selectedProfile, "0123456789abcdef0123456789abcdef"); return json(204, {}); }
    assert.ok(!JSON.stringify(body || {}).includes(MC.accessToken), "jeton Minecraft envoyé au back-end");
    const path = url.replace("https://api.test/api", "");
    if (path === "/auth/login") return body.password === "bon-mot-de-passe" ? json(200, { token: "tok", account: { username: "Lyra", minecraft: null } }) : json(401, { error: "Identifiant ou mot de passe incorrect." });
    if (init.headers?.Authorization !== "Bearer tok" && !path.startsWith("/auth/")) return json(401, { error: "Session expirée : reconnecte-toi." });
    if (path === "/account") return json(200, { account: { username: "Lyra", minecraft: linked }, credits: linked ? 1200 : null });
    if (path === "/account/minecraft/challenge" || path === "/auth/minecraft-challenge") return json(200, { serverId: "defi" + calls.length });
    if (path === "/account/minecraft") {
      assert.ok(joined.has(body.serverId), "liaison sans join Mojang");
      linked = { uuid: MC.uuid, name: body.minecraftName };
      return json(200, { account: { username: "Lyra", minecraft: linked } });
    }
    if (path === "/auth/reset-with-minecraft") { assert.ok(joined.has(body.serverId)); return json(200, { token: "tok2", account: { username: "Lyra", minecraft: { uuid: MC.uuid, name: MC.name } } }); }
    return json(404, { error: "?" });
  };
  return { calls, fetchImpl, client: new AccountClient("https://api.test", { fetchImpl, sessionUrl: "https://session.test" }) };
}

test("adresse du back-end : https seulement (http en local)", () => {
  assert.equal(normalizeApi(""), null);
  assert.equal(normalizeApi("http://exemple.fr"), null);
  assert.equal(normalizeApi("https://api.aeloria.fr/"), "https://api.aeloria.fr");
  assert.equal(normalizeApi("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeApi("https://api.aeloria.fr/chemin"), null);
});

test("connexion : erreur lisible puis succès", async () => {
  const { client } = fakeServers();
  await assert.rejects(client.login("Lyra", "faux"), /incorrect/);
  const data = await client.login("Lyra", "bon-mot-de-passe");
  assert.equal(data.token, "tok");
});

test("première partie : liaison automatique prouvée par Mojang, jeton jamais transmis au back-end", async () => {
  const { client, calls } = fakeServers();
  const { account } = await ensureLinked(client, "tok", MC);
  assert.equal(account.minecraft.name, "Copassist");
  const join = calls.find(c => c.url.endsWith("/session/minecraft/join"));
  assert.equal(join.body.accessToken, MC.accessToken);
  assert.equal(calls.filter(c => c.url.startsWith("https://api.test") && JSON.stringify(c.body || {}).includes(MC.accessToken)).length, 0);
});

test("compte déjà lié à un autre personnage : jeu refusé", async () => {
  const { client } = fakeServers({ linkedTo: { uuid: "ffffffff-89ab-cdef-0123-456789abcdef", name: "Autre" } });
  await assert.rejects(ensureLinked(client, "tok", MC), /lié au joueur Autre/);
});

test("même personnage : rien à relier, solde renvoyé", async () => {
  const { client, calls } = fakeServers({ linkedTo: { uuid: MC.uuid.toUpperCase(), name: "Copassist" } });
  const data = await ensureLinked(client, "tok", MC);
  assert.equal(data.credits, 1200);
  assert.equal(calls.length, 1);
});

test("session expirée : statut 401 remonté", async () => {
  const { client } = fakeServers();
  await assert.rejects(ensureLinked(client, "perime", MC), error => error.status === 401);
});

test("mot de passe oublié : prouvé par le compte Microsoft", async () => {
  const { client } = fakeServers();
  const data = await client.resetPassword(MC, "nouveau-mot-de-passe");
  assert.equal(data.token, "tok2");
});
