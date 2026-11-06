'use strict';
const v = require('./validate');
const { ensure, TaskError } = require('./errors');
function userIdentity(session, webserver) {
  ensure(session && session.user && session.domain && session.ws && webserver, 'FORBIDDEN', 'Sessão de usuário autenticada obrigatória.');
  const ws = session.ws;
  ensure(typeof ws.sessionId === 'string' && webserver.wssessions2 && webserver.wssessions2[ws.sessionId] === ws, 'FORBIDDEN', 'Sessão não registrada.');
  const user = webserver.users && webserver.users[session.user._id];
  ensure(user && user._id === session.user._id && user.domain === session.domain.id && user.siteadmin === 0xFFFFFFFF, 'FORBIDDEN', 'Administrador ativo do domínio obrigatório.');
  return v.admin({ id: user._id, domain: session.domain.id, admin: true, allowedNodes: [] });
}
function agentIdentity(connection, webserver) {
  ensure(connection && connection.authenticated === 2 && connection.domain && webserver && webserver.wsagents && webserver.wsagents[connection.dbNodeKey] === connection, 'FORBIDDEN', 'Agente autenticado e registrado obrigatório.');
  const domain = v.domain(connection.domain.id), node = v.node(connection.dbNodeKey, domain);
  return { domain, node };
}
async function authorize(webserver, actor, nodes, timeoutMs = 5000) {
  v.admin(actor);
  ensure(Array.isArray(nodes) && nodes.length <= v.LIMITS.targets, 'INVALID', 'Destinos inválidos.');
  const user = webserver.users && webserver.users[actor.id];
  ensure(user && user.siteadmin === 0xFFFFFFFF && user.domain === actor.domain, 'FORBIDDEN', 'Administrador não autorizado.');
  const domain = webserver.parent && webserver.parent.config && webserver.parent.config.domains && webserver.parent.config.domains[actor.domain];
  ensure(domain && domain.id === actor.domain && typeof webserver.GetNodeWithRights === 'function', 'RUNTIME', 'API de domínio/permissões indisponível.');
  const allowedNodes = await Promise.all([...new Set(nodes)].map((nodeId) => {
    v.node(nodeId, actor.domain);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new TaskError('AUTH_TIMEOUT', 'Consulta de permissões expirou.')), timeoutMs);
      try {
        webserver.GetNodeWithRights(domain, user, nodeId, (node, rights, visible) => {
          clearTimeout(timer);
          try {
            ensure(node && node._id === nodeId && node.domain === actor.domain && visible === true && rights === 0xFFFFFFFF, 'FORBIDDEN', 'Nó não autorizado no domínio.');
            resolve(nodeId);
          } catch (error) { reject(error); }
        });
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  }));
  // Recheck revocation after asynchronous lookups.
  ensure(webserver.users[actor.id] === user && user.siteadmin === 0xFFFFFFFF, 'FORBIDDEN', 'Permissão alterada durante consulta.');
  return { ...actor, allowedNodes };
}
function transport(webserver, options) {
  return require('./pull-transport').createPullTransport(webserver, agentIdentity, options);
}
module.exports = { userIdentity, agentIdentity, authorize, transport };
