'use strict';
const { ensure, TaskError } = require('./errors');
const v = require('./validate');
// No authorization is derived from message-supplied node/domain. Sessions are
// bound to the registered MeshAgent connection and have one pending pull only.
function createPullTransport(webserver, identityOf, { enabled = false, clock = Date.now, active = () => true } = {}) {
  const sessions = new Map();
  function connection(domain, node) {
    const agent = webserver.wsagents && webserver.wsagents[node];
    const id = identityOf(agent, webserver);
    ensure(id.domain === domain && id.node === node, 'FORBIDDEN', 'Destino incorreto.');
    return agent;
  }
  function sendTo(agent, message) {
    ensure(active(), 'UNAVAILABLE', 'Plugin encerrando.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new TaskError('TRANSPORT_TIMEOUT', 'Entrega não confirmada.')), 5000);
      try { agent.send(JSON.stringify(message), (error) => { clearTimeout(timer); error ? reject(error) : resolve(); }); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  function pending(domain, node, engine) {
    if (!enabled || !active()) return null;
    const state = sessions.get(node);
    if (!state || state.domain !== domain || state.connection !== webserver.wsagents[node] || state.connection.authenticated !== 2 || state.expires <= clock() || !state.requestNonce || !state.engines.includes(engine)) return null;
    return state;
  }
  return {
    register(agent, message) {
      const id = identityOf(agent, webserver);
      v.bounded(message);
      ensure(message.action === 'plugin' && message.plugin === 'meshtask2' && message.version === 1 && ['pull', 'capability'].includes(message.type), 'PROTOCOL', 'Pull inválido.');
      if (message.type === 'capability') {
        v.text(message.reason, 200, 'Motivo'); sessions.delete(id.node); return false;
      }
      ensure(Object.keys(message).every((key) => ['action', 'plugin', 'version', 'type', 'bootNonce', 'requestNonce', 'engines', 'reason'].includes(key)), 'PROTOCOL', 'Campos de pull inválidos.');
      ensure(typeof message.bootNonce === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(message.bootNonce) && typeof message.requestNonce === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(message.requestNonce), 'PROTOCOL', 'Nonce inválido.');
      ensure(Array.isArray(message.engines) && message.engines.length <= 2 && message.engines.every((engine) => ['bash', 'powershell'].includes(engine)), 'PROTOCOL', 'Capabilities inválidas.');
      if (message.reason !== undefined) v.text(message.reason, 200, 'Motivo', true);
      const prior = sessions.get(id.node);
      // Repeated hello/pull cannot replenish an already consumed request or TTL.
      if (prior && prior.connection === agent && prior.bootNonce === message.bootNonce && prior.lastNonce === message.requestNonce) return false;
      sessions.set(id.node, { domain: id.domain, connection: agent, bootNonce: message.bootNonce, requestNonce: message.requestNonce, lastNonce: message.requestNonce, engines: message.engines.slice(), expires: clock() + 10000 });
      return true;
    },
    canSend(domain, node, engine) { return Boolean(pending(domain, node, engine)); },
    prepare(domain, node, engine) {
      const state = pending(domain, node, engine);
      ensure(state, 'UNAVAILABLE', 'Solicitação do agente indisponível.');
      return { domain, node, bootNonce: state.bootNonce, requestNonce: state.requestNonce, grantTtlMs: 10000 };
    },
    async send(domain, node, message) {
      const agent = connection(domain, node);
      ensure(['execute', 'query', 'poll', 'receipt'].includes(message.type), 'PROTOCOL', 'Envio não permitido.');
      if (message.type === 'execute') {
        const state = pending(domain, node, message.script && message.script.engine);
        ensure(state && state.bootNonce === message.bootNonce && state.requestNonce === message.requestNonce && message.domain === domain && message.node === node, 'UNAVAILABLE', 'Grant sem pull ativo.');
        state.requestNonce = null; // Claim has already committed; never restore on send failure.
      }
      return sendTo(agent, message);
    },
    async poll() {
      if (!enabled || !active()) return;
      // Bound each tick; rotate through large connected fleets fairly.
      const nodes = Object.keys(webserver.wsagents || {});
      const start = this.cursor || 0;
      const work = [];
      for (let i = 0; i < Math.min(nodes.length, 100); i++) {
        const node = nodes[(start + i) % nodes.length];
        try {
          const agent = webserver.wsagents[node], id = identityOf(agent, webserver);
          work.push(sendTo(agent, { action: 'plugin', plugin: 'meshtask2', version: 1, type: 'poll', domain: id.domain, node: id.node }).catch(() => {}));
        } catch { /* Offline or unregistered nodes cannot receive dispatch. */ }
      }
      this.cursor = nodes.length ? (start + 100) % nodes.length : 0;
      for (const [node, state] of sessions) if (webserver.wsagents[node] !== state.connection) sessions.delete(node);
      await Promise.all(work);
    },
    close() { sessions.clear(); }
  };
}
module.exports = { createPullTransport };
