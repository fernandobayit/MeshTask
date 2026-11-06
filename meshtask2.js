'use strict';
const { Store, runtime } = require('./lib/store');
const { Service } = require('./lib/service');
const { Dispatcher } = require('./lib/dispatcher');
const { AdminAPI, REASON } = require('./lib/api');
const { Lifecycle, isPluginOwner } = require('./lib/lifecycle');
const { ensure } = require('./lib/errors');
const mesh = require('./lib/meshcentral');
const v = require('./lib/validate');
const native = require('./ui/native');

// Factory/import do not start storage, timers or I/O. MeshCentral ignores hook
// promises: ready and all hook rejections have explicit handlers.
module.exports.meshtask2 = function meshtask2(pluginHandler) {
  runtime();
  const root = pluginHandler && pluginHandler.parent;
  ensure(root && root.config, 'RUNTIME', 'pluginHandler.parent obrigatório.');
  let store, service, dispatcher, api, transport, lifecycle, closing = false, closePromise;
  const active = () => !closing && Boolean(lifecycle && lifecycle.active());
  const plugin = {
    exports: ['createAdmin', 'createBridge', ...Object.keys(native)],
    createAdmin: require('./ui/admin').createAdmin,
    createBridge: require('./ui/bridge').createBridge,
    ...native,
    lastError: null,
    server_startup() {
      if (plugin.ready) return plugin.ready;
      const options = root.config.settings && root.config.settings.meshtask2;
      ensure(options && typeof options.database === 'string' && options.database !== ':memory:', 'STORAGE', 'Configure settings.meshtask2.database em diretório privado antes de iniciar.');
      ensure(root.webserver && isPluginOwner(pluginHandler, plugin), 'RUNTIME', 'Plugin deve estar registrado no loader MeshCentral.');
      ensure(options.executionMode === undefined || ['disabled', 'direct-control-v1'].includes(options.executionMode), 'RUNTIME', 'Modo de execução não suportado.');
      const enabled = options.executionMode === 'direct-control-v1';
      ensure(!enabled || (!root.multiServer && !root.config.peers), 'RUNTIME', 'Execução exige servidor único, sem peer/HA.');
      const intervalMs = options.intervalMs === undefined ? 1000 : v.integer(options.intervalMs, 100, 60000, 'Intervalo do scheduler');
      const previous = root.__meshtask2Owner;
      root.__meshtask2Owner = plugin;
      const stopped = previous && previous !== plugin ? previous.close() : Promise.resolve();
      plugin.ready = Promise.resolve(stopped).then(() => {
        if (closing || !isPluginOwner(pluginHandler, plugin)) return;
        const opened = new Store(options.database);
        try {
          const auth = (id, domain, nodes) => mesh.authorize(root.webserver, { id, domain, admin: true }, nodes);
          transport = mesh.transport(root.webserver, { enabled, active });
          service = new Service(opened);
          dispatcher = new Dispatcher(opened, { transport, authorize: auth, active });
          dispatcher.recover();
          store = opened;
          api = new AdminAPI(service, root.webserver, () => ({
            executionEnabled: enabled && active(),
            reason: enabled ? 'Modo direct-control-v1; capacidades verificadas por nó, homologação E2E pendente.' : REASON,
            scheduler: 'automatic-single-flight', lastError: plugin.lastError
          }), active);
          lifecycle = new Lifecycle({ intervalMs,
            isOwner: () => !closing && isPluginOwner(pluginHandler, plugin),
            run: async (isActive) => {
              dispatcher.expire();
              const jobs = await service.tickSchedules(auth, isActive);
              if (isActive()) await transport.poll();
              if (isActive()) await dispatcher.dispatch();
              return jobs;
            },
            onStop: () => {
              transport.close(); opened.close(); store = service = dispatcher = api = null;
              if (root.__meshtask2Owner === plugin) delete root.__meshtask2Owner;
            },
            onError: (error) => { plugin.lastError = error.code || 'INTERNAL'; }
          });
          lifecycle.start();
        } catch (error) { opened.close(); store = null; throw error; }
      });
      plugin.ready.catch((error) => { plugin.lastError = error.code || 'INTERNAL'; });
      return plugin.ready;
    },
    async tick() {
      if (plugin.ready) await plugin.ready;
      ensure(store && active(), 'UNAVAILABLE', 'Plugin não iniciado ou encerrando.');
      return lifecycle.tick();
    },
    hook_agentCoreIsStable(connection, webserver) {
      // No hook await upstream; contain errors and rely on the next automatic poll.
      if (!active() || webserver !== root.webserver) return;
      try {
        const identity = mesh.agentIdentity(connection, webserver);
        transport.send(identity.domain, identity.node, { action: 'plugin', plugin: 'meshtask2', version: 1, type: 'poll', ...identity }).catch(() => {});
      } catch { /* Nonregistered connection is never trusted. */ }
    },
    async serveraction(command, connection, webserver) {
      try {
        ensure(webserver === root.webserver, 'FORBIDDEN', 'Webserver não reconhecido.');
        if (plugin.ready) await plugin.ready;
        ensure(store && active(), 'UNAVAILABLE', 'Plugin não iniciado ou encerrando.');
        if (connection && connection.user) {
          const result = await api.request(connection, command);
          mesh.userIdentity(connection, webserver);
          const response = JSON.stringify({ action: 'plugin', plugin: 'meshtask2', version: 1, type: 'response', method: 'onMessage', requestId: command.requestId, op: command.op, ok: true, result });
          ensure(Buffer.byteLength(response) <= v.LIMITS.response, 'RESPONSE_TOO_LARGE', 'Resposta excessiva; consulte páginas menores do histórico.');
          connection.ws.send(response);
        } else {
          const identity = mesh.agentIdentity(connection, webserver);
          if (command.type === 'pull' || command.type === 'capability') transport.register(connection, command);
          else {
            const accepted = dispatcher.receive(identity, command);
            if (command.type === 'result' && accepted.accepted) {
              // Receipt only after durable result commit. Lost receipts cause safe
              // result retries, never another process spawn.
              await transport.send(identity.domain, identity.node, { action: 'plugin', plugin: 'meshtask2', version: 1, type: 'receipt', jobId: command.jobId, attemptId: command.attemptId, token: command.token });
            }
          }
        }
      } catch (error) {
        try {
          if (webserver === root.webserver && connection && connection.user) {
            mesh.userIdentity(connection, webserver); v.id(command.requestId); v.text(command.op, 64, 'Operação');
            connection.ws.send(JSON.stringify({ action: 'plugin', plugin: 'meshtask2', version: 1, type: 'response', method: 'onMessage', requestId: command.requestId, op: command.op, ok: false, error: { code: error.code || 'INTERNAL', message: error.name === 'TaskError' ? error.message : 'Falha interna; consulte o estado antes de repetir.' } }));
          }
        } catch { /* Never leak state to unauthorized sessions. */ }
        return false;
      }
      return true;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; // Synchronous barrier for pending ACL and send operations.
      if (lifecycle) closePromise = lifecycle.stop();
      else closePromise = Promise.resolve(plugin.ready).catch(() => {}).then(() => {
        if (lifecycle) return lifecycle.stop();
        if (root.__meshtask2Owner === plugin) delete root.__meshtask2Owner;
      });
      closePromise.catch((error) => { plugin.lastError = error.code || 'INTERNAL'; });
      return closePromise;
    }
  };
  return plugin;
};
