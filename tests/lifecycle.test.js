'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Lifecycle, isPluginOwner } = require('../lib/lifecycle');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function timers() {
  const pending = new Map(); let unrefs = 0;
  return {
    pending,
    get unrefs() { return unrefs; },
    setInterval(fn, ms) { const handle = { unref() { unrefs++; } }; pending.set(handle, { fn, ms }); return handle; },
    clearInterval(handle) { pending.delete(handle); },
    fire() { for (const { fn } of [...pending.values()]) fn(); }
  };
}
function fixture(options = {}) {
  const clock = timers(), errors = [], plugin = {}, handler = { plugins: { meshtask2: plugin } };
  const lifecycle = new Lifecycle({ run: () => {}, isOwner: () => isPluginOwner(handler, plugin),
    onStop: () => {}, onError: (error) => errors.push(error),
    setInterval: clock.setInterval, clearInterval: clock.clearInterval, ...options });
  return { lifecycle, clock, errors, plugin, handler };
}

test('construction is inert; start is idempotent and automatic timer is unrefed', async () => {
  let runs = 0;
  const { lifecycle: life, clock } = fixture({ run: () => ++runs, intervalMs: 250 });
  assert.equal(clock.pending.size, 0); assert.equal(life.active(), false);
  assert.equal(await life.tick(), null);
  assert.equal(life.start(), life); life.start();
  assert.equal(clock.pending.size, 1); assert.equal(clock.unrefs, 1);
  assert.equal([...clock.pending.values()][0].ms, 250);
  clock.fire(); await life.inFlight;
  assert.equal(runs, 1);
  await life.stop(); assert.equal(clock.pending.size, 0);
});

test('manual and automatic ticks share one flight; busy intervals do not queue work', async () => {
  const gate = deferred(); let runs = 0;
  const { lifecycle: life, clock } = fixture({ run: async () => { runs++; await gate.promise; return 42; } });
  life.start(); const flight = life.tick();
  assert.equal(life.tick(), flight); await Promise.resolve();
  clock.fire(); clock.fire(); assert.equal(runs, 1);
  gate.resolve(); assert.equal(await flight, 42); assert.equal(life.inFlight, null);
  await Promise.resolve(); assert.equal(runs, 1);
  clock.fire(); await life.inFlight; assert.equal(runs, 2);
  await life.stop();
});

test('shutdown blocks dispatch immediately and waits for flight before closing storage', async () => {
  const gate = deferred(), closeGate = deferred(), events = [];
  const { lifecycle: life, clock } = fixture({
    run: async (active) => { events.push('run'); await gate.promise; if (active()) events.push('dispatch'); events.push('settled'); },
    onStop: async (reason) => { events.push(reason); await closeGate.promise; events.push('closed'); }
  });
  life.start(); const flight = life.tick(); await Promise.resolve();
  const stop = life.stop(); assert.equal(life.stop('again'), stop);
  assert.equal(life.active(), false); assert.equal(clock.pending.size, 0);
  await Promise.resolve(); assert.deepEqual(events, ['run']);
  assert.equal(await life.tick(), null);
  gate.resolve(); await flight; await Promise.resolve();
  assert.deepEqual(events, ['run', 'settled', 'shutdown']);
  closeGate.resolve(); await stop;
  assert.deepEqual(events, ['run', 'settled', 'shutdown', 'closed']);
  life.start(); clock.fire(); assert.equal(clock.pending.size, 0);
});

test('stop between tick scheduling and run prevents run entirely', async () => {
  let runs = 0, closes = 0;
  const { lifecycle: life } = fixture({ run: () => runs++, onStop: () => closes++ });
  life.start(); const flight = life.tick(), stop = life.stop();
  assert.equal(await flight, null); await stop;
  assert.equal(runs, 0); assert.equal(closes, 1);
});

for (const change of ['disable', 'reload']) {
  test(`${change} registry change removes timer even while an async run is stalled`, async () => {
    const gate = deferred(); let sent = 0, closed = 0;
    const { lifecycle: life, clock, handler } = fixture({
      run: async (active) => { await gate.promise; if (active()) sent++; }, onStop: () => closed++
    });
    life.start(); const flight = life.tick(); await Promise.resolve();
    const staleCallback = [...clock.pending.values()][0].fn;
    if (change === 'disable') delete handler.plugins.meshtask2;
    else handler.plugins.meshtask2 = {};
    clock.fire(); assert.equal(clock.pending.size, 0); assert.equal(life.active(), false);
    await Promise.resolve(); assert.equal(closed, 0);
    staleCallback(); assert.equal(clock.pending.size, 0);
    gate.resolve(); await flight; await life.stop();
    assert.equal(sent, 0); assert.equal(closed, 1);
  });
}

