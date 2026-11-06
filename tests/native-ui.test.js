'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const native = require('../ui/native');
const { createAdmin } = require('../ui/admin');
const { createBridge } = require('../ui/bridge');

// Contract serialization mirrors pluginHandler.prepExports function.toString().
// Uses production exports; no ignored research snapshot is required in CI.
function serializedUI() {
  const plugin = require('../meshtask2').meshtask2({ parent: { config: {} } });
  let source = 'function () { var obj = { meshtask2: {} };';
  for (const name of plugin.exports) source += 'obj.meshtask2.' + name + ' = ' + plugin[name].toString() + ';';
  source += 'obj.callHook = function (name, ...args) { for (const key of Object.keys(obj)) { if (obj[key] && typeof obj[key][name] === "function") obj[key][name].apply(this, args); } }; return obj; }';
  return source;
}

// Minimal DOM with no HTML parser: unsafe sinks are an immediate test failure.
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.children = []; this.parentNode = null; this.attributes = {}; this.listeners = new Map(); this._text = '';
  }
  set innerHTML(_) { throw new Error('HTML sink forbidden'); }
  set id(value) { this.setAttribute('id', value); }
  get id() { return this.getAttribute('id'); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children.forEach((child) => { child.parentNode = null; }); this.children = []; this._text = ''; children.forEach((child) => this.appendChild(child)); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; } }
  set textContent(text) { this.replaceChildren(); this._text = String(text); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set value(value) { this._value = String(value); }
  get value() { return this._value ?? (this.tagName === 'SELECT' ? this.children[0]?.value : this.getAttribute('value')) ?? ''; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener({ preventDefault() {} }); }
  focus() { this.ownerDocument.activeElement = this; }
}
const all = (node) => [node, ...node.children.flatMap(all)];
const plain = (value) => JSON.parse(JSON.stringify(value));
const admin = { _id: 'user/lab/admin', domain: 'lab', siteadmin: 0xFFFFFFFF };
function setup(t, { user = null, state = 2, page = true } = {}) {
  const document = { createElement: (tag) => new Element(tag, document), getElementById: (id) => all(document.body).find((node) => node.id === id) || null };
  document.body = document.createElement('body');
  if (page) { const p42 = document.createElement('div'); p42.id = 'p42'; document.body.appendChild(p42); }
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); }
  };
  const timers = new Map(); let id = 0;
  const sent = [], nativeCalls = [];
  const server = {
    State: state,
    send(message) { sent.push(plain(message)); },
    onMessage(source, message) {
      nativeCalls.push({ type: 'message', receiver: this, source, message });
      if (message.action === 'userinfo') context.userinfo = message.userinfo;
      if (message.action === 'event' && message.event?.action === 'accountchange' && message.event.account._id === context.userinfo?._id) context.userinfo = message.event.account;
      // default.handlebars's actual dispatch signature, including server argument.
      if (message.action === 'plugin') return context.pluginHandler[message.plugin][message.method](source, message);
      return 'host-message-result';
    },
    onStateChanged() { nativeCalls.push({ type: 'state', receiver: this, args: [...arguments] }); return 'host-state-result'; }
  };
  const originalMessage = server.onMessage, originalState = server.onStateChanged;
  const context = vm.createContext({ window, document, meshserver: server, userinfo: user, xxcurrentView: 1,
    crypto: { randomUUID: () => `request-fixture-${++id}` },
    setTimeout(callback) { const key = ++id; timers.set(key, callback); return key; },
    clearTimeout(key) { timers.delete(key); },
    go(page) { context.xxcurrentView = page; context.pluginHandler.callHook('goPageEnd', page); }
  });
  const builder = serializedUI();
  function reload() { vm.runInContext(`pluginHandler = (${builder})(); pluginHandler.callHook('onWebUIStartupEnd');`, context); }
  reload();
  t.after(() => { window.__meshtask2Native?.dispose(); assert.equal(timers.size, 0); });
  function deliver(message) { return server.onMessage(server, message); }
  function transition(next) { const prev = server.State; server.State = next; return server.onStateChanged(server, next, prev, 0); }
  function reply(request, result) { return deliver({ ...request, type: 'response', method: 'onMessage', ok: true, result }); }
  async function finishLoad() {
    for (const request of sent.slice(-4).reverse()) reply(request, request.op === 'status' ? { executionEnabled: false, version: 'fixture', reason: 'Blocked' } : []);
    await context.pluginHandler.meshtask2.view.ready;
  }
  return { context, window, document, server, sent, timers, listeners, nativeCalls, originalMessage, originalState, reload, deliver, transition, reply, finishLoad,
    host: () => context.pluginHandler.meshtask2, get: (id) => document.getElementById(id) };
}

test('production exports serialized under prepExports contract expose startup loader and native p42 button only after late admin userinfo', async (t) => {
  const f = setup(t);
  assert.equal(f.get('meshtask2-open'), null);
  assert.equal(f.sent.length, 0);
  assert.equal(f.deliver({ action: 'userinfo', userinfo: admin }), 'host-message-result');
  const button = f.get('meshtask2-open');
  assert.ok(button); assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.type, 'button');
  assert.equal(button.getAttribute('aria-controls'), 'meshtask2-admin');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.get('meshtask2-native').parentNode.id, 'p42');
  button.dispatch('click');
  assert.equal(f.context.xxcurrentView, 42);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(f.sent.map((request) => request.op).sort(), ['jobs.list', 'schedules.list', 'scripts.list', 'status']);
  assert.ok(f.sent.every((request) => request.action === 'plugin' && request.plugin === 'meshtask2' && request.version === 1 && request.routeToNode === undefined));
  await f.finishLoad();
  assert.match(f.get('meshtask2-admin').textContent, /Status e listas atualizados/);
  assert.equal(f.timers.size, 0);
  assert.equal(f.nativeCalls.length, 5, 'all responses must pass through existing host callback');
  assert.ok(f.nativeCalls.every((call) => call.receiver === f.server && call.source === f.server));
  button.dispatch('click');
  assert.equal(f.host().view, null);
  assert.equal(f.get('meshtask2-admin').hidden, true);
});

