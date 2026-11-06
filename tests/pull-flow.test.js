'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mesh = require('../lib/meshcentral');
const { meshtask2 } = require('../meshtask2');
const { fixture, actor, temp, scriptInput, identity } = require('./helpers');
const { harness } = require('./agent-harness');
const { Store } = require('../lib/store');
function link(t, options = {}) {
  const f = fixture(t), webserver = { wsagents: {} }, delivered = [];
  const connection = { authenticated: 2, dbNodeKey: identity.node, domain: { id: identity.domain }, send(text, callback) {
    const message = JSON.parse(text); delivered.push(message);
    if (message.type === 'execute') {
      const state = f.store.get('SELECT * FROM attempts WHERE id=?', message.attemptId);
      assert.ok(state, 'intent durable before delivery');
      const event = f.store.get("SELECT data FROM events WHERE attempt_id=? AND type='dispatch_claimed'", message.attemptId);
      assert.equal(JSON.parse(event.data).bootNonce, message.bootNonce); assert.equal(JSON.parse(event.data).requestNonce, message.requestNonce);
      assert.match(JSON.parse(event.data).payloadHash, /^[a-f0-9]{64}$/);
    }
    agent.act(message); callback(options.ambiguous && message.type === 'execute' ? new Error('ambiguous') : null);
  } };
  webserver.wsagents[identity.node] = connection;
  const transport = mesh.transport(webserver, { enabled: true, clock: f.clock });
  const agent = harness({ onSend(message) {
    if (message.type === 'pull' || message.type === 'capability') transport.register(connection, message);
    else if (options.receive !== false) f.dispatcher.receive(identity, message);
  } });
  f.dispatcher.transport = transport;
  return { ...f, transport, webserver, connection, agent, delivered };
}

test('registered pull -> durable intent/binding -> VM spawn -> late result; timeout never grants again', async (t) => {
  const f = link(t);
  assert.equal(await f.dispatcher.dispatch(), 0); assert.equal(f.agent.children.length, 0);
  f.advance(5001); await f.transport.poll(); assert.equal(await f.dispatcher.dispatch(), 1);
  const child = f.agent.children[0]; assert.ok(child); assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'acknowledged');
  f.advance(101); f.dispatcher.expire(); assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'unknown');
  await f.transport.poll(); await f.dispatcher.dispatch(); assert.equal(f.agent.children.length, 1);
  child.stdout.emit('data', Buffer.from('late')); child.emit('exit', 0);
  const view = f.service.job(actor, f.job.id); assert.equal(view.job.status, 'succeeded'); assert.equal(view.attempts[0].result.stdout, 'late');
  assert.equal(view.events.find((e) => e.type === 'result').data.late, true);
});

test('SQLite audit failure prevents grant; retry after rollback can consume only once', async (t) => {
  const f = link(t); await f.transport.poll();
  f.store.db.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON events WHEN NEW.type='dispatch_claimed' BEGIN SELECT RAISE(ABORT,'disk unavailable'); END;");
  await assert.rejects(f.dispatcher.dispatch(), /disk unavailable/); assert.equal(f.agent.children.length, 0); assert.equal(f.store.get('SELECT COUNT(*) n FROM attempts').n, 0);
  f.store.db.exec('DROP TRIGGER fail_grant'); await f.dispatcher.dispatch(); await f.dispatcher.dispatch(); assert.equal(f.agent.children.length, 1);
});

test('send ambiguity after actual spawn never restores pull or attempt; late result reconciles', async (t) => {
  const f = link(t, { ambiguous: true }); await f.transport.poll(); assert.equal(await f.dispatcher.dispatch(), 0);
  assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'unknown');
  const oldPull = f.agent.sent.find((m) => m.type === 'pull'); assert.equal(f.transport.register(f.connection, oldPull), false);
  await f.dispatcher.dispatch(); assert.equal(f.agent.children.length, 1); f.agent.children[0].emit('exit', 4);
  assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'failed');
});

test('authenticated connection binding, nonce TTL, schema and capability checks are enforced', async (t) => {
  const f = link(t); await f.transport.poll(); const pull = f.agent.sent.at(-1);
  assert.equal(f.transport.canSend('lab', identity.node, 'bash'), true);
  assert.equal(f.transport.canSend('other', identity.node, 'bash'), false); assert.equal(f.transport.canSend('lab', identity.node, 'powershell'), false);
  assert.throws(() => f.transport.register({ ...f.connection }, pull), /registrado/);
  for (const change of [{ version: 2 }, { node: identity.node }, { requestNonce: 1 }, { engines: ['cmd'] }]) assert.throws(() => f.transport.register(f.connection, { ...pull, ...change }));
  f.advance(10001); assert.equal(f.transport.canSend('lab', identity.node, 'bash'), false);
  assert.equal(f.transport.register(f.connection, pull), false); assert.equal(f.transport.canSend('lab', identity.node, 'bash'), false, 'repeat cannot refresh TTL');
  f.webserver.wsagents[identity.node] = { ...f.connection }; assert.equal(f.transport.canSend('lab', identity.node, 'bash'), false);
});

