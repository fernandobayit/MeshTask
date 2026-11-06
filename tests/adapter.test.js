'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { AdminAPI } = require('../lib/api');
const mesh = require('../lib/meshcentral');
const { meshtask2 } = require('../meshtask2');
const { fixture, actor, scriptInput, temp } = require('./helpers');
function host() {
  const user = { _id: actor.id, domain: actor.domain, siteadmin: 0xFFFFFFFF };
  const domain = { id: actor.domain };
  const replies = [];
  const ws = { sessionId: 'session-lab', send: (text) => replies.push(JSON.parse(text)) };
  const session = { user, domain, ws };
  const root = { config: { domains: { lab: domain }, settings: {} } };
  const webserver = { parent: root, users: { [user._id]: user }, wsagents: {}, wssessions2: { [ws.sessionId]: ws }, GetNodeWithRights: (d, u, id, callback) => callback({ _id: id, domain: d.id }, 0xFFFFFFFF, true) };
  root.webserver = webserver;
  return { root, webserver, session, replies, user };
}
function request(op, input = {}, extra = {}) { return { action: 'plugin', plugin: 'meshtask2', version: 1, type: 'request', requestId: 'request-1', op, input, ...extra }; }

test('admin API uses real session, ignores forged userid/domain and creates frozen job via node ACL', async (t) => {
  const f = fixture(t), h = host(), api = new AdminAPI(f.service, h.webserver);
  const result = await api.request(h.session, request('jobs.create', f.input, { userid: 'user/other/admin', domain: 'other' }));
  assert.equal(result.executionBlocked, true);
  assert.equal(f.service.job(actor, result.id).job.domain, 'lab');
  assert.equal((await api.request(h.session, request('status'))).executionEnabled, false);
});

test('admin API rejects non-admin/deleted/stale/unregistered sessions and direct-route envelope', async (t) => {
  const f = fixture(t), h = host(), api = new AdminAPI(f.service, h.webserver);
  h.user.siteadmin = 1;
  await assert.rejects(api.request(h.session, request('scripts.list')), /Administrador/);
  h.user.siteadmin = 0xFFFFFFFF;
  await assert.rejects(api.request(h.session, request('scripts.list', {}, { routeToNode: true })), /inválido/);
  delete h.webserver.wssessions2[h.session.ws.sessionId];
  await assert.rejects(api.request(h.session, request('scripts.list')), /registrada/);
  h.webserver.wssessions2[h.session.ws.sessionId] = h.session.ws; delete h.webserver.users[actor.id];
  await assert.rejects(api.request(h.session, request('scripts.list')), /Administrador/);
});

test('ACL mismatches, missing runtime APIs, revoked rights and session close fail closed', async (t) => {
  const f = fixture(t), h = host(), api = new AdminAPI(f.service, h.webserver);
  for (const value of [null, { _id: 'node/lab/wrong', domain: 'lab' }, { _id: 'node/lab/one', domain: 'other' }]) {
    h.webserver.GetNodeWithRights = (d, u, id, callback) => callback(value, 0xFFFFFFFF, true);
    await assert.rejects(api.request(h.session, request('jobs.create', f.input)));
  }
  h.webserver.GetNodeWithRights = (d, u, id, callback) => callback({ _id: id, domain: d.id }, 8, true);
  await assert.rejects(api.request(h.session, request('jobs.create', f.input)), /autorizado/);
  h.webserver.GetNodeWithRights = undefined;
  await assert.rejects(api.request(h.session, request('jobs.create', f.input)), /indisponível/);
  h.webserver.GetNodeWithRights = (d, u, id, callback) => { delete h.webserver.wssessions2[h.session.ws.sessionId]; callback({ _id: id, domain: d.id }, 0xFFFFFFFF, true); };
  await assert.rejects(api.request(h.session, request('jobs.create', f.input)), /registrada/);
  assert.equal(f.service.jobs(actor).length, 1);
});

test('ACL lookup timeout rejects, never falls back to trusting node prefix', async () => {
  const h = host(); h.webserver.GetNodeWithRights = () => {};
  await assert.rejects(mesh.authorize(h.webserver, actor, ['node/lab/one'], 5), /expirou/);
});

test('agent identity comes exclusively from registered authenticated connection', () => {
  const h = host(), conn = { authenticated: 2, dbNodeKey: 'node/lab/one', domain: { id: 'lab' } };
  assert.throws(() => mesh.agentIdentity(conn, h.webserver), /registrado/);
  h.webserver.wsagents[conn.dbNodeKey] = conn;
  assert.deepEqual(mesh.agentIdentity(conn, h.webserver), { domain: 'lab', node: 'node/lab/one' });
  assert.throws(() => mesh.agentIdentity({ ...conn }, h.webserver), /registrado/);
  conn.authenticated = 1; assert.throws(() => mesh.agentIdentity(conn, h.webserver), /registrado/);
  conn.authenticated = 2; conn.domain.id = 'other'; assert.throws(() => mesh.agentIdentity(conn, h.webserver), /domínio/);
});

test('default transport refuses execute without enabled mode/pull; query has no execution semantics', async () => {
  const h = host(); let sent;
  const conn = { authenticated: 2, dbNodeKey: 'node/lab/one', domain: { id: 'lab' }, send: (message, callback) => { sent = JSON.parse(message); callback(); } };
  h.webserver.wsagents[conn.dbNodeKey] = conn;
  const transport = mesh.transport(h.webserver);
  assert.equal(transport.canSend('lab', conn.dbNodeKey, 'bash'), false);
  await assert.rejects(transport.send('lab', conn.dbNodeKey, { type: 'execute' }), /pull ativo/);
  await transport.send('lab', conn.dbNodeKey, { type: 'query' }); assert.equal(sent.type, 'query');
});

