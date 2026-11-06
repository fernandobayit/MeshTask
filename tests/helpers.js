'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { Service } = require('../lib/service');
const { Dispatcher } = require('../lib/dispatcher');
const actor = { id: 'user/lab/admin', domain: 'lab', admin: true, allowedNodes: ['node/lab/one', 'node/lab/two'] };
const scriptInput = { name: 'Script de teste', engine: 'bash', body: 'printf "Olá\\n"', context: 'service' };
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshtask2-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.sqlite');
}
function fixture(t, filename = ':memory:') {
  const store = new Store(filename); t.after(() => { try { store.close(); } catch {} });
  let time = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => time;
  const service = new Service(store, { clock });
  const sent = [];
  const transport = { canSend: () => true, send: async (domain, node, message) => { sent.push({ domain, node, message }); } };
  const authorize = async (id, domain, nodes) => ({ id, domain, admin: true, allowedNodes: nodes });
  const dispatcher = new Dispatcher(store, { transport, authorize, clock, timeoutMs: 100 });
  const script = service.saveScript(actor, scriptInput);
  const input = { scriptId: script.id, revision: script.revision, targets: ['node/lab/one'], context: 'service' };
  const job = service.createJob(actor, input);
  return { store, service, dispatcher, transport, sent, clock, advance: (delta) => { time += delta; }, script, input, job, authorize };
}
function reply(f, overrides = {}) {
  const message = f.sent[0].message;
  return { action: 'plugin', plugin: 'meshtask2', version: 1, type: 'result', jobId: message.jobId, attemptId: message.attemptId, token: message.token, outcome: 'completed', exitCode: 0, stdout: 'Olá', stderr: '', truncated: false, ...overrides };
}
const identity = { domain: 'lab', node: 'node/lab/one' };
module.exports = { temp, fixture, reply, actor, scriptInput, identity };
