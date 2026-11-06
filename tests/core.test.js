'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../lib/store');
const { Service } = require('../lib/service');
const { Dispatcher } = require('../lib/dispatcher');
const { fixture, reply, actor, scriptInput, identity, temp } = require('./helpers');

test('job freezes script body/revision/targets; revisions and audit are immutable', async (t) => {
  const f = fixture(t);
  f.service.saveScript(actor, { ...scriptInput, id: f.script.id, body: 'exit 7', name: 'Revisado' });
  f.input.targets.push('node/lab/two');
  await f.dispatcher.dispatch();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.script.body, scriptInput.body);
  assert.equal(f.sent[0].message.script.revision, 1);
  assert.deepEqual(f.service.job(actor, f.job.id).job.targets, ['node/lab/one']);
  assert.equal(f.sent[0].message.script.targets, undefined);
  assert.throws(() => f.store.run("UPDATE revisions SET body='alterado'"), /immutable/);
  assert.throws(() => f.store.run("DELETE FROM events"), /immutable/);
  assert.throws(() => f.store.run("UPDATE jobs SET snapshot='{}'"), /immutable/);
});

test('concurrent dispatch calls claim once before send, even across SQLite connections', async (t) => {
  const filename = temp(t), f = fixture(t, filename), otherStore = new Store(filename);
  t.after(() => otherStore.close());
  const second = new Dispatcher(otherStore, { transport: f.transport, authorize: f.authorize, clock: f.clock });
  f.transport.send = async (domain, node, message) => {
    assert.equal(otherStore.get('SELECT state FROM attempts WHERE id=?', message.attemptId).state, 'claimed');
    assert.equal(otherStore.get("SELECT COUNT(*) AS n FROM events WHERE type='dispatch_claimed'").n, 1);
    f.sent.push(message);
  };
  await Promise.all([f.dispatcher.dispatch(), second.dispatch(), f.dispatcher.dispatch()]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM attempts').n, 1);
});

test('persistence error in claim audit rolls transaction back; nothing sent', async (t) => {
  const f = fixture(t);
  f.store.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON events WHEN NEW.type='dispatch_claimed' BEGIN SELECT RAISE(ABORT,'injected disk error'); END;");
  await assert.rejects(f.dispatcher.dispatch(), /injected disk error/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM attempts').n, 0);
});

test('send throws after intent commit: unknown, no blind resend, late result accepted', async (t) => {
  const f = fixture(t);
  f.transport.send = async (domain, node, message) => { f.sent.push({ message }); throw new Error('network'); };
  assert.equal(await f.dispatcher.dispatch(), 0);
  assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'unknown');
  await f.dispatcher.dispatch(); assert.equal(f.sent.length, 1);
  f.dispatcher.receive(identity, reply(f));
  assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'succeeded');
  assert.deepEqual(f.service.job(actor, f.job.id).events.map((e) => e.type), ['created', 'dispatch_claimed', 'send_ambiguous', 'result']);
});

test('ACK is not success; repeated ACK is idempotent', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch();
  f.dispatcher.receive(identity, reply(f, { type: 'ack' }));
  f.dispatcher.receive(identity, reply(f, { type: 'ack' }));
  const state = f.service.job(actor, f.job.id);
  assert.equal(state.attempts[0].state, 'acknowledged');
  assert.equal(state.job.status, 'in_progress');
  assert.equal(state.events.filter((e) => e.type === 'ack').length, 1);
});

test('out-of-order result then ACK and status never regress completed state', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch();
  f.dispatcher.receive(identity, reply(f));
  f.dispatcher.receive(identity, reply(f, { type: 'ack' }));
  f.dispatcher.receive(identity, reply(f, { type: 'status', state: 'not_found' }));
  assert.equal(f.service.job(actor, f.job.id).job.status, 'succeeded');
});

test('identical results deduplicate; conflicting result audited without overwriting original', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch();
  f.dispatcher.receive(identity, reply(f));
  assert.equal(f.dispatcher.receive(identity, reply(f)).duplicate, true);
  assert.equal(f.dispatcher.receive(identity, reply(f, { exitCode: 7 })).conflict, true);
  assert.equal(f.dispatcher.receive(identity, reply(f, { exitCode: 7 })).conflict, true);
  const state = f.service.job(actor, f.job.id);
  assert.equal(state.attempts[0].result.exitCode, 0);
  assert.equal(state.events.filter((e) => e.type === 'result').length, 1);
  assert.equal(state.events.filter((e) => e.type === 'result_conflict').length, 1);
});

test('timeout marks unknown without cancellation; late ACK stays unknown; late result reconciles', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch(); f.advance(101);
  assert.equal(f.dispatcher.expire(), 1); assert.equal(f.dispatcher.expire(), 0);
  assert.equal(f.sent.length, 1);
  f.dispatcher.receive(identity, reply(f, { type: 'ack' }));
  assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'unknown');
  f.dispatcher.receive(identity, reply(f, { exitCode: 7, stderr: 'erro' }));
  const state = f.service.job(actor, f.job.id);
  assert.equal(state.job.status, 'failed');
  assert.ok(state.events.some((e) => e.type === 'timeout'));
  assert.equal(state.events.find((e) => e.type === 'result').data.late, true);
});