test('active callback detects owner removal before next timer fires', async () => {
  const gate = deferred(); let sent = 0;
  const { lifecycle: life, handler, clock } = fixture({ run: async (active) => { await gate.promise; if (active()) sent++; } });
  life.start(); const flight = life.tick(); await Promise.resolve();
  delete handler.plugins.meshtask2; gate.resolve(); await flight; await life.stop();
  assert.equal(sent, 0); assert.equal(clock.pending.size, 0);
});

test('run failures are reported, flight clears, subsequent interval retries', async () => {
  const error = new Error('run failed'); let runs = 0;
  const { lifecycle: life, clock, errors } = fixture({ run: () => { if (++runs === 1) throw error; return 7; } });
  life.start(); clock.fire(); await assert.rejects(life.inFlight, /run failed/);
  assert.deepEqual(errors, [error]); assert.equal(life.inFlight, null);
  clock.fire(); assert.equal(await life.inFlight, 7); await life.stop();
});

test('rejected pending run does not prevent shutdown cleanup', async () => {
  const gate = deferred(); let closes = 0;
  const { lifecycle: life, errors } = fixture({ run: () => gate.promise, onStop: () => closes++ });
  life.start(); const flight = life.tick(); await Promise.resolve(); const stop = life.stop();
  gate.reject(new Error('async failure')); await assert.rejects(flight, /async failure/); await stop;
  assert.equal(closes, 1); assert.equal(errors.length, 1);
});

test('owner probe fails closed and missing registry never starts a timer', async () => {
  const error = new Error('probe failed'); let closes = 0;
  const { lifecycle: life, errors, clock } = fixture({ isOwner: () => { throw error; }, onStop: () => closes++ });
  life.start(); await life.stop(); assert.deepEqual(errors, [error]);
  assert.equal(closes, 1); assert.equal(clock.pending.size, 0);
  const missing = fixture(); delete missing.handler.plugins;
  missing.lifecycle.start(); await missing.lifecycle.stop(); assert.equal(missing.clock.pending.size, 0);
});

test('registry helper requires an own property with exact instance identity', () => {
  const plugin = {};
  assert.equal(isPluginOwner({ plugins: { meshtask2: plugin } }, plugin), true);
  assert.equal(isPluginOwner({ plugins: { meshtask2: {} } }, plugin), false);
  assert.equal(isPluginOwner({ plugins: Object.create({ meshtask2: plugin }) }, plugin), false);
  assert.equal(isPluginOwner({ meshtask2: plugin, parent: { __meshtask2Owner: plugin } }, plugin), false);
  assert.equal(isPluginOwner(null, plugin), false);
  assert.equal(isPluginOwner({ plugins: {} }, undefined), false);
});

test('cleanup rejection is observable and reported once; reporting failures are contained', async () => {
  let reports = 0;
  const { lifecycle: life } = fixture({ onStop: () => { throw new Error('close failed'); },
    onError: async () => { reports++; throw new Error('logger failed'); } });
  life.start(); const stop = life.stop(); await assert.rejects(stop, /close failed/);
  assert.equal(life.stop(), stop); assert.equal(reports, 1);
  await new Promise((resolve) => setImmediate(resolve));
});

test('stop before start closes once and never allows later startup', async () => {
  let closes = 0;
  const { lifecycle: life, clock } = fixture({ onStop: () => closes++ });
  await life.stop(); life.start(); await life.stop();
  assert.equal(closes, 1); assert.equal(clock.pending.size, 0);
});

test('invalid timer values and missing callbacks are rejected', () => {
  for (const intervalMs of [0, -1, 1.5, NaN, Infinity, 2147483648, '1000']) {
    assert.throws(() => fixture({ intervalMs }), RangeError);
  }
  for (const name of ['run', 'isOwner', 'onStop', 'onError', 'setInterval', 'clearInterval']) {
    assert.throws(() => fixture({ [name]: null }), TypeError);
  }
});
