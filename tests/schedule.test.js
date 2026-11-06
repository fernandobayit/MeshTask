'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../lib/store');
const { Service } = require('../lib/service');
const { fixture, actor, scriptInput, temp } = require('./helpers');
const at = '2026-01-01T00:00:00Z';

test('once schedule concurrent claim across two connections creates exactly one occurrence', async (t) => {
  const file = temp(t), f = fixture(t, file), other = new Store(file); t.after(() => other.close());
  const service2 = new Service(other, { clock: f.clock });
  const schedule = f.service.createSchedule(actor, { ...f.input, kind: 'once', at });
  const jobs = (await Promise.all([f.service.tickSchedules(f.authorize), service2.tickSchedules(f.authorize)])).flat();
  assert.equal(jobs.length, 1);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM jobs WHERE schedule_id=?', schedule.id).n, 1);
  assert.equal(f.service.schedules(actor)[0].enabled, false);
  assert.equal((await f.service.tickSchedules(f.authorize)).length, 0);
});

test('interval UTC coalesces missed slots, retains frozen revision, survives restart', async (t) => {
  const file = temp(t), f = fixture(t, file);
  f.service.createSchedule(actor, { ...f.input, kind: 'interval', at, intervalMs: 1000 });
  f.service.saveScript(actor, { ...scriptInput, id: f.script.id, body: 'exit 9' });
  f.advance(5500);
  const jobs = await f.service.tickSchedules(f.authorize); assert.equal(jobs.length, 1);
  assert.equal(f.service.job(actor, jobs[0].id).job.body, scriptInput.body);
  assert.equal(f.service.schedules(actor)[0].nextDue, '2026-01-01T00:00:06.000Z');
  f.store.close();
  const store = new Store(file); t.after(() => store.close());
  const service = new Service(store, { clock: f.clock });
  assert.equal((await service.tickSchedules(f.authorize)).length, 0);
  f.advance(500); assert.equal((await service.tickSchedules(f.authorize)).length, 1);
});

test('schedule occurrence and due advancement roll back together on persistence error', async (t) => {
  const f = fixture(t); f.service.createSchedule(actor, { ...f.input, kind: 'once', at });
  f.store.db.exec("CREATE TRIGGER fail_schedule BEFORE INSERT ON events WHEN NEW.type='schedule_claimed' BEGIN SELECT RAISE(ABORT,'disk'); END;");
  await assert.rejects(f.service.tickSchedules(f.authorize), /disk/);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM jobs WHERE schedule_id IS NOT NULL').n, 0);
  assert.equal(f.service.schedules(actor)[0].enabled, true);
  f.store.db.exec('DROP TRIGGER fail_schedule');
  assert.equal((await f.service.tickSchedules(f.authorize)).length, 1);
});

test('disable while awaiting rights wins; denied actor cannot materialize jobs', async (t) => {
  const f = fixture(t); const schedule = f.service.createSchedule(actor, { ...f.input, kind: 'once', at });
  let grant;
  const pending = f.service.tickSchedules(() => new Promise((resolve) => { grant = resolve; }));
  f.service.disableSchedule(actor, schedule.id); grant(actor);
  assert.equal((await pending).length, 0);
  f.service.createSchedule(actor, { ...f.input, kind: 'once', at });
  assert.deepEqual(await f.service.tickSchedules(async () => ({ ...actor, admin: false })), []);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM schedule_events WHERE type='authorization_deferred'").n, 1);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM jobs WHERE schedule_id IS NOT NULL').n, 0);
});

test('schedule validates UTC calendar, interval bounds, domain and service context', (t) => {
  const f = fixture(t), base = { ...f.input, kind: 'interval', at, intervalMs: 1000 };
  for (const change of [{ at: '2026-02-30T00:00:00Z' }, { at: '2026-01-01T00:00:00-03:00' }, { intervalMs: 0 }, { intervalMs: 1.5 }, { context: 'user' }, { kind: 'cron' }, { targets: ['node/other/one'] }]) assert.throws(() => f.service.createSchedule(actor, { ...base, ...change }));
  assert.equal(f.service.schedules(actor).length, 0);
});