for (const rights of [0, 1, 8, 0xFFFFFFFE, -1, '4294967295', undefined]) {
  test(`non-admin rights ${rights}: no menu or direct open, even in Plugins page`, (t) => {
    const f = setup(t, { user: { ...admin, siteadmin: rights } });
    f.context.go(42);
    assert.equal(f.get('meshtask2-open'), null);
    assert.throws(() => f.host().openAdmin(), /Administrador/);
    assert.equal(f.sent.length, 0);
  });
}

test('revocation removes menu, clears pending bridge and prevents forged direct open', async (t) => {
  const f = setup(t, { user: admin });
  const view = f.host().openAdmin(), bridge = f.host().bridge;
  const pending = bridge.request('jobs.create');
  const rejected = assert.rejects(pending, /Conexão encerrada; resultado desconhecido/);
  f.deliver({ action: 'event', event: { action: 'accountchange', account: { ...admin, siteadmin: 8 } } });
  await rejected; await view.ready;
  assert.equal(f.get('meshtask2-native'), null);
  assert.equal(f.timers.size, 0);
  assert.throws(() => f.host().openAdmin(), /Administrador/);
  assert.equal(f.sent.length, 5);
});

test('disconnect closes bridge before host callback; reconnect waits for fresh identity without retries', async (t) => {
  const f = setup(t, { user: admin });
  const view = f.host().openAdmin();
  assert.equal(f.transition(0), 'host-state-result');
  await view.ready;
  assert.equal(f.timers.size, 0);
  assert.equal(f.get('meshtask2-open'), null);
  f.transition(2);
  assert.equal(f.get('meshtask2-open'), null, 'cached admin identity must not expose UI after reconnect');
  f.deliver({ action: 'userinfo', userinfo: admin });
  assert.ok(f.get('meshtask2-open'));
  assert.equal(f.sent.length, 4, 'no automatic reload, replay or mutation retry');
});

test('repeated startup and handler refresh dispose old UI and retain one callback chain', async (t) => {
  const f = setup(t, { user: admin });
  const oldHost = f.host(), view = oldHost.openAdmin();
  f.reload(); await view.ready;
  assert.equal(oldHost.view, null);
  assert.equal(f.timers.size, 0);
  assert.equal(all(f.document.body).filter((node) => node.id === 'meshtask2-open').length, 1);
  assert.equal(f.listeners.get('pagehide').size, 1);
  f.host().onWebUIStartupEnd();
  assert.equal(f.listeners.get('pagehide').size, 1);
  const before = f.nativeCalls.length;
  f.deliver({ action: 'userinfo', userinfo: admin });
  assert.equal(f.nativeCalls.length, before + 1);
  f.host().native.dispose();
  assert.equal(f.server.onMessage, f.originalMessage);
  assert.equal(f.server.onStateChanged, f.originalState);
});

test('leaving Plugins destroys view, rejects pending work, and ignores late responses', async (t) => {
  const f = setup(t, { user: admin });
  const view = f.host().openAdmin();
  f.context.go(1); await view.ready;
  assert.equal(f.host().view, null);
  assert.equal(f.timers.size, 0);
  for (const request of f.sent) assert.equal(f.reply(request, []), false);
  assert.equal(f.get('meshtask2-admin').children.length, 0);
  assert.equal(f.get('meshtask2-open').getAttribute('aria-expanded'), 'false');
});

test('foreign transport cannot settle pending native bridge requests', async (t) => {
  const f = setup(t, { user: admin });
  f.host().openAdmin();
  const request = f.sent[0];
  assert.equal(f.host().onMessage({}, { ...request, type: 'response', ok: true, result: {} }), false);
  assert.equal(f.timers.size, 4);
  await f.finishLoad();
});

test('missing native p42 and host navigation denial fail closed without body fallback', (t) => {
  const f = setup(t, { user: admin, page: false });
  assert.throws(() => f.host().openAdmin(), /indisponível/);
  assert.equal(f.document.body.children.length, 0);
  const g = setup(t, { user: admin });
  g.context.go = () => { g.context.xxcurrentView = 2; };
  assert.throws(() => g.host().openAdmin(), /não foi autorizada/);
  assert.equal(g.sent.length, 0);
  assert.equal(g.host().bridge, undefined);
});

test('pagehide removes UI and timers without clobbering callbacks installed later', async (t) => {
  const f = setup(t, { user: admin });
  const view = f.host().openAdmin();
  const laterCallback = () => {};
  f.server.onMessage = laterCallback;
  for (const listener of [...f.listeners.get('pagehide')]) listener();
  await view.ready;
  assert.equal(f.server.onMessage, laterCallback);
  assert.equal(f.server.onStateChanged, f.originalState);
  assert.equal(f.get('meshtask2-native'), null);
  assert.equal(f.listeners.get('pagehide').size, 0);
});
