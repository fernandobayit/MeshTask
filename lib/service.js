'use strict';
const { randomUUID, createHash } = require('node:crypto');
const v = require('./validate');
const { assertDispatchable } = require('./protocol');
const { page, boundedList } = require('./pages');
const { ensure } = require('./errors');
const uuid = () => randomUUID();
const hash = (value) => createHash('sha256').update(value).digest('hex');
class Service {
  constructor(store, { clock = Date.now } = {}) { this.store = store; this.clock = clock; }
  saveScript(actor, input) {
    v.admin(actor); v.script(input);
    return this.store.transaction(() => {
      const id = input.id === undefined ? uuid() : v.id(input.id);
      const old = this.store.get('SELECT * FROM scripts WHERE id=? AND domain=?', id, actor.domain);
      ensure(input.id === undefined || old, 'NOT_FOUND', 'Script não encontrado.');
      const revision = old ? old.revision + 1 : 1;
      if (old) this.store.run('UPDATE scripts SET name=?,revision=? WHERE id=?', input.name, revision, id);
      else this.store.run('INSERT INTO scripts VALUES(?,?,?,?)', id, actor.domain, input.name, revision);
      this.store.run('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)', id, revision, input.engine, input.body, hash(input.body), this.clock(), actor.id);
      return { id, name: input.name, revision, engine: input.engine };
    });
  }
  scripts(actor) {
    v.admin(actor);
    return this.store.all('SELECT s.id,s.name,s.revision,r.engine FROM scripts s JOIN revisions r ON r.script_id=s.id AND r.revision=s.revision WHERE s.domain=? ORDER BY s.id LIMIT ?', actor.domain, v.LIMITS.list);
  }
  snapshot(actor, input) {
    v.bounded(input); v.context(input.context); v.id(input.scriptId); v.integer(input.revision, 1, 2147483647, 'Revisão');
    const targets = v.targets(actor, input.targets);
    const row = this.store.get('SELECT s.name,r.* FROM scripts s JOIN revisions r ON r.script_id=s.id WHERE s.id=? AND s.domain=? AND r.revision=?', input.scriptId, actor.domain, input.revision);
    ensure(row, 'NOT_FOUND', 'Script/revisão não encontrado.');
    const snapshot = { scriptId: input.scriptId, revision: input.revision, name: row.name, engine: row.engine, body: row.body, hash: row.hash, context: 'service', targets };
    assertDispatchable(snapshot);
    return snapshot;
  }
  insertJob(actor, snapshot, scheduleId = null, occurrence = null) {
    const id = uuid();
    this.store.run('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)', id, actor.domain, actor.id, JSON.stringify(snapshot), this.clock(), scheduleId, occurrence);
    for (const node of snapshot.targets) this.store.run('INSERT INTO targets(job_id,node) VALUES(?,?)', id, node);
    this.store.event(id, null, 'created', this.clock(), { actor: actor.id, scheduleId, occurrence });
    return { id, scriptId: snapshot.scriptId, revision: snapshot.revision, targets: snapshot.targets, status: 'queued' };
  }
  createJob(actor, input) {
    v.admin(actor);
    return this.store.transaction(() => this.insertJob(actor, this.snapshot(actor, input)));
  }
  jobRow(actor, jobId) {
    v.admin(actor); v.id(jobId);
    const job = this.store.get('SELECT * FROM jobs WHERE id=? AND domain=?', jobId, actor.domain);
    ensure(job, 'NOT_FOUND', 'Solicitação não encontrada.'); return job;
  }
  jobView(row, includeBody = false) {
    const snapshot = JSON.parse(row.snapshot);
    if (!includeBody) delete snapshot.body;
    const attempts = this.store.all('SELECT state FROM attempts WHERE job_id=?', row.id);
    let status = 'queued';
    if (attempts.some((a) => a.state === 'unknown')) status = 'unknown';
    else if (attempts.length === snapshot.targets.length && attempts.every((a) => ['succeeded', 'failed', 'rejected'].includes(a.state))) status = attempts.every((a) => a.state === 'succeeded') ? 'succeeded' : 'failed';
    else if (attempts.length) status = 'in_progress';
    return { id: row.id, domain: row.domain, actor: row.actor, created: row.created, scheduleId: row.schedule_id, occurrence: row.occurrence, ...snapshot, status };
  }
  jobs(actor) {
    v.admin(actor); return boundedList(this.store.db.prepare('SELECT * FROM jobs WHERE domain=? ORDER BY created DESC,id LIMIT ?').iterate(actor.domain, v.LIMITS.list), (row) => this.jobView(row));
  }
  job(actor, jobId, options = {}) {
    const row = this.jobRow(actor, jobId);
    const afterAttempt = options.afterAttempt || '', afterEvent = options.afterEvent || 0;
    if (afterAttempt) v.id(afterAttempt);
    v.integer(afterEvent, 0, Number.MAX_SAFE_INTEGER, 'Cursor de evento');
    const attempts = page(this.store.db.prepare('SELECT id,node,state,claimed,deadline,result FROM attempts WHERE job_id=? AND id>? ORDER BY id').iterate(jobId, afterAttempt), { key: 'id', decode: (a) => ({ ...a, result: a.result ? JSON.parse(a.result) : null }) });
    const events = page(this.store.db.prepare('SELECT seq,attempt_id,type,at,data FROM events WHERE job_id=? AND seq>? ORDER BY seq').iterate(jobId, afterEvent), { key: 'seq', decode: (e) => ({ ...e, data: JSON.parse(e.data) }) });
    return { job: this.jobView(row, true), attempts: attempts.items, events: events.items, nextAttempt: attempts.next, nextEvent: events.next };
  }
  createSchedule(actor, input) {
    v.admin(actor); v.bounded(input);
    ensure(['once', 'interval'].includes(input.kind), 'INVALID', 'Tipo de agendamento inválido.');
    const at = v.utc(input.at);
    const interval = input.kind === 'interval' ? v.integer(input.intervalMs, 1000, 31536000000, 'Intervalo (mínimo 1000 ms)') : null;
    return this.store.transaction(() => {
      const snapshot = this.snapshot(actor, input), id = uuid();
      this.store.run('INSERT INTO schedules(id,domain,actor,snapshot,kind,at,interval_ms,next_due,enabled) VALUES(?,?,?,?,?,?,?,?,1)', id, actor.domain, actor.id, JSON.stringify(snapshot), input.kind, at, interval, at);
      this.store.scheduleEvent(id, 'created', this.clock(), { actor: actor.id });
      return { id, ...snapshot, kind: input.kind, at: new Date(at).toISOString(), intervalMs: interval, enabled: true };
    });
  }
  schedules(actor) {
    v.admin(actor); return boundedList(this.store.db.prepare('SELECT * FROM schedules WHERE domain=? ORDER BY at,id LIMIT ?').iterate(actor.domain, v.LIMITS.list), (row) => {
      const snapshot = JSON.parse(row.snapshot); delete snapshot.body;
      return { id: row.id, ...snapshot, kind: row.kind, at: new Date(row.at).toISOString(), nextDue: new Date(row.next_due).toISOString(), intervalMs: row.interval_ms, enabled: row.enabled === 1, lastError: row.last_error, nextCheck: row.next_check };
    });
  }
  disableSchedule(actor, scheduleId) {
    v.admin(actor); v.id(scheduleId);
    return this.store.transaction(() => {
      ensure(this.store.run('UPDATE schedules SET enabled=0 WHERE id=? AND domain=?', scheduleId, actor.domain).changes === 1, 'NOT_FOUND', 'Agendamento não encontrado.');
      this.store.scheduleEvent(scheduleId, 'disabled', this.clock(), { actor: actor.id }, scheduleId + ':disabled');
      return { disabled: true };
    });
  }
  // Authorization is resolved outside the SQLite lock, then due time is compared
  // inside the transaction. Two workers cannot materialize the same occurrence.
  async tickSchedules(authorize, active = () => true) {
    const now = this.clock(), jobs = [];
    const due = this.store.all('SELECT * FROM schedules WHERE enabled=1 AND next_due<=? AND next_check<=? ORDER BY next_check,next_due,id LIMIT 100', now, now);
    for (const candidate of due) {
      if (!active()) break;
      const snapshot = JSON.parse(candidate.snapshot);
      let actor;
      try {
        actor = await authorize(candidate.actor, candidate.domain, snapshot.targets);
        v.admin(actor); ensure(actor.id === candidate.actor && actor.domain === candidate.domain, 'FORBIDDEN', 'Autor do agendamento inválido.'); v.targets(actor, snapshot.targets);
      } catch (error) {
        if (error.name !== 'TaskError' || !['FORBIDDEN', 'AUTH_TIMEOUT', 'RUNTIME'].includes(error.code)) throw error;
        this.store.transaction(() => {
          this.store.run('UPDATE schedules SET next_check=?,last_error=? WHERE id=? AND enabled=1 AND next_due=?', now + 5000, error.code, candidate.id, candidate.next_due);
          this.store.scheduleEvent(candidate.id, 'authorization_deferred', now, { code: error.code }, candidate.id + ':auth:' + candidate.next_due + ':' + error.code);
        });
        continue;
      }
      if (!active()) break;
      const job = this.store.transaction(() => {
        const current = this.store.get('SELECT * FROM schedules WHERE id=?', candidate.id);
        if (!current.enabled || current.next_due !== candidate.next_due) return null;
        const created = this.insertJob(actor, snapshot, current.id, current.next_due);
        // Coalesce missed intervals: one job for the earliest due occurrence,
        // then advance to the first future aligned slot. No catch-up storm.
        const next = current.kind === 'interval' ? current.next_due + (Math.floor((now - current.next_due) / current.interval_ms) + 1) * current.interval_ms : current.next_due;
        this.store.run('UPDATE schedules SET next_due=?,enabled=?,next_check=0,last_error=NULL WHERE id=?', next, current.kind === 'interval' ? 1 : 0, current.id);
        this.store.scheduleEvent(current.id, 'claimed', now, { jobId: created.id, occurrence: current.next_due }, current.id + ':claim:' + current.next_due);
        this.store.event(created.id, null, 'schedule_claimed', now, { scheduleId: current.id, occurrence: current.next_due, nextDue: next });
        return created;
      });
      if (job) jobs.push(job);
    }
    return jobs;
  }
}
module.exports = { Service, hash };
