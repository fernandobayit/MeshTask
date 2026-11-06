'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createBridge } = require('../ui/bridge');

// Per-test clocks avoid real sleeps, global monkeypatches and leaked timers.
function setup(t, options = {}) {
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  let requestId = 0;
  let now = 0;
  const factory = vm.runInNewContext(`(${createBridge.toString()})`, {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  const bridge = factory((message) => {
    sent.push(JSON.parse(JSON.stringify(message)));
    if (options.send) options.send(message);
  }, { timeoutMs: 100, nonce: options.nonce || (() => `request-fixture-${++requestId}`) });
  t.after(() => { bridge.close(); assert.equal(timers.size, 0, 'close must clear all pending timers'); });
  function advance(ms) {
    const end = now + ms;
    let count = 0;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      assert.ok(++count < 1000, 'Unexpected runaway timer or retry loop');
      now = next[1].due;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  }
  return { bridge, sent, timers, advance };
}
function reply(request, changes = {}) {
  return { action: 'plugin', plugin: 'meshtask2', version: 1, type: 'response',
    requestId: request.requestId, op: request.op, ok: true, result: { id: request.requestId }, ...changes };
}
function observe(promise) {
  const state = { status: 'pending' };
  const done = promise.then(
    (value) => { state.status = 'fulfilled'; state.value = value; },
    (error) => { state.status = 'rejected'; state.error = error; }
  );
  return { state, done };
}

test('standalone bridge sends protocol envelope and correlates out-of-order replies by requestId AND op', async (t) => {
  const { bridge, sent, timers } = setup(t);
  const first = observe(bridge.request('scripts.list'));
  const second = observe(bridge.request('jobs.get', { jobId: 'job-fixture' }));
  const third = observe(bridge.request('scripts.list'));
  assert.deepEqual(sent[0], { action: 'plugin', plugin: 'meshtask2', version: 1, type: 'request',
    requestId: 'request-fixture-1', op: 'scripts.list', input: {} });
  assert.deepEqual(sent[1].input, { jobId: 'job-fixture' });
  assert.equal(new Set(sent.map(({ requestId }) => requestId)).size, 3);
  assert.equal(bridge.receive(reply(sent[0], { op: sent[1].op })), false);
  assert.equal(bridge.receive(reply(sent[1], { requestId: 'unknown-request' })), false);
  await Promise.resolve();
  assert.equal(first.state.status, 'pending');
  assert.equal(second.state.status, 'pending');
  assert.equal(timers.size, 3);
  assert.equal(bridge.receive(reply(sent[2], { result: ['third'] })), true);
  await third.done;
  assert.deepEqual(third.state.value, ['third']);
  assert.equal(first.state.status, 'pending', 'same op must not settle the wrong requestId');
  assert.equal(bridge.receive(reply(sent[1], { result: { id: 'job-fixture' } })), true);
  await second.done;
  assert.deepEqual(second.state.value, { id: 'job-fixture' });
  assert.equal(first.state.status, 'pending');
  assert.equal(bridge.receive(reply(sent[0], { result: ['first'] })), true);
  await first.done;
  assert.deepEqual(first.state.value, ['first']);
  assert.equal(timers.size, 0);
});

test('duplicate replies are ignored without affecting another pending request', async (t) => {
  const { bridge, sent, timers } = setup(t);
  const first = observe(bridge.request('status'));
  const second = observe(bridge.request('status'));
  assert.equal(bridge.receive(reply(sent[0], { result: 'original' })), true);
  await first.done;
  assert.equal(bridge.receive(reply(sent[0], { result: 'duplicate' })), false);
  assert.equal(bridge.receive(reply(sent[0], { ok: false, error: { message: 'late error' } })), false);
  await Promise.resolve();
  assert.equal(first.state.value, 'original');
  assert.equal(second.state.status, 'pending');
  assert.equal(timers.size, 1);
  assert.equal(bridge.receive(reply(sent[1], { result: 'second' })), true);
  await second.done;
  assert.equal(second.state.value, 'second');
});

test('malformed or foreign responses leave the request pending', async (t) => {
  const { bridge, sent, timers } = setup(t);
  const call = observe(bridge.request('status'));
  const malformed = [null, {}, ...[
    { action: 'other' }, { plugin: 'other' }, { version: 2 }, { type: 'request' },
    { requestId: undefined }, { op: 'jobs.list' }, { ok: 'true' }, { ok: undefined }
  ].map((changes) => reply(sent[0], changes))];
  for (const message of malformed) assert.equal(bridge.receive(message), false);
  await Promise.resolve();
  assert.equal(call.state.status, 'pending');
  assert.equal(timers.size, 1);
  assert.equal(bridge.receive(reply(sent[0], { result: 'valid' })), true);
  await call.done;
  assert.equal(call.state.value, 'valid');
});

test('timeout rejects as unknown outcome, removes pending request and never resends', async (t) => {
  const { bridge, sent, timers, advance } = setup(t);
  const call = observe(bridge.request('jobs.create', { scriptId: 'script-fixture' }));
  advance(99);
  await Promise.resolve();
  assert.equal(call.state.status, 'pending');
  advance(1);
  await call.done;
  assert.equal(call.state.status, 'rejected');
  assert.match(call.state.error.message, /Resultado da alteração desconhecido/);
  assert.match(call.state.error.message, /sem reenvio automático/);
  assert.equal(timers.size, 0);
  advance(100000);
  assert.equal(sent.length, 1);
  assert.equal(bridge.receive(reply(sent[0])), false, 'late replies cannot revive a timed-out request');
  const next = observe(bridge.request('status'));
  assert.equal(bridge.receive(reply(sent[1])), true);
  await next.done;
  assert.equal(next.state.status, 'fulfilled', 'timeout must not close the whole bridge');
});

test('close rejects all pending calls, cancels timers, ignores late replies and blocks new sends', async (t) => {
  const { bridge, sent, timers, advance } = setup(t);
  const first = observe(bridge.request('jobs.create'));
  const second = observe(bridge.request('schedules.create'));
  assert.equal(timers.size, 2);
  bridge.close();
  await Promise.all([first.done, second.done]);
  for (const call of [first, second]) {
    assert.equal(call.state.status, 'rejected');
    assert.match(call.state.error.message, /Conexão encerrada; resultado desconhecido/);
  }
  assert.equal(timers.size, 0);
  for (const request of sent) assert.equal(bridge.receive(reply(request)), false);
  bridge.close();
  await assert.rejects(bridge.request('status'), /Ponte encerrada/);
  advance(100000);
  assert.equal(sent.length, 2);
});

test('synchronous send error rejects original error, clears timer and frees requestId', async (t) => {
  const failure = new Error('fixture send failure');
  let fail = true;
  const { bridge, sent, timers, advance } = setup(t, {
    nonce: () => 'reusable-fixture-id', send() { if (fail) throw failure; }
  });
  await assert.rejects(bridge.request('jobs.create'), (error) => error === failure);
  assert.equal(timers.size, 0);
  assert.equal(bridge.receive(reply(sent[0])), false);
  advance(100000);
  assert.equal(sent.length, 1, 'send failure must not trigger retries');
  fail = false;
  const next = observe(bridge.request('status'));
  assert.equal(sent.length, 2, 'failed send must not retain pending ID');
  assert.equal(bridge.receive(reply(sent[1], { result: 'recovered' })), true);
  await next.done;
  assert.equal(next.state.value, 'recovered');
  assert.equal(timers.size, 0);
});

test('server error rejects only correlated request and cleans up timer', async (t) => {
  const { bridge, sent, timers } = setup(t);
  const first = observe(bridge.request('jobs.create'));
  const second = observe(bridge.request('status'));
  assert.equal(bridge.receive(reply(sent[0], { ok: false, error: { message: 'fixture forbidden' } })), true);
  await first.done;
  assert.equal(first.state.status, 'rejected');
  assert.equal(first.state.error.message, 'fixture forbidden');
  assert.equal(second.state.status, 'pending');
  assert.equal(timers.size, 1);
  assert.equal(bridge.receive(reply(sent[1], { ok: false })), true);
  await second.done;
  assert.equal(second.state.error.message, 'Operação recusada.');
  assert.equal(timers.size, 0);
});

test('duplicate generated requestId is rejected without replacing existing pending call', async (t) => {
  const { bridge, sent, timers } = setup(t, { nonce: () => 'duplicate-fixture' });
  const first = observe(bridge.request('status'));
  await assert.rejects(bridge.request('jobs.list'), /ID de solicitação repetido/);
  assert.equal(sent.length, 1);
  assert.equal(timers.size, 1);
  assert.equal(bridge.receive(reply(sent[0], { result: 'first retained' })), true);
  await first.done;
  assert.equal(first.state.value, 'first retained');
});

test('pending limit rejects before send and completed calls release capacity', async (t) => {
  const { bridge, sent, timers } = setup(t);
  const calls = Array.from({ length: 32 }, () => observe(bridge.request('status')));
  await assert.rejects(bridge.request('status'), /Muitas solicitações pendentes/);
  assert.equal(sent.length, 32);
  assert.equal(timers.size, 32);
  assert.equal(bridge.receive(reply(sent[0])), true);
  await calls[0].done;
  calls.push(observe(bridge.request('status')));
  assert.equal(sent.length, 33);
  bridge.close();
  await Promise.all(calls.map(({ done }) => done));
  assert.equal(timers.size, 0);
});
