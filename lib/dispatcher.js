'use strict';
const { randomUUID, randomBytes, timingSafeEqual, createHash } = require('node:crypto');
const v = require('./validate');
const p = require('./protocol');
const { ensure } = require('./errors');
class Dispatcher {
  constructor(store, { transport, authorize, clock = Date.now, timeoutMs = 60000, active = () => true }) {
    v.integer(timeoutMs, 1, 86400000, 'Timeout');
    this.store = store; this.transport = transport; this.authorize = authorize; this.clock = clock; this.timeoutMs = timeoutMs; this.active = active;
  }
  claim(job, node, binding = null) {
    return this.store.transaction(() => {
      if (this.store.get('SELECT id FROM attempts WHERE job_id=? AND node=?', job.id, node)) return null;
      const now = this.clock(), attempt = { id: randomUUID(), token: randomBytes(32).toString('hex'), node, jobId: job.id };
      attempt.message = p.execution(JSON.parse(job.snapshot), job, attempt);
      if (binding) attempt.message = v.bounded({ ...attempt.message, ...binding });
      this.store.run('INSERT INTO attempts(id,job_id,node,token,state,claimed,deadline) VALUES(?,?,?,?,?,?,?)', attempt.id, job.id, node, attempt.token, 'claimed', now, now + this.timeoutMs);
      this.store.event(job.id, attempt.id, 'dispatch_claimed', now, binding ? { ...binding, payloadHash: createHash('sha256').update(JSON.stringify(attempt.message)).digest('hex') } : {}, `${attempt.id}:claim`);
      return attempt;
    });
  }
  async dispatch() {
    ensure(this.transport && typeof this.transport.canSend === 'function' && typeof this.authorize === 'function', 'RUNTIME', 'Transporte e autorização explícitos obrigatórios.');
    const queued = this.store.all('SELECT j.*,t.node FROM targets t JOIN jobs j ON j.id=t.job_id LEFT JOIN attempts a ON a.job_id=t.job_id AND a.node=t.node WHERE a.id IS NULL AND t.eligible_at<=? ORDER BY t.eligible_at,j.created,j.id,t.node LIMIT 100', this.clock());
    let sent = 0;
    for (const job of queued) {
      if (!this.active()) break;
      try {
        const actor = await this.authorize(job.actor, job.domain, [job.node]);
        v.admin(actor); ensure(actor.domain === job.domain && actor.id === job.actor, 'FORBIDDEN', 'Autor inválido.'); v.targets(actor, [job.node]);
      } catch (error) {
        if (error.name !== 'TaskError' || !['FORBIDDEN', 'AUTH_TIMEOUT', 'RUNTIME'].includes(error.code)) throw error;
        this.defer(job, error.code);
        continue;
      }
      if (!this.active()) break;
      const snapshot = JSON.parse(job.snapshot);
      if (await this.transport.canSend(job.domain, job.node, snapshot.engine) !== true) { this.defer(job, 'OFFLINE_OR_UNSUPPORTED'); continue; }
      if (!this.active()) break;
      const binding = this.transport.prepare ? this.transport.prepare(job.domain, job.node, snapshot.engine) : null;
      const attempt = this.claim(job, job.node, binding); // Any persistence failure prevents send.
      if (!attempt) continue;
      const message = attempt.message;
      try { await this.transport.send(job.domain, job.node, message); sent++; }
      catch {
        // Send failure can mean bytes were delivered. Never put it back in queue.
        this.unknown(attempt.id, 'send_ambiguous');
      }
    }
    return sent;
  }
  defer(job, code) {
    this.store.transaction(() => {
      this.store.run('UPDATE targets SET eligible_at=?,last_error=? WHERE job_id=? AND node=?', this.clock() + 5000, code, job.id, job.node);
      this.store.event(job.id, null, 'dispatch_deferred', this.clock(), { node: job.node, code }, job.id + ':deferred:' + job.node + ':' + code);
    });
  }
  unknown(attemptId, reason) {
    return this.store.transaction(() => {
      const a = this.store.get('SELECT * FROM attempts WHERE id=?', attemptId);
      if (!a || a.result !== null) return false;
      this.store.run("UPDATE attempts SET state='unknown' WHERE id=?", a.id);
      this.store.event(a.job_id, a.id, reason, this.clock(), {}, `${a.id}:${reason}`); return true;
    });
  }
  expire() {
    const due = this.store.all("SELECT id FROM attempts WHERE state IN ('claimed','acknowledged') AND deadline<=?", this.clock());
    for (const a of due) this.unknown(a.id, 'timeout');
    return due.length;
  }
  recover() {
    const pending = this.store.all("SELECT id FROM attempts WHERE state IN ('claimed','acknowledged')");
    for (const a of pending) this.unknown(a.id, 'server_restart');
    return pending.length;
  }
  disconnect(identity) {
    v.domain(identity.domain); v.node(identity.node, identity.domain);
    const rows = this.store.all("SELECT a.id FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE j.domain=? AND a.node=? AND a.state IN ('claimed','acknowledged')", identity.domain, identity.node);
    for (const a of rows) this.unknown(a.id, 'disconnected');
  }
  receive(identity, message) {
    p.incoming(message); v.domain(identity.domain); v.node(identity.node, identity.domain);
    return this.store.transaction(() => {
      const a = this.store.get('SELECT a.*,j.domain FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?', message.attemptId);
      ensure(a && a.job_id === message.jobId && a.node === identity.node && a.domain === identity.domain, 'FORBIDDEN', 'Tentativa não pertence ao agente.');
      ensure(timingSafeEqual(Buffer.from(a.token, 'hex'), Buffer.from(message.token, 'hex')), 'FORBIDDEN', 'Token não confere.');
      if (message.type === 'ack') {
        this.store.event(a.job_id, a.id, 'ack', this.clock(), {}, `${a.id}:ack`);
        if (a.state === 'claimed') this.store.run("UPDATE attempts SET state='acknowledged' WHERE id=?", a.id);
        return { accepted: true };
      }
      if (message.type === 'status') {
        this.store.event(a.job_id, a.id, `agent_${message.state}`, this.clock(), {}, `${a.id}:status:${message.state}`);
        // Neither 'running' nor 'not_found' establishes a final outcome.
        if (a.result === null && message.state !== 'running') this.store.run("UPDATE attempts SET state='unknown' WHERE id=?", a.id);
        return { accepted: true };
      }
      const data = p.resultData(message), result = JSON.stringify(data);
      if (a.result !== null) {
        if (a.result === result) return { accepted: true, duplicate: true };
        const digest = createHash('sha256').update(result).digest('hex');
        const count = this.store.get("SELECT COUNT(*) AS n FROM events WHERE attempt_id=? AND type='result_conflict'", a.id).n;
        if (count < 8) this.store.event(a.job_id, a.id, 'result_conflict', this.clock(), count === 0 ? { digest, firstEvidence: data } : { digest }, a.id + ':conflict:' + digest);
        else this.store.event(a.job_id, a.id, 'conflict_limit', this.clock(), { limit: 8, furtherConflictDetailsOmitted: true }, a.id + ':conflict-limit');
        return { accepted: false, conflict: true };
      }
      const state = data.outcome === 'rejected' ? 'rejected' : data.exitCode === 0 ? 'succeeded' : 'failed';
      this.store.run('UPDATE attempts SET state=?,result=? WHERE id=?', state, result, a.id);
      this.store.event(a.job_id, a.id, 'result', this.clock(), { outcome: data.outcome, exitCode: data.exitCode, digest: createHash('sha256').update(result).digest('hex'), late: a.state === 'unknown' }, `${a.id}:result`);
      return { accepted: true, state };
    });
  }
  async reconcile(attemptId) {
    v.id(attemptId);
    const a = this.store.get('SELECT a.*,j.domain FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE a.id=?', attemptId);
    ensure(a, 'NOT_FOUND', 'Tentativa não encontrada.');
    if (a.result !== null) return false;
    // Only a status query. No script, no new attempt, no execution resend.
    await this.transport.send(a.domain, a.node, p.envelope('query', { id: a.job_id }, a));
    return true;
  }
}
module.exports = { Dispatcher };