function host(t, executionMode = 'direct-control-v1') {
  const file = temp(t), user = { _id: actor.id, domain: 'lab', siteadmin: 0xFFFFFFFF }, domain = { id: 'lab' }, replies = [];
  const ws = { sessionId: 'test-session', send: (text) => replies.push(JSON.parse(text)) };
  const root = { config: { domains: { lab: domain }, settings: { meshtask2: { database: file, executionMode, intervalMs: 100 } } } };
  const webserver = root.webserver = { parent: root, users: { [user._id]: user }, wsagents: {}, wssessions2: { [ws.sessionId]: ws }, GetNodeWithRights: (d, u, id, callback) => callback({ _id: id, domain: d.id }, 0xFFFFFFFF, true) };
  const handler = { parent: root, plugins: {} }, plugin = meshtask2(handler); handler.plugins.meshtask2 = plugin;
  t.after(() => plugin.close());
  let serial = 0;
  async function request(op, input = {}) {
    const requestId = 'integration-' + (++serial);
    const ok = await plugin.serveraction({ action: 'plugin', plugin: 'meshtask2', version: 1, type: 'request', requestId, op, input }, { user, domain, ws }, webserver);
    const reply = replies.find((r) => r.requestId === requestId); assert.equal(ok, true, JSON.stringify(reply)); return reply.result;
  }
  return { root, webserver, handler, plugin, request, file };
}

test('production plugin automatic timer materializes schedule and dispatches to VM, persists result before receipt', async (t) => {
  const h = host(t); await h.plugin.server_startup();
  const script = await h.request('scripts.save', scriptInput);
  await h.request('schedules.create', { scriptId: script.id, revision: 1, targets: [identity.node], context: 'service', kind: 'once', at: new Date(Date.now() - 1000).toISOString() });
  let agent, spawned;
  const ready = new Promise((resolve) => { spawned = resolve; });
  const connection = { authenticated: 2, dbNodeKey: identity.node, domain: { id: 'lab' }, send(text, callback) {
    const command = JSON.parse(text);
    if (command.type === 'receipt') {
      const db = new Store(h.file); try { assert.equal(db.get('SELECT state FROM attempts WHERE id=?', command.attemptId).state, 'succeeded'); } finally { db.close(); }
    }
    agent.act(command); if (command.type === 'execute') spawned(); callback();
  } };
  h.webserver.wsagents[identity.node] = connection;
  const responses = [];
  agent = harness({ onSend: (message) => { responses.push(h.plugin.serveraction(message, connection, h.webserver)); } });
  const timer = setTimeout(() => spawned(), 2500); await ready; clearTimeout(timer);
  assert.equal(agent.children.length, 1, 'automatic timer, no manual tick');
  agent.children[0].emit('exit', 0); await Promise.all(responses);
  const jobs = await h.request('jobs.list'); assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'succeeded');
  assert.equal((await h.request('status')).scheduler, 'automatic-single-flight'); assert.equal((await h.request('status')).executionEnabled, true);
  await h.plugin.close(); await assert.rejects(h.plugin.tick(), /encerrando/);
});

test('disable during ACL await prevents claim/send and drains before DB closure; reload can start safely', async (t) => {
  const h = host(t); await h.plugin.server_startup();
  const script = await h.request('scripts.save', scriptInput);
  await h.request('jobs.create', { scriptId: script.id, revision: 1, targets: [identity.node], context: 'service' });
  let release, waiting; const paused = new Promise((resolve) => { waiting = resolve; });
  h.webserver.GetNodeWithRights = (d, u, id, callback) => { release = () => callback({ _id: id, domain: d.id }, 0xFFFFFFFF, true); waiting(); };
  const flight = h.plugin.tick(); await paused;
  delete h.handler.plugins.meshtask2;
  const stop = h.plugin.close(); release(); await flight; await stop;
  const db = new Store(h.file); assert.equal(db.get('SELECT COUNT(*) n FROM attempts').n, 0); db.close();
  const replacement = meshtask2(h.handler); h.handler.plugins.meshtask2 = replacement; await replacement.server_startup(); await replacement.close();
});

test('unsupported execution mode and peer topology fail closed, without opening DB', (t) => {
  const h = host(t, 'unsafe'); assert.throws(() => h.plugin.server_startup(), /Modo/);
  h.root.config.settings.meshtask2.executionMode = 'direct-control-v1'; h.root.multiServer = {};
  assert.throws(() => h.plugin.server_startup(), /servidor único/);
});
