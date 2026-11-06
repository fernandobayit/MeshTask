'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, actor, scriptInput } = require('./helpers');
const { TaskError } = require('../lib/errors');

test('revoked schedule owner cannot starve other authorized schedules/domains', async (t) => {
  const f = fixture(t);
  const revoked = { ...actor, id: 'user/lab/revoked' };
  f.service.createSchedule(revoked, { ...f.input, kind: 'once', at: '2025-12-31T23:59:58Z' });
  const good = f.service.createSchedule(actor, { ...f.input, kind: 'once', at: '2025-12-31T23:59:59Z' });
  const jobs = await f.service.tickSchedules(async (id, domain, nodes) => {
    if (id === revoked.id) throw new TaskError('FORBIDDEN', 'revoked');
    return f.authorize(id, domain, nodes);
  });
  assert.equal(jobs.length, 1);
  assert.equal(f.service.job(actor, jobs[0].id).job.scheduleId, good.id);
});

test('revoked job owner cannot starve authorized dispatches', async (t) => {
  const f = fixture(t); f.advance(1);
  const good = f.service.createJob({ ...actor, id: 'user/lab/otheradmin' }, f.input);
  f.dispatcher.authorize = async (id, domain, nodes) => {
    if (id === actor.id) throw new TaskError('FORBIDDEN', 'revoked');
    return f.authorize(id, domain, nodes);
  };
  assert.equal(await f.dispatcher.dispatch(), 1);
  assert.equal(f.sent[0].message.jobId, good.id);
});

test('first 100 unavailable destinations do not starve later available destination', async (t) => {
  const f = fixture(t);
  const unavailable = Array.from({ length: 100 }, (_, i) => `node/lab/offline-${i}`);
  f.service.createJob({ ...actor, allowedNodes: unavailable }, { ...f.input, targets: unavailable });
  f.advance(1); const good = f.service.createJob(actor, { ...f.input, targets: ['node/lab/two'] });
  f.transport.canSend = (domain, node) => node === 'node/lab/two';
  await f.dispatcher.dispatch(); await f.dispatcher.dispatch();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.jobId, good.id);
});

test('claim validates full wire envelope before intent persistence', (t) => {
  const f = fixture(t);
  const job = f.store.get('SELECT * FROM jobs WHERE id=?', f.job.id);
  job.snapshot = JSON.stringify({ ...JSON.parse(job.snapshot), body: '\u0001'.repeat(65536) });
  assert.throws(() => f.dispatcher.claim(job, 'node/lab/one'), /excessivo/);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM attempts').n, 0);
});

test('large valid snapshot does not leak complete fleet target list in agent message', async (t) => {
  const f = fixture(t);
  await f.dispatcher.dispatch();
  const nodes = Array.from({ length: 100 }, (_, i) => 'node/lab/' + 'n'.repeat(180) + i);
  const script = f.service.saveScript(actor, { ...scriptInput, body: '\u0001'.repeat(32000) });
  f.service.createJob({ ...actor, allowedNodes: nodes }, { ...f.input, scriptId: script.id, targets: nodes });
  await f.dispatcher.dispatch();
  assert.equal(f.sent.length, 101);
  assert.equal(f.sent[1].message.script.targets, undefined);
});

test('conflicting-result flood has bounded immutable evidence and never overwrites real result', async (t) => {
  const { reply, identity } = require('./helpers');
  const f = fixture(t); await f.dispatcher.dispatch(); f.dispatcher.receive(identity, reply(f));
  for (let i = 0; i < 30; i++) f.dispatcher.receive(identity, reply(f, { stdout: 'different-' + i + 'x'.repeat(1000) }));
  const events = f.service.job(actor, f.job.id).events;
  assert.ok(events.filter((e) => e.type === 'result_conflict').length <= 8);
  assert.equal(events.filter((e) => e.type === 'conflict_limit').length, 1);
  assert.equal(f.service.job(actor, f.job.id).attempts[0].result.stdout, 'Olá');
});

test('large job history pages are bounded and all attempts remain retrievable without tokens', async (t) => {
  const { reply, identity } = require('./helpers');
  const f = fixture(t);
  const nodes = Array.from({ length: 12 }, (_, i) => `node/lab/page-${i}`);
  const job = f.service.createJob({ ...actor, allowedNodes: nodes }, { ...f.input, targets: nodes });
  await f.dispatcher.dispatch();
  for (const sent of f.sent.filter((item) => item.message.jobId === job.id)) {
    f.dispatcher.receive({ ...identity, node: sent.node }, { ...reply(f), jobId: job.id, attemptId: sent.message.attemptId, token: sent.message.token, stdout: 'x'.repeat(32768), stderr: 'y'.repeat(32768) });
  }
  let afterAttempt = '', count = 0, pages = 0;
  do {
    const result = f.service.job(actor, job.id, { afterAttempt });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1048576);
    assert.equal(JSON.stringify(result).includes('"token"'), false);
    count += result.attempts.length; pages++; afterAttempt = result.nextAttempt;
  } while (afterAttempt);
  assert.equal(count, 12); assert.ok(pages > 1);
});