test('stderr with zero exit is preserved, not treated as failure', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch();
  f.dispatcher.receive(identity, reply(f, { stderr: 'aviso' }));
  assert.equal(f.service.job(actor, f.job.id).job.status, 'succeeded');
  assert.equal(f.service.job(actor, f.job.id).attempts[0].result.stderr, 'aviso');
});

test('explicit runtime rejection is never success', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch();
  f.dispatcher.receive(identity, reply(f, { outcome: 'rejected', reason: 'interpreter_unavailable', exitCode: null }));
  assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'rejected');
  assert.equal(f.service.job(actor, f.job.id).job.status, 'failed');
});

test('restart reloads intent, marks unknown, queries same attempt without script or resend', async (t) => {
  const filename = temp(t), f = fixture(t, filename); await f.dispatcher.dispatch(); f.store.close();
  const store = new Store(filename); t.after(() => store.close());
  const dispatcher = new Dispatcher(store, { transport: f.transport, authorize: f.authorize, clock: f.clock });
  assert.equal(dispatcher.recover(), 1); assert.equal(dispatcher.recover(), 0);
  await dispatcher.dispatch(); assert.equal(f.sent.length, 1);
  await dispatcher.reconcile(f.sent[0].message.attemptId);
  assert.equal(f.sent[1].message.type, 'query');
  assert.equal(f.sent[1].message.script, undefined);
  assert.equal(f.sent[1].message.attemptId, f.sent[0].message.attemptId);
  dispatcher.receive(identity, reply(f));
  assert.equal(new Service(store).job(actor, f.job.id).job.status, 'succeeded');
});

test('disconnect and not_found status do not recreate attempt or auto execute', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch();
  f.dispatcher.disconnect(identity);
  f.dispatcher.receive(identity, reply(f, { type: 'status', state: 'not_found' }));
  await f.dispatcher.dispatch(); assert.equal(f.sent.length, 1);
  assert.equal(f.service.job(actor, f.job.id).job.status, 'unknown');
});

test('offline/capability missing stays queued without attempt or success', async (t) => {
  const f = fixture(t); f.transport.canSend = () => false;
  assert.equal(await f.dispatcher.dispatch(), 0);
  assert.equal(f.service.job(actor, f.job.id).job.status, 'queued');
  assert.deepEqual(f.service.job(actor, f.job.id).attempts, []);
});

test('result persistence failure is atomic; retry of exact result can commit later', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch();
  f.store.db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON events WHEN NEW.type='result' BEGIN SELECT RAISE(ABORT,'disk'); END;");
  assert.throws(() => f.dispatcher.receive(identity, reply(f)), /disk/);
  assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'claimed');
  f.store.db.exec('DROP TRIGGER fail_result');
  f.dispatcher.receive(identity, reply(f));
  assert.equal(f.service.job(actor, f.job.id).job.status, 'succeeded');
});

test('callback domain/node/job/token/protocol/size violations cannot mutate attempts', async (t) => {
  const f = fixture(t); await f.dispatcher.dispatch();
  const cases = [
    [{ domain: 'other', node: 'node/other/one' }, {}],
    [{ domain: 'lab', node: 'node/lab/two' }, {}],
    [identity, { jobId: 'wrong' }], [identity, { attemptId: 'wrong' }],
    [identity, { token: '0'.repeat(64) }], [identity, { token: '00' }],
    [identity, { version: 2 }], [identity, { stdout: 'á'.repeat(16385) }],
    [identity, { exitCode: undefined }], [identity, { outcome: 'completed', exitCode: null }],
    [identity, { padding: 'x'.repeat(200000) }]
  ];
  for (const [origin, mutation] of cases) assert.throws(() => f.dispatcher.receive(origin, reply(f, mutation)));
  assert.equal(f.service.job(actor, f.job.id).attempts[0].state, 'claimed');
  assert.equal(f.service.job(actor, f.job.id).events.length, 2);
});

test('admin/domain/node/context restrictions cover scripts, job reads, revision and dispatch', async (t) => {
  const f = fixture(t), outsider = { id: 'user/other/admin', domain: 'other', admin: true, allowedNodes: ['node/other/one'] };
  assert.throws(() => f.service.scripts({ ...actor, admin: false }), /Administrador/);
  assert.deepEqual(f.service.scripts(outsider), []);
  assert.throws(() => f.service.job(outsider, f.job.id), /não encontrada/);
  assert.throws(() => f.service.saveScript(outsider, { ...scriptInput, id: f.script.id }), /não encontrado/);
  assert.throws(() => f.service.createJob(actor, { ...f.input, targets: ['node/other/one'] }), /domínio/);
  assert.throws(() => f.service.createJob({ ...actor, allowedNodes: [] }, f.input), /autorização/);
  assert.throws(() => f.service.createJob(actor, { ...f.input, context: 'user' }), /serviço/);
  assert.throws(() => f.service.saveScript(actor, { ...scriptInput, context: 'user' }), /serviço/);
  assert.throws(() => f.service.saveScript(actor, { ...scriptInput, body: 'x'.repeat(65537) }), /excessivo/);
  f.dispatcher.authorize = async () => ({ ...actor, allowedNodes: [] });
  assert.equal(await f.dispatcher.dispatch(), 0);
  assert.equal(f.store.get('SELECT last_error FROM targets WHERE job_id=?', f.job.id).last_error, 'FORBIDDEN');
  assert.equal(f.sent.length, 0);
});
