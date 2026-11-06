'use strict';
const { createHash } = require('node:crypto');
const { ensure } = require('./errors');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function mutate(store, actor, requestId, op, input, fn) {
  const digest = createHash('sha256').update(JSON.stringify([op, canonical(input)])).digest('hex');
  return store.transaction(() => {
    const previous = store.get('SELECT hash,result FROM admin_requests WHERE domain=? AND actor=? AND request_id=?', actor.domain, actor.id, requestId);
    if (previous) {
      ensure(previous.hash === digest, 'REPLAY_CONFLICT', 'requestId reutilizado com operação/conteúdo diferente.');
      return JSON.parse(previous.result);
    }
    const result = fn();
    store.run('INSERT INTO admin_requests VALUES(?,?,?,?,?,?)', actor.domain, actor.id, requestId, digest, JSON.stringify(result), Date.now());
    return result;
  });
}
module.exports = { mutate };
