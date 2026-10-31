const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function loadMain(primary = true) {
  const ipc = {}, events = {}, children = []; let syncs = 0, quits = 0, authCalls = 0;
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const config = JSON.stringify({ mods: [], minecraftVersion: "26.3", neoforgeVersion: "test", manifestUrl: "https://fixture.test/manifest" });
  const app = { getPath: () => "/fixture", getVersion: () => "1.3.3", requestSingleInstanceLock: () => primary, quit: () => quits++, whenReady: () => new Promise(() => {}), on: (name, cb) => { events[name] = cb; } };
  const fakeFs = { ...fs, readFileSync: file => String(file).endsWith("launcher-config.json") ? config : String(file).endsWith("launcher-settings.json") ? '{}' : (() => { throw Error("no cache"); })(), mkdirSync: () => {}, writeFileSync: () => {}, existsSync: () => false, readdirSync: () => [] };
  const fakeGame = { download: async () => {}, valid: () => false, Game: class {
    async prepare() { syncs++; await gate; }
    launch() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child); return child; }
  } };
  const mc = { profile: { name: "Test" }, mclc: () => ({ name: "Test", uuid: "test", access_token: "test", meta: {} }) };
  const ctx = vm.createContext({ require: name => name === "electron" ? { app, ipcMain: { handle: (name, cb) => { ipc[name] = cb; } }, shell: {}, BrowserWindow: class {} }
    : name === "./logger" ? { createLogger: () => ({ file: "/f", dir: "/d", info() {}, warn() {}, error() {}, text: () => "" }) } : name === "./discord" ? { Presence: class { start() {} setActive() {} stop() {} }, DEFAULT_APP_ID: "x" } : name === "fs" ? fakeFs : name === "./updates" ? require("../src/updates") : name === "./game" ? fakeGame : name === "msmc" ? { Auth: class { async launch() { authCalls++; return { getMinecraft: async () => mc, save: () => "token" }; } async refresh() { return { getMinecraft: async () => mc, save: () => "token" }; } } } : require(name),
    __dirname: path.join(__dirname, "../src"), console: { log() {}, warn() {}, error() {} }, process, Buffer, setTimeout: () => {}, fetch: async () => ({ ok: true, text: async () => JSON.stringify({ mods: [], minecraft: "26.3" }) }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8"), ctx);
  return { ctx, ipc, events, children, unblock, syncs: () => syncs, quits: () => quits, authCalls: () => authCalls };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("only one preparation/game can run, and a finished game can be relaunched", async () => {
  const main = loadMain();
  main.ipc.play(); main.ipc.play(); await flush();
  assert.equal(main.authCalls(), 1); assert.equal(main.syncs(), 1);
  main.unblock(); await flush(); await flush(); assert.equal(main.children.length, 1);
  main.ipc.play(); await flush(); assert.equal(main.children.length, 1);
  main.children[0].emit("close", 0); main.ipc.play(); await flush(); await flush();
  assert.equal(main.children.length, 2);
});
test("a second launcher process quits before opening another window", () => {
  const main = loadMain(false); assert.equal(main.quits(), 1); assert.equal(main.syncs(), 0);
});
test("public game version remains 0.0 independently from Minecraft and installer versions", async () => {
  const main=loadMain();const config=await main.ipc["get-config"]();
  assert.equal(config.gameVersion,"0.0");assert.equal(config.minecraftVersion,"26.3");assert.equal(config.launcherVersion,"1.3.3");
});


test("launcher update installs silently and relaunches only when ready and idle", () => {
  const main=loadMain(),calls=[];main.ctx.recordInstall=(...args)=>calls.push(args);
  vm.runInContext("updater={quitAndInstall:recordInstall}",main.ctx);
  assert.equal(main.ipc["install-launcher-update"](),false);
  vm.runInContext("launcherDownloaded=true",main.ctx);
  for(const flag of ["activeGame","launching","updating"]){
    vm.runInContext(flag+"=true",main.ctx);
    assert.equal(main.ipc["install-launcher-update"](),false);
    vm.runInContext(flag+"=false",main.ctx);
  }
  assert.deepEqual(calls,[]);
  assert.equal(main.ipc["install-launcher-update"](),true);
  assert.deepEqual(calls,[[true,true]]);
});


test("Play downloads and silently installs an available launcher before touching Minecraft", async () => {
  const main=loadMain(),calls=[];main.ctx.record=(...args)=>calls.push(args);
  vm.runInContext(`updater={
    async checkForUpdates(){launcherUpdate=true;record("check");},
    async downloadUpdate(){record("download");launcherDownloaded=true;},
    quitAndInstall(...args){record("install",...args);}
  }`,main.ctx);
  main.ipc.play();main.ipc.play();await flush();await flush();
  assert.deepEqual(calls,[["check"],["download"],["install",true,true]]);
  assert.equal(main.authCalls(),0);assert.equal(main.syncs(),0);assert.equal(main.children.length,0);
  assert.equal(vm.runInContext("settings.playAfterUpdate.fromVersion",main.ctx),"1.3.3");
  main.ipc.play();await flush();assert.equal(calls.length,3);
});

test("a failed launcher download blocks Minecraft and allows retry", async () => {
  const main=loadMain();
  vm.runInContext(`updater={async checkForUpdates(){launcherUpdate=true;},async downloadUpdate(){throw Error("offline");}}`,main.ctx);
  main.ipc.play();await flush();await flush();
  assert.equal(main.authCalls(),0);assert.equal(main.syncs(),0);
  assert.equal(vm.runInContext("updating||launching||installingLauncher",main.ctx),false);
  assert.equal(vm.runInContext("updateStatus.busy",main.ctx),false);
  assert.equal(vm.runInContext("settings.playAfterUpdate",main.ctx),undefined);
});

test("up-to-date launcher continues through the usual single game launch", async () => {
  const main=loadMain();vm.runInContext("updater={async checkForUpdates(){}}",main.ctx);
  main.ipc.play();await flush();main.unblock();await flush();await flush();
  assert.equal(main.authCalls(),1);assert.equal(main.children.length,1);
});

test("launch continuation is consumed once and refuses unchanged or expired versions", () => {
  for(const [fromVersion,expiresAt,expected] of [["1.3.2",Date.now()+60000,true],["1.3.3",Date.now()+60000,false],["1.3.2",Date.now()-1,false]]){
    const main=loadMain();main.ctx.ticket={fromVersion,expiresAt};
    vm.runInContext("settings.playAfterUpdate=ticket",main.ctx);
    assert.equal(vm.runInContext("consumePlayAfterUpdate()",main.ctx),expected);
    assert.equal(vm.runInContext("consumePlayAfterUpdate()",main.ctx),false);
  }
});


test("community links can be updated through the game manifest", async () => {
  const main=loadMain();
  vm.runInContext(`applyManifest({mods:[],links:{discord:"https://discord.gg/fixture",website:"https://fixture.test"}})`,main.ctx);
  const config=await main.ipc["get-config"]();
  assert.equal(config.links.discord,"https://discord.gg/fixture");
  assert.equal(config.links.website,"https://fixture.test");
});
