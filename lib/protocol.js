'use strict';
const v = require('./validate');
const { ensure } = require('./errors');
const VERSION = 1;
function incoming(message) {
  v.bounded(message);
  ensure(message.version === VERSION && message.plugin === 'meshtask2' && message.action === 'plugin', 'PROTOCOL', 'Protocolo não suportado.');
  ensure(['ack', 'result', 'status'].includes(message.type), 'PROTOCOL', 'Evento não suportado.');
  v.id(message.jobId); v.id(message.attemptId);
  ensure(typeof message.token === 'string' && /^[a-f0-9]{64}$/.test(message.token), 'PROTOCOL', 'Token inválido.');
  if (message.type === 'result') {
    ensure(['completed', 'rejected'].includes(message.outcome), 'PROTOCOL', 'Resultado inválido.');
    v.text(message.stdout, v.LIMITS.output, 'stdout', true); v.text(message.stderr, v.LIMITS.output, 'stderr', true);
    ensure(typeof message.truncated === 'boolean', 'PROTOCOL', 'Indicador de truncamento obrigatório.');
    if (message.outcome === 'completed') v.integer(message.exitCode, -2147483648, 4294967295, 'Exit code');
    else { ensure(message.exitCode === null, 'PROTOCOL', 'Recusa não tem exit code.'); v.text(message.reason, 200, 'Motivo'); }
  }
  if (message.type === 'status') ensure(['running', 'unknown', 'not_found'].includes(message.state), 'PROTOCOL', 'Status inválido.');
  return message;
}
function envelope(type, job, attempt) {
  return { action: 'plugin', plugin: 'meshtask2', version: VERSION, type, jobId: job.id, attemptId: attempt.id, token: attempt.token };
}
function resultData(message) {
  return { outcome: message.outcome, exitCode: message.exitCode, stdout: message.stdout, stderr: message.stderr, truncated: message.truncated, ...(message.outcome === 'rejected' ? { reason: message.reason } : {}) };
}
function execution(snapshot, job, attempt) {
  const { scriptId, revision, engine, body, hash } = snapshot;
  // Fleet targets and actor information are server-only, not needed by a runner.
  return v.bounded({ ...envelope('execute', job, attempt), context: 'service', script: { scriptId, revision, engine, body, hash } });
}
function assertDispatchable(snapshot) {
  // Reserve maximum identifier sizes before accepting a snapshot. This is only
  // a byte-budget calculation, never an execution message or credential.
  v.bounded({ ...execution(snapshot, { id: 'x'.repeat(128) }, { id: 'x'.repeat(128), token: '0'.repeat(64) }), domain: 'd'.repeat(128), node: 'n'.repeat(512), bootNonce: '9'.repeat(78), requestNonce: '9'.repeat(78), grantTtlMs: 10000 });
}
module.exports = { VERSION, incoming, envelope, resultData, execution, assertDispatchable };
