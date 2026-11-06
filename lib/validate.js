'use strict';
const { ensure } = require('./errors');
const LIMITS = Object.freeze({ message: 196608, response: 1048576, script: 65536, output: 32768, targets: 100, list: 200 });
function text(value, max, name, empty = false) {
  ensure(typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= max && !value.includes('\0'), 'INVALID', `${name} inválido ou excessivo.`);
  return value;
}
function object(value) { ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID', 'Objeto esperado.'); return value; }
function bounded(value) { object(value); ensure(Buffer.byteLength(JSON.stringify(value), 'utf8') <= LIMITS.message, 'TOO_LARGE', 'Payload excessivo.'); return value; }
function id(value) { text(value, 128, 'ID'); ensure(/^[a-zA-Z0-9_-]+$/.test(value), 'INVALID', 'ID inválido.'); return value; }
function integer(value, min, max, name) { ensure(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID', `${name} inválido.`); return value; }
function domain(value) { text(value, 128, 'Domínio', true); ensure(!/[\/\s]/.test(value), 'FORBIDDEN', 'Domínio inválido.'); return value; }
function node(value, domainId) {
  text(value, 512, 'Nó'); const parts = value.split('/');
  ensure(parts.length === 3 && parts[0] === 'node' && parts[1] === domainId && /^[a-zA-Z0-9_@$+=.-]+$/.test(parts[2]), 'FORBIDDEN', 'Nó fora do domínio ou inválido.');
  return value;
}
function admin(actor) {
  object(actor); domain(actor.domain); text(actor.id, 512, 'Usuário');
  ensure(actor.admin === true && actor.id.startsWith(`user/${actor.domain}/`), 'FORBIDDEN', 'Administrador do domínio obrigatório.'); return actor;
}
function targets(actor, values) {
  admin(actor); ensure(Array.isArray(values) && values.length > 0 && values.length <= LIMITS.targets, 'INVALID', 'Lista explícita de 1 a 100 nós obrigatória.');
  const result = [...new Set(values.map((value) => node(value, actor.domain)))];
  ensure(Array.isArray(actor.allowedNodes) && result.every((value) => actor.allowedNodes.includes(value)), 'FORBIDDEN', 'Sem autorização para um ou mais nós.');
  return result;
}
function context(value) { ensure(value === 'service', 'UNSUPPORTED_CONTEXT', 'Somente contexto de serviço é suportado.'); }
function script(input) {
  bounded(input); context(input.context); text(input.name, 200, 'Nome'); text(input.body, LIMITS.script, 'Script');
  ensure(['bash', 'powershell'].includes(input.engine), 'INVALID', 'Interpretador não suportado.');
}
function utc(value) {
  text(value, 24, 'Data UTC'); ensure(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value), 'INVALID', 'Use data UTC com Z.');
  const time = Date.parse(value); ensure(Number.isFinite(time) && new Date(time).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')), 'INVALID', 'Data inexistente.'); return time;
}
module.exports = { LIMITS, text, object, bounded, id, integer, domain, node, admin, targets, context, script, utc };