test('plugin startup is explicit/idempotent; reload closes prior DB; replies use calling session correlation', async (t) => {
  const h = host(), file = temp(t), handler = { parent: h.root, plugins: {} };
  h.root.config.settings.meshtask2 = { database: file };
  const p = meshtask2(handler); t.after(() => p.close());
  assert.equal(fs.existsSync(file), false, 'factory must not open DB');
  handler.plugins.meshtask2 = p;
  await p.server_startup(); await p.server_startup();
  assert.equal(await p.serveraction(request('scripts.save', scriptInput), h.session, h.webserver), true);
  assert.equal(h.replies[0].requestId, 'request-1'); assert.equal(h.replies[0].op, 'scripts.save'); assert.equal(h.replies[0].ok, true);
  const replacement = meshtask2(handler); t.after(() => replacement.close()); handler.plugins.meshtask2 = replacement; await replacement.server_startup();
  await assert.rejects(p.tick(), /iniciado/);
  assert.deepEqual(await replacement.tick(), []);
  assert.equal(await replacement.serveraction(request('scripts.list'), h.session, h.webserver), true);
  assert.equal(h.replies[1].result.length, 1);
  assert.equal(await replacement.serveraction(request('jobs.create', { ...scriptInput }), h.session, h.webserver), false);
  assert.equal(h.replies[2].ok, false); assert.equal(h.replies[2].error.code, 'INVALID');
  assert.equal(h.replies[2].error.message.includes('SELECT'), false);
});

test('plugin rejects unknown host/user messages disguised as agent results; no unauthorized leak', async (t) => {
  const h = host(), handler = { parent: h.root, plugins: {} }, p = meshtask2(handler); handler.plugins.meshtask2 = p; t.after(() => p.close());
  h.root.config.settings.meshtask2 = { database: temp(t) }; await p.server_startup();
  assert.equal(await p.serveraction(request('status'), h.session, {}), false);
  // Response may be refused, but cannot return privileged data on a foreign host.
  assert.equal(h.replies.length, 0);
  h.user.siteadmin = 0;
  assert.equal(await p.serveraction(request('scripts.list'), h.session, h.webserver), false); assert.equal(h.replies.length, 0);
  assert.equal(await p.serveraction({ ...request('status'), type: 'result', exitCode: 0 }, h.session, h.webserver), false);
});

test('startup without private explicit DB fails closed; exported browser functions are standalone', () => {
  const h = host(), p = meshtask2({ parent: h.root });
  assert.throws(() => p.server_startup(), /Configure/);
  for (const name of p.exports) assert.equal(typeof vm.runInNewContext('(' + p[name].toString() + ')'), 'function');
});

test('agent module refuses untrusted routes even with runtime unavailable', () => {
  const source = fs.readFileSync(require.resolve('../modules_meshcore/meshtask2'), 'utf8');
  const sandbox = { module: { exports: {} }, require: () => { throw new Error('No runtime access allowed'); } };
  vm.runInNewContext(source, sandbox);
  for (const cmd of [{ plugin: 'meshtask2', version: 1, type: 'execute', context: 'service' }, { plugin: 'meshtask2', version: 1, type: 'execute', routeToNode: true }, { _: ['meshtask2'] }, null]) {
    assert.match(sandbox.module.exports.consoleaction(cmd), /recusada/);
  }
});

test('administrative mutation replay is durable, atomic and bound to actor/domain/content', async (t) => {
  const file = temp(t), f = fixture(t, file), h = host(), api = new AdminAPI(f.service, h.webserver);
  const cmd = request('jobs.create', f.input, { requestId: 'durable-request' });
  const [first, duplicate] = await Promise.all([api.request(h.session, cmd), api.request(h.session, cmd)]);
  assert.equal(first.id, duplicate.id);
  await assert.rejects(api.request(h.session, { ...cmd, input: { ...f.input, targets: ['node/lab/two'] } }), /reutilizado/);
  assert.equal(f.service.jobs(actor).length, 2);
  f.store.close();
  const { Store } = require('../lib/store'), { Service } = require('../lib/service');
  const reopened = new Store(file); t.after(() => reopened.close());
  const api2 = new AdminAPI(new Service(reopened), h.webserver);
  assert.equal((await api2.request(h.session, cmd)).id, first.id);
});

test('idempotency ledger persistence failure rolls back entire mutation', async (t) => {
  const f = fixture(t), h = host(), api = new AdminAPI(f.service, h.webserver);
  f.store.db.exec("CREATE TRIGGER fail_request BEFORE INSERT ON admin_requests BEGIN SELECT RAISE(ABORT,'request disk error'); END;");
  await assert.rejects(api.request(h.session, request('jobs.create', f.input)), /request disk error/);
  assert.equal(f.service.jobs(actor).length, 1);
});

test('upstream WebUI callback signature is onMessage(server,message)', () => {
  const p = meshtask2({ parent: host().root }); let received;
  const context = { pluginHandler: { meshtask2: { native: { receive: (server, message) => { received = message; } } } } };
  const fn = vm.runInNewContext('(' + p.onMessage.toString() + ')', context);
  const message = { requestId: 'request-1' };
  fn({ transport: true }, message); assert.equal(received, message);
});
