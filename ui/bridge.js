/* Correlated bridge over an already authenticated host transport. Never retries. */
(function (scope) {
  'use strict';
  function createBridge(send, options) {
    options = options || {};
    const pending = new Map();
    const timeoutMs = options.timeoutMs || 15000;
    const nonce = options.nonce || (() => {
      if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') throw new Error('Gerador criptográfico indisponível.');
      return crypto.randomUUID();
    });
    let closed = false;
    return {
      request(op, input) {
        if (closed) return Promise.reject(new Error('Ponte encerrada.'));
        if (pending.size >= 32) return Promise.reject(new Error('Muitas solicitações pendentes.'));
        return new Promise((resolve, reject) => {
          const requestId = nonce();
          if (pending.has(requestId)) { reject(new Error('ID de solicitação repetido.')); return; }
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error('Resposta não recebida. Resultado da alteração desconhecido; consulte o histórico, sem reenvio automático.'));
          }, timeoutMs);
          pending.set(requestId, { resolve, reject, timer, op });
          try { send({ action: 'plugin', plugin: 'meshtask2', version: 1, type: 'request', requestId, op, input: input || {} }); }
          catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
        });
      },
      receive(message) {
        if (!message || message.action !== 'plugin' || message.plugin !== 'meshtask2' || message.version !== 1 || message.type !== 'response') return false;
        const call = pending.get(message.requestId);
        if (!call || call.op !== message.op || typeof message.ok !== 'boolean') return false;
        clearTimeout(call.timer); pending.delete(message.requestId);
        if (message.ok) call.resolve(message.result);
        else call.reject(new Error(message.error && message.error.message || 'Operação recusada.'));
        return true;
      },
      close() {
        closed = true;
        for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Conexão encerrada; resultado desconhecido.')); }
        pending.clear();
      }
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createBridge };
  if (scope) scope.MeshTask2Bridge = { createBridge };
}(typeof window === 'undefined' ? null : window));
