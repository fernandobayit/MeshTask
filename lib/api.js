'use strict';
const v = require('./validate');
const { ensure, TaskError } = require('./errors');
const mesh = require('./meshcentral');
const { mutate } = require('./idempotency');
const VERSION = require('../package.json').version;
const REASON = 'Execução desativada por configuração; o modo direct-control-v1 requer servidor único e runtime compatível.';
class AdminAPI {
  constructor(service, webserver, status = () => ({ executionEnabled: false, reason: REASON, scheduler: 'not-started' }), active = () => true) { this.service = service; this.webserver = webserver; this.status = status; this.active = active; }
  async request(session, command) {
    let actor = mesh.userIdentity(session, this.webserver);
    v.bounded(command);
    ensure(command.action === 'plugin' && command.plugin === 'meshtask2' && command.type === 'request' && command.version === 1 && command.routeToNode !== true, 'PROTOCOL', 'Envelope administrativo inválido.');
    v.id(command.requestId); v.text(command.op, 64, 'Operação');
    const input = v.bounded(command.input || {});
    if (['jobs.create', 'schedules.create'].includes(command.op)) {
      actor = await mesh.authorize(this.webserver, actor, input.targets);
      mesh.userIdentity(session, this.webserver); // Session may have closed while awaiting ACL lookup.
    }
    ensure(this.active(), 'UNAVAILABLE', 'Plugin encerrando.');
    const apply = () => this.apply(actor, command.op, input);
    if (['scripts.save', 'jobs.create', 'schedules.create', 'schedules.disable'].includes(command.op)) return mutate(this.service.store, actor, command.requestId, command.op, input, apply);
    return apply();
  }
  apply(actor, op, input) {
    const s = this.service;
    switch (op) {
      case 'status': return { version: VERSION, ...this.status(), listLimit: v.LIMITS.list };
      case 'scripts.save': return s.saveScript(actor, input);
      case 'scripts.list': return s.scripts(actor);
      case 'jobs.create': return { ...s.createJob(actor, input), executionBlocked: !this.status().executionEnabled };
      case 'jobs.list': return s.jobs(actor).map((job) => ({ ...job, executionBlocked: !this.status().executionEnabled }));
      case 'jobs.get': return s.job(actor, input.jobId, input);
      case 'schedules.create': return s.createSchedule(actor, input);
      case 'schedules.list': return s.schedules(actor);
      case 'schedules.disable': return s.disableSchedule(actor, input.scheduleId);
      default: throw new TaskError('UNSUPPORTED', 'Operação não suportada.');
    }
  }
}
module.exports = { AdminAPI, VERSION, REASON };
