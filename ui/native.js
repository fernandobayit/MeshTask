/* Native MeshCentral integration. Every exported function must survive
 * pluginHandler.prepExports(): function.toString(), without module closures.
 * Uses the existing authenticated control channel and the p42 admin page.
 * Browser visibility is not authorization; the server validates every request.
 */
function createNativeUI() {
  'use strict';
  const host = pluginHandler.meshtask2;
  const server = typeof meshserver === 'undefined' ? null : meshserver;
  if (!server || typeof server.send !== 'function') throw new Error('Sessão MeshCentral indisponível.');
  if (window.__meshtask2Native) window.__meshtask2Native.dispose();
  let disposed = false;
  let connected = server.State === 2;
  let freshIdentity = connected;
  let holder, opener, panel, notice;
  let controller;
  const previousMessage = server.onMessage;
  const previousState = server.onStateChanged;

  function allowed() {
    return !disposed && connected && freshIdentity && typeof userinfo !== 'undefined' && userinfo && userinfo.siteadmin === 0xFFFFFFFF;
  }
  function close() {
    if (host.view) host.view.destroy();
    if (host.bridge) host.bridge.close();
    host.view = host.bridge = null;
    if (panel) panel.hidden = true;
    if (opener) { opener.textContent = 'Abrir MeshTask 2'; opener.setAttribute('aria-expanded', 'false'); }
  }
  function remove() {
    close();
    if (holder) holder.remove();
    holder = opener = panel = notice = null;
  }
  function sync() {
    const page = document.getElementById('p42');
    if (!allowed() || !page) { remove(); return false; }
    if (holder && holder.parentNode !== page) remove();
    if (!holder) {
      holder = document.createElement('section');
      holder.id = 'meshtask2-native';
      holder.setAttribute('aria-label', 'MeshTask 2 — Administração');
      opener = document.createElement('button');
      opener.type = 'button';
      opener.id = 'meshtask2-open';
      opener.textContent = 'Abrir MeshTask 2';
      opener.setAttribute('aria-controls', 'meshtask2-admin');
      opener.setAttribute('aria-expanded', 'false');
      notice = document.createElement('p');
      notice.setAttribute('role', 'status');
      panel = document.createElement('div');
      panel.id = 'meshtask2-admin';
      panel.hidden = true;
      opener.addEventListener('click', () => {
        if (host.view) { close(); return; }
        try { open(); }
        catch (error) { if (notice) notice.textContent = error.message; }
      });
      holder.appendChild(opener);
      holder.appendChild(notice);
      holder.appendChild(panel);
      page.appendChild(holder);
    }
    return true;
  }
  function open() {
    if (!sync()) throw new Error('Administrador conectado obrigatório; interface indisponível.');
    if (typeof go !== 'function') throw new Error('Navegação nativa MeshCentral indisponível.');
    go(42);
    // The host may redirect navigation (e.g. mandatory second-factor setup).
    if (typeof xxcurrentView === 'undefined' || xxcurrentView !== 42) throw new Error('A navegação para Plugins não foi autorizada pelo host.');
    if (!allowed()) { remove(); throw new Error('Administrador conectado obrigatório.'); }
    if (host.view) return host.view;
    const bridge = host.createBridge((message) => {
      if (!allowed()) throw new Error('Sessão administrativa indisponível; nenhum reenvio automático.');
      server.send(message);
    });
    host.bridge = bridge;
    try {
      panel.hidden = false;
      host.view = host.createAdmin().mount(panel, bridge);
      notice.textContent = '';
      opener.textContent = 'Fechar MeshTask 2';
      opener.setAttribute('aria-expanded', 'true');
      return host.view;
    } catch (error) { close(); throw error; }
  }
  function receive(source, message) {
    if (source !== server || !allowed()) { if (!allowed()) remove(); return false; }
    return host.bridge ? host.bridge.receive(message) : false;
  }
  // Preserve native dispatch (including method:onMessage) and all other plugins.
  // userinfo arrives AFTER onWebUIStartupEnd; sync only after host processing.
  function messageListener() {
    try { if (typeof previousMessage === 'function') return previousMessage.apply(this, arguments); }
    finally {
      if (arguments[0] === server && arguments[1] && arguments[1].action === 'userinfo') freshIdentity = connected;
      if (!disposed) sync();
    }
  }
  function stateListener(source, state) {
    connected = state === 2;
    if (!connected) { freshIdentity = false; remove(); }
    try { if (typeof previousState === 'function') return previousState.apply(this, arguments); }
    finally { if (!disposed) sync(); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    remove();
    if (server.onMessage === messageListener) server.onMessage = previousMessage;
    if (server.onStateChanged === stateListener) server.onStateChanged = previousState;
    window.removeEventListener('pagehide', dispose);
    if (window.__meshtask2Native === controller) delete window.__meshtask2Native;
  }
  controller = { sync, open, close, receive, dispose };
  server.onMessage = messageListener;
  server.onStateChanged = stateListener;
  window.addEventListener('pagehide', dispose);
  window.__meshtask2Native = controller;
  sync();
  return controller;
}
function onWebUIStartupEnd() {
  'use strict';
  const host = pluginHandler.meshtask2;
  host.native = host.createNativeUI();
}
function goPageEnd(page) {
  'use strict';
  const host = pluginHandler.meshtask2;
  if (!host.native) return;
  host.native.sync();
  if (page !== 42) host.native.close();
}
function openAdmin() {
  'use strict';
  const host = pluginHandler.meshtask2;
  if (!host.native) host.onWebUIStartupEnd();
  return host.native.open();
}
function onMessage(server, message) {
  'use strict';
  const host = pluginHandler.meshtask2;
  return host.native ? host.native.receive(server, message) : false;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createNativeUI, onWebUIStartupEnd, goPageEnd, openAdmin, onMessage };
}
