

var scriptTree = null;
var elementDragged = false;
var draggedId = null;
var nodesObj = {};
var variables = [];
var varScopes = { global: 'Global', script: 'Script', mesh: 'Mesh', node: 'Node' };
var mtCurrentTab = 'scripts';
var mtEditDoc = null;
var mtSchedScriptId = null;
var mtSchedNodes = [];
var mtPreviewTimer = null;
var mtSchedIsCommand = false;
var mtSchedCommand = '';
var mtSchedCommandType = 'bash';
var mtIsGlobal = (window.location.search.indexOf('global=1') >= 0);
// Wrapper: hide overlay when a native MC dialog opens, re-show on close.
// MC dialogs use z-index:1000, our overlay at 999 would be behind them otherwise.
(function () {
    if (!mtIsGlobal) return;
    var pset = parent.setDialogMode;
    if (typeof pset !== 'function') return;
    parent.setDialogMode = function (x, y, b, f, c, tag) {
        var ov = parent.document.getElementById('mtGlobalOverlay');
        if (ov) { ov.style.display = (x ? 'none' : 'flex'); }
        return pset(x, y, b, f, c, tag);
    };
})();
var mtSelectedDeviceId = null;

function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function mtToast(msg, kind) {
    var el = Q('mtToast');
    el.className = (kind || '');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(mtToast._t);
    mtToast._t = setTimeout(function () { el.style.display = 'none'; }, 4200);
}
function resizeIframe() {
    document.body.style.height = 0;
    parent.pluginHandler.scripttask.resizeContent();
}

// ===== contexto: device corrente (aba device) ou selecionado (global) =====
function mtGlobalNode() {
    if (mtIsGlobal) {
        if (mtSelectedDeviceId && parent.nodes) {
            var found = parent.nodes.filter(function (n) { return n._id == mtSelectedDeviceId; });
            if (found.length) return found[0];
        }
        return null;
    }
    return parent.currentNode;
}

// ===== abas =====
function mtShowTab(name, el) {
    mtCurrentTab = name;
    var tabs = Q('mtTabs').querySelectorAll('span');
    tabs.forEach(function (t) { t.classList.remove('on'); });
    if (el) el.classList.add('on');
    QV('tab-schedule', name == 'schedule');
    QV('tab-history', name == 'history');
    QV('tab-vars', name == 'vars');
    QV('mtScriptDetail', name == 'scripts');
    QV('mtTreePane', name == 'scripts');
    if (name == 'schedule') {
        parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadAllSchedules' });
    }
    if (name == 'history') {
        var ctx = mtGlobalNode();
        if (ctx && ctx._id) parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadNodeHistory', nodeId: ctx._id });
        var sid = selectedScriptId();
        if (sid) parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadScriptHistory', scriptId: sid });
    }
    if (name == 'vars') {
        parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadVariables' });
    }
    renderToolbar();
    resizeIframe();
}

// ===== toolbar superior — SÓ ações globais =====
function renderToolbar() {
    var bar = document.getElementById('mtToolbar');
    var ctxPicker = mtIsGlobal ? mtDevicePicker() : '';
    bar.innerHTML = ctxPicker +
        '<span class="mtBtn primary" onclick="mtCmdOpen();">⚡ Executar comando</span>' +
        '<span class="mtBtn" onclick="document.getElementById(\'files\').click();">⬆ Carregar</span>' +
        '<span class="mtBtn" onclick="goNew();">＋ Novo</span>' +
        '<span class="mtBtn" onclick="goNewFolder();">📁 Nova pasta</span>';
}
function mtDevicePicker() {
    if (!mtIsGlobal) return '';
    var opts = '<option value="">— nenhum dispositivo —</option>';
    var nodes = (parent.nodes || []).filter(function (n) { return n.mtype == 2; });
    nodes.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    nodes.forEach(function (n) {
        opts += '<option value="' + n._id + '"' + (mtSelectedDeviceId == n._id ? ' selected' : '') + '>' + esc(n.name) + '</option>';
    });
    return '<select onchange="mtSetDevice(this.value);" style="padding:3px 8px; border:1px solid #AAA; border-radius:3px; font-size:12px; margin-right:8px; max-width:240px;">' + opts + '</select>';
}
function mtSetDevice(nodeId) {
    mtSelectedDeviceId = (nodeId && nodeId != '') ? nodeId : null;
    renderToolbar();
    if (mtCurrentTab == 'schedule') parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadAllSchedules' });
    var ctx = mtGlobalNode();
    if (ctx && ctx._id) parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadNodeHistory', nodeId: ctx._id });
    var sid = selectedScriptId();
    if (sid) parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadScriptHistory', scriptId: sid });
}

// ===== árvore =====
function redrawScriptTree() {
  var lastpath = null;
  var str = '';
  var indent = 0;
  var folder_id = null;
  str += '<div style="display: block;overflow-y: auto;">'
  scriptTree.forEach(function(f) {
    if (f.path != lastpath && f.type == 'folder') {
      indent = (f.path.match(/\//g) || []).length + 1;
      var name = f.path.match(/[^\/]+$/);
      folder_id = f._id;
      str += '<div draggable="true" x-data-path="' + f.path + '" x-data-id="' + f._id + '" x-data-folder="' + folder_id + '" style="margin-left: ' + indent + 'em;" class="lifolder" onclick="toggleCollapse(this);"><span class="fname">' + name + '</span></div>';
      lastpath = f.path;
      indent += 1;
    }
    if (f.type != 'folder') {
        str += '<div id="' + f._id + '" draggable="true" x-data-path="' + f.path + '" x-data-id="' + f._id + '" x-data-folder="' + folder_id + '" style="margin-left: ' + indent + 'em;" class="liscript" onclick="goScript(this);"><span class="fname">' + f.name + '</span> [<span class="ftype">' + f.filetype + '</span>]</div>';
    }
  });
  str += '</div>';
  document.getElementById('scriptContainer').innerHTML = str;
  var liScripts = document.querySelectorAll('.liscript');
  var liFolders = document.querySelectorAll('.lifolder');
  liScripts.forEach(function(el) {
    el.addEventListener('mousedown', function() { elementDragged = true; });
    el.addEventListener('mouseup', function() { elementDragged = false; });
    el.addEventListener('dragstart', function(evt) { evt.dataTransfer.setData('text/plain', evt.target.getAttribute('x-data-id')); });
  });
  liFolders.forEach(function(el) {
    el.addEventListener('drop', dropMove);
    el.addEventListener('dragover', function(e) { e.preventDefault(); });
    el.addEventListener('mousedown', function() { elementDragged = true; });
    el.addEventListener('mouseup', function() { elementDragged = false; });
    el.addEventListener('dragstart', function(evt) { evt.dataTransfer.setData('text/plain', evt.target.getAttribute('x-data-id')); });
  });
  selectPreviouslySelectedScript();
}
function getScriptById(id) {
    return scriptTree.filter(function (s) { return s._id == id; })[0] || null;
}
function selectedScriptId() {
    var sel = document.querySelectorAll('.liselected');
    if (!sel.length) return null;
    var el = sel[0];
    if (el.getAttribute('x-data-id') == el.getAttribute('x-data-folder')) return null; // pasta
    return el.getAttribute('x-data-id');
}
function selectedFolderId() {
    var sel = document.querySelectorAll('.liselected');
    if (!sel.length) return null;
    return sel[0].getAttribute('x-data-folder');
}

// ===== painel do script — SÓ Editar/Baixar/Renomear/Excluir =====
function renderScriptDetail() {
    var id = selectedScriptId();
    var box = Q('mtScriptDetail');
    if (id == null) {
        box.innerHTML = '<div class="mtSectionTitle">📜 Script</div><div class="mtEmpty">Selecione um script na árvore.</div>';
        return;
    }
    var s = getScriptById(id);
    if (s == null) return;
    box.innerHTML =
        '<div class="mtSectionTitle">📜 ' + esc(s.name) + ' <span class="ftype">[' + s.filetype + ']</span></div>' +
        '<div style="margin: 8px 0;">' +
        '<span class="mtBtn" onclick="goRun();">▶ Run</span> ' +
        '<span class="mtBtn" onclick="mtSchedOpen();">⏰ Agendar</span> ' +
        '<span class="mtBtn" onclick="mtEditorOpen();">✎ Editar</span> ' +
        '<span class="mtBtn" onclick="goDownload();">⬇ Baixar</span> ' +
        '<span class="mtBtn" onclick="goRename();">Renomear</span> ' +
        '<span class="mtBtn danger" onclick="goDelete();">🗑 Excluir</span>' +
        '</div>' +
        '<div class="mtHint">Caminho: ' + esc(s.path) + '</div>';
}
function goRun() {
    var id = selectedScriptId();
    if (id == null) { mtToast('Selecione um script.', 'err'); return; }
    var ctx = mtGlobalNode();
    if (!ctx || !ctx._id) { mtToast('Nenhum dispositivo disponível.', 'err'); return; }
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'runScript', scriptId: id, nodes: [ctx._id], currentNodeId: ctx._id });
    mtToast('Execução enfileirada.', 'ok');
    mtShowTab('history', Q('mtTabs').querySelectorAll('span')[2]);
}

// ===== seleção =====
function goScript(el) {
    var xdi = el.getAttribute('x-data-id');
    var isFolder = (xdi == el.getAttribute('x-data-folder'));
    var scriptEls = document.querySelectorAll('.liselected');
    parent.putstore('_scripttask_sel_item', xdi);
    scriptEls.forEach(function(e) { e.classList.remove('liselected'); });
    el.classList.add('liselected');
    renderScriptDetail();
    if (!isFolder) {
        parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadScriptHistory', scriptId: xdi });
    }
}
function selectPreviouslySelectedScript() {
    var sel_item = parent.getstore('_scripttask_sel_item', null);
    if (sel_item != null) {
        var s = document.getElementById(sel_item);
        if (s != null) {
            s.classList.toggle('liselected');
            goScript(s);
            return;
        }
    }
    renderScriptDetail();
}

// ===== ações de script =====
function goDownload() {
    var id = selectedScriptId();
    if (id == null) return;
    window.location = '/pluginadmin.ashx?pin=scripttask&user=1&dl=' + id;
}
function addScript(name, content, path) {
    var n = name.split('.').pop().toLowerCase();
    if (content.split('\n')[0][0] == '#' && content.split('\n')[0][1] == '!') n = 'bash';
    if (['ps1', 'bat', 'bash'].indexOf(n) !== -1) {
        parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'addScript', name: name, content: content, path: path, filetype: n });
    } else {
        mtToast('Tipos aceitos: .ps1, .bat e scripts bash.', 'err');
    }
}
function renameEx() {
    var name = parent.document.getElementById('stfilename').value;
    var id = parent.document.getElementById('stid').value;
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'rename', name: name, id: id, currentNodeId: (mtGlobalNode() || {})._id });
}
function goRename() {
    var id = selectedScriptId();
    if (id == null) { mtToast('Selecione um script ou pasta.', 'err'); return; }
    var el = document.querySelectorAll('.liselected')[0];
    var name = el.querySelector('.fname').innerHTML;
    parent.setDialogMode(2, "Renomear", 3, renameEx, '<input type="text" value="' + esc(name) + '" id=stfilename style=width:100% /><input type="hidden" id="stid" value="' + id + '" />');
    parent.focusTextBox('stfilename');
}
function newEx() {
    var name = parent.document.getElementById('stfilename').value;
    var parent_id = parent.document.getElementById('stfolderid').value;
    var fileType = parent.document.getElementById('stfiletype').value;
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'new', name: name, parent_id: parent_id, filetype: fileType, currentNodeId: (mtGlobalNode() || {})._id });
}
function goNew() {
    var folder_id = selectedFolderId();
    parent.setDialogMode(2, "Novo Script", 3, newEx, 'Nome: <input type="text" id=stfilename style=width:100% /><br />Tipo: <select id="stfiletype"><option value="bash">Bash</option><option value="bat">BAT</option><option value="ps1">PS1</option></select><input type="hidden" id="stfolderid" value="' + folder_id + '" />');
    parent.focusTextBox('stfilename');
}
function newFolderEx() {
    var name = parent.document.getElementById('stfoldername').value;
    var parent_id = parent.document.getElementById('stfolderid').value;
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'newFolder', name: name, parent_id: parent_id });
}
function goNewFolder() {
    var folder_id = selectedFolderId();
    parent.setDialogMode(2, "Nova Pasta", 3, newFolderEx, '<input type="text" id=stfoldername style=width:100% /><input type="hidden" id="stfolderid" value="' + folder_id + '" />');
    parent.focusTextBox('stfoldername');
}
function deleteEx() {
    var id = parent.document.getElementById('stdelid').value;
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'delete', id: id });
}
function goDelete() {
    var els = document.querySelectorAll('.liselected');
    if (!els.length) return;
    var name = els[0].querySelector('.fname').innerHTML;
    parent.setDialogMode(2, "Excluir " + name, 3, deleteEx, 'Confirma a exclusão? <input type="hidden" id="stdelid" value="' + els[0].getAttribute('x-data-id') + '" />');
}
function deleteScheduleEx() {
    var id = parent.document.getElementById('stdelid').value;
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'delete', id: id });
}
function deleteSchedule(el) {
    var id = el.parentNode.parentNode.getAttribute('x-data-id');
    parent.setDialogMode(2, "Excluir agendamento", 3, deleteScheduleEx, 'Confirma a exclusão deste agendamento? <input type="hidden" id="stdelid" value="' + id + '" />');
}
function toggleCollapse(el) {
    var xdf = el.getAttribute('x-data-path');
    var folderEls = document.querySelectorAll('.lifolder, .liscript');
    var showHide = null;
    folderEls.forEach(function(e){
        if (e === el) return;
        if (e.getAttribute('x-data-path').indexOf(xdf) !== -1) {
            if (e.style.display == 'none') { if (showHide === null) showHide = ''; }
            else { if (showHide === null) showHide = 'none'; }
            e.style.display = showHide;
        }
    });
    goScript(el);
}

// ===== editor de script (textarea flex:1) =====
function mtEditorOpen() {
    var id = selectedScriptId();
    if (id == null) { mtToast('Selecione um script para editar.', 'err'); return; }
    var s = getScriptById(id);
    if (s == null) return;
    mtEditDoc = { _id: id, name: s.name, filetype: s.filetype, path: s.path };
    Q('mtEditName').value = s.name;
    Q('mtEditType').value = s.filetype;
    Q('mtEditorTitle').textContent = 'Editar script';
    Q('mtEditorContent').value = '(carregando…)';
    QV('mtEditorOverlay', true);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/pluginadmin.ashx?pin=scripttask&user=1&dl=' + id, true);
    xhr.onload = function () {
        if (xhr.status == 200) Q('mtEditorContent').value = xhr.responseText;
        else { mtToast('Falha ao carregar o script (' + xhr.status + ').', 'err'); mtEditorClose(); }
    };
    xhr.onerror = function () { mtToast('Falha ao carregar o script.', 'err'); mtEditorClose(); };
    xhr.send();
    Q('mtEditorContent').focus();
}
function mtEditorClose() {
    QV('mtEditorOverlay', false);
    mtEditDoc = null;
}
function mtEditorSave() {
    if (mtEditDoc == null) return;
    var name = Q('mtEditName').value.trim();
    var content = Q('mtEditorContent').value;
    var type = Q('mtEditType').value;
    if (!name) { mtToast('Informe o nome do script.', 'err'); return; }
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'editScript', scriptId: mtEditDoc._id, scriptType: type, scriptName: name, scriptContent: content, currentNodeId: (mtGlobalNode() || {})._id });
    mtToast('Script salvo.', 'ok');
    mtEditorClose();
}

// ===== agendador =====
function mtSchedOpen() {
    var id = selectedScriptId();
    if (id == null) { mtToast('Selecione um script para agendar.', 'err'); return; }
    var s = getScriptById(id);
    if (s == null) return;
    mtSchedIsCommand = false; mtSchedCommand = ''; mtSchedCommandType = 'bash';
    mtSchedOpenFor(id, s);
}
function mtSchedOpenFor(scriptId, scriptDoc) {
    mtSchedScriptId = scriptId;
    Q('mtSchedScriptName').textContent = scriptDoc.name + ' [' + scriptDoc.filetype + ']';
    Q('mtSchedRecur').querySelector('input[value=once]').checked = true;
    mtRecurSelected('once');
    var d = new Date();
    Q('mtStartDate').value = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    Q('mtStartTime').value = d.getHours() + ':' + d.getMinutes();
    Q('mtEndDate').value = '';
    Q('mtEndTime').value = '';
    Q('mtEndNever').checked = true;
    Q('mtFilterInput').value = '';
    QV('mtPreviewBox', false); QV('mtPreviewSummary', false); QV('mtPreviewErr', false);
    QV('mtSchedOverlay', true);
}
function mtSchedClose() { QV('mtSchedOverlay', false); mtSchedIsCommand = false; }

function mtRecurSelected(v) {
    QV('mtRowInterval', v != 'once');
    QV('mtRowEnd', v != 'once');
    QV('mtRowDays', v == 'weekly');
    var hints = { minutes: 'minuto(s)', hourly: 'hora(s)', daily: 'dia(s)', weekly: 'semana(s)' };
    QH('mtIntervalHint', hints[v] || '');
}
function mtEndNeverChanged() {
    if (Q('mtEndNever').checked) { Q('mtEndDate').value = ''; Q('mtEndTime').value = ''; }
}
function mtPreviewDebounced() {
    clearTimeout(mtPreviewTimer);
    mtPreviewTimer = setTimeout(function () { mtPreview(); }, 600);
}
function mtPreview() {
    var f = Q('mtFilterInput').value.trim();
    QH('mtPreviewErr', ''); QV('mtPreviewErr', false);
    if (f == '') { QV('mtPreviewBox', false); QV('mtPreviewSummary', false); return; }
    try {
        parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'previewTargets', filter: f });
    } catch (ex) { QH('mtPreviewErr', 'Erro ao contatar o servidor: ' + ex); QV('mtPreviewErr', true); }
}
function mtSchedSave() {
    var o = {};
    var recurEls = document.getElementsByName('mtrrecur');
    recurEls.forEach(function (el) { if (el.checked) o.recur = el.value; });
    o.startAt = Date.parse(Q('mtStartDate').value + ' ' + Q('mtStartTime').value);
    o.startAt = Math.floor(o.startAt / 1000);
    if (isNaN(o.startAt)) { mtToast('Data/hora de início inválida.', 'err'); return; }
    if (o.recur != 'once') {
        o.interval = Number(Q('mtInterval').value) || 1;
        if (Q('mtEndNever').checked) o.endAt = null;
        else {
            o.endAt = Date.parse(Q('mtEndDate').value + ' ' + Q('mtEndTime').value);
            o.endAt = Math.floor(o.endAt / 1000);
            if (isNaN(o.endAt)) { mtToast('Data/hora de fim inválida.', 'err'); return; }
        }
    }
    if (o.recur == 'weekly') {
        o.dayVals = [];
        document.getElementsByName('mtrdays').forEach(function (de) { if (de.checked) o.dayVals.push(de.value); });
        if (o.dayVals.length == 0) { mtToast('Selecione ao menos um dia da semana.', 'err'); return; }
    }
    var f = Q('mtFilterInput').value.trim();
    if (f == '') { mtToast('Informe um filtro de dispositivos.', 'err'); return; }
    o.filter = f;
    var payload = {
        action: 'plugin', plugin: 'scripttask', pluginaction: 'addScheduledJob',
        nodes: null, filter: o.filter,
        currentNodeId: (mtGlobalNode() || {})._id, schedule: o
    };
    if (mtSchedIsCommand) {
        payload.command = mtSchedCommand;
        payload.commandType = mtSchedCommandType;
    } else {
        payload.scriptId = mtSchedScriptId;
    }
    parent.meshserver.send(payload);
    mtToast('Agendamento criado.', 'ok');
    mtSchedClose();
}

// ===== resposta do preview (server dispatch → aqui) =====
parent.pluginHandler.scripttask.previewTargetsResult = function (message) {
    var ev = (message.event || message);
    // 0.1.12: atualizar o overlay de Executar Comando
    var cmdBox = document.getElementById('mtCmdPreviewBody');
    if (cmdBox && Q('mtCmdOverlay') && Q('mtCmdOverlay').style.display != 'none') {
        if (ev.error) { QH('mtCmdPreviewErr', '⚠ ' + esc(ev.error)); QV('mtCmdPreviewErr', true); QV('mtCmdPreviewBox', false); QV('mtCmdPreviewSummary', false); return; }
        QV('mtCmdPreviewErr', false);
        cmdBox.innerHTML = '';
        var nOn = 0;
        ev.targets.forEach(function (tgt) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + esc(tgt.name) + '</td><td>' + esc(tgt.group || '') + '</td><td class="stCellMono">' + esc(tgt.osdesc || '') + '</td>' +
                '<td>' + (tgt.online ? '<span class="stStatus ok">● online</span>' : '<span class="stStatus que">○ offline</span>') + '</td>';
            cmdBox.appendChild(tr);
            if (tgt.online) nOn++;
        });
        QV('mtCmdPreviewBox', true);
        QV('mtCmdPreviewSummary', true);
        QH('mtCmdPreviewSummary', '<b>' + esc(ev.describe || ev.filter) + '</b> → ' + ev.targets.length + ' dispositivo(s), ' + nOn + ' online agora');
        return;
    }
    if (Q('mtSchedOverlay').style.display == 'none') return; // agendador fechado
    if (ev.error) { QH('mtPreviewErr', '⚠ ' + ev.error); QV('mtPreviewErr', true); QV('mtPreviewBox', false); QV('mtPreviewSummary', false); return; }
    QV('mtPreviewErr', false);
    var body = Q('mtPreviewBody');
    body.innerHTML = '';
    var nOn = 0;
    ev.targets.forEach(function (tgt) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + esc(tgt.name) + '</td><td>' + esc(tgt.group || '') + '</td><td class="stCellMono">' + esc(tgt.osdesc || '') + '</td>' +
            '<td>' + (tgt.online ? '<span class="stStatus ok">● online</span>' : '<span class="stStatus que">○ offline</span>') + '</td>';
        body.appendChild(tr);
        if (tgt.online) nOn++;
    });
    QV('mtPreviewBox', true);
    QV('mtPreviewSummary', true);
    QH('mtPreviewSummary', '<b>' + esc(ev.describe) + '</b> → ' + ev.targets.length + ' dispositivo(s), ' + nOn + ' online agora');
};

// ===== histórico =====
parent.pluginHandler.scripttask.newScriptTree = function(message) {
    var ev = (message.event || message);
    scriptTree = ev.tree || [];
    redrawScriptTree();
}
parent.pluginHandler.scripttask.loadHistory = function(message) {
    var ev = (message.event || message);
    var nNames = {};
    parent.nodes.forEach(function(n){ nNames[n._id] = n.name; });
    if (ev.nodeHistory != null && ev.nodeId == (mtGlobalNode() || {})._id) {
        var nHistTbl = document.getElementById('nHistTbl');
        var rows = nHistTbl.querySelectorAll('.stNHRow');
        rows.forEach(function(r) { r.parentNode.removeChild(r); });
        if (ev.nodeHistory.length) {
            ev.nodeHistory.forEach(function(nh) {
                nh.latestTime = Math.max(nh.completeTime || 0, nh.queueTime || 0, nh.dispatchTime || 0, nh.dontQueueUntil || 0);
            });
            ev.nodeHistory.sort((a, b) => (a.latestTime < b.latestTime) ? 1 : -1);
            ev.nodeHistory.forEach(function(nh) {
                nh = prepHistory(nh);
                let tr = nHistTbl.insertRow(-1);
                tr.innerHTML = '<td>' + nh.timeStr + '</td><td>' + esc(nh.runBy || '') + '</td><td>' + esc(nh.scriptName || '') + '</td><td>' + nh.statusTxt + '</td><td class="stCellMono">' + nh.returnTxt + '</td>';
                tr.classList.add('stNHRow');
            });
        }
    }
    var sel = document.querySelectorAll('.liselected');
    var currentScriptId = (sel[0] || {}).getAttribute ? sel[0].getAttribute('x-data-id') : null;
    if (ev.scriptHistory != null && ev.scriptId == currentScriptId) {
        var sHistTbl = document.getElementById('sHistTbl');
        var rows = sHistTbl.querySelectorAll('.stSHRow');
        rows.forEach(function(r) { r.parentNode.removeChild(r); });
        if (ev.scriptHistory.length) {
            sHistTbl.style.display = '';
            QV('sHistEmpty', false);
            ev.scriptHistory.forEach(function(nh) {
                nh.latestTime = Math.max(nh.completeTime || 0, nh.queueTime || 0, nh.dispatchTime || 0, nh.dontQueueUntil || 0);
            });
            ev.scriptHistory.sort((a, b) => (a.latestTime < b.latestTime) ? 1 : -1);
            ev.scriptHistory.forEach(function(nh) {
                nh = prepHistory(nh);
                let tr = sHistTbl.insertRow(-1);
                tr.innerHTML = '<td>' + nh.timeStr + '</td><td>' + esc(nh.runBy || '') + '</td><td>' + esc(nNames[nh.node] || nh.node) + '</td><td>' + nh.statusTxt + '</td><td class="stCellMono">' + nh.returnTxt + '</td>';
                tr.classList.add('stSHRow');
            });
        }
    }
    resizeIframe();
}
function prepHistory(nh) {
    var nowTime = Math.floor(new Date() / 1000);
    var d = new Date(0);
    d.setUTCSeconds(nh.latestTime);
    nh.timeStr = d.toLocaleString();
    if (nh.errorVal != null) { nh.returnTxt = esc(String(nh.errorVal).slice(0, 400)); } else { nh.returnTxt = esc(String(nh.returnVal == null ? '' : nh.returnVal).slice(0, 400)); }
    nh.statusTxt = '<span class="stStatus que">Na fila</span>';
    if (nh.dispatchTime != null) {
        var mins = Math.max(0, Math.floor((nowTime - nh.dispatchTime) / 60));
        nh.statusTxt = '<span class="stStatus run" title="Desde ' + new Date(nh.dispatchTime * 1000).toLocaleString() + '">Executando' + (mins > 2 ? ' (' + mins + ' min)' : '') + '</span>';
    }
    if (nh.errorVal != null) nh.statusTxt = '<span class="stStatus err">Erro</span>';
    if (nh.returnVal != null && nh.completeTime != null) nh.statusTxt = '<span class="stStatus ok" title="Duração: ' + secondsToHms(nh.completeTime - nh.dispatchTime) + '">Concluído</span>';
    if (nh.dontQueueUntil > nowTime) nh.statusTxt = '<span class="stStatus sch">Agendado</span>';
    if (nh.returnTxt == null || nh.returnTxt == '') nh.returnTxt = '&nbsp;';
    if (isJsonString(String(nh.returnVal || ''))) {
        try {
            var o = JSON.parse(nh.returnVal);
            var txt = JSON.stringify(o, null, 2).replace(/\n\s*\n/g, '\n').replace(/(?:\r\n|\r|\n)/g, '<br />');
            nh.returnTxt = '<details><summary style="cursor:pointer;">objeto</summary><pre style="max-height:220px;overflow:auto;">' + esc(txt) + '</pre></details>';
        } catch (e) { }
    }
    return nh;
}
function secondsToHms(d) {
    d = Number(d);
    if (d == 0 || isNaN(d)) return "instantâneo";
    var h = Math.floor(d / 3600), m = Math.floor(d % 3600 / 60), s = Math.floor(d % 3600 % 60);
    var out = '';
    if (h) out += h + 'h ';
    if (m) out += m + 'min ';
    if (s && !h) out += s + 's';
    return out.trim() || 'instantâneo';
}
function isJsonString(str) {
    try { JSON.parse(str); return true; } catch (e) { return false; }
}

// ===== agendamentos (listagem) =====
parent.pluginHandler.scripttask.loadSchedule = function(message) {
    var ev = (message.event || message);
    var sNames = {};
    scriptTree.forEach(function(s) { if (s.type == 'script') sNames[s._id] = s.name; });
    if (ev.nodeSchedule != null) {
        var nTbl = document.getElementById('nSchTbl');
        var rows = nTbl.querySelectorAll('.stNSRow');
        rows.forEach(function(r) { r.parentNode.removeChild(r); });
        if (ev.nodeSchedule.length) {
            ev.nodeSchedule.forEach(function(nh) {
                nh = prepSchedule(nh, sNames);
                var tr = nTbl.insertRow(-1);
                var targetTxt = (nh.filter != null && nh.filter !== '')
                    ? '<span class="stCellMono" title="Filtro dinâmico — reavaliado a cada execução">🎯 ' + esc(nh.filter) + '</span>'
                    : esc(nNames[nh.node] || nh.node || '');
                var schedName = nh.command ? ('⚡ ' + nh.command.substring(0, 40)) : (sNames[nh.scriptId] || nh.scriptId || '');
                tr.innerHTML = '<td>' + targetTxt + '</td><td>' + esc(schedName) + '</td><td>' + esc(nh.scheduledBy || '') + '</td><td>' + nh.everyTxt + '</td><td>' + nh.startedTxt + '</td><td>' + nh.endingTxt + '</td><td>' + nh.lastRunTxt + '</td><td>' + nh.nextRunTxt + '</td><td>' + nh.actionTxt + '</td>';
                if (nh.command) tr.title = '⚡ ' + nh.command;
                tr.classList.add('stNSRow');
                tr.setAttribute('x-data-id', nh._id);
            });
        }
    }
    resizeIframe();
}
function prepSchedule(nh, sNames) {
    nh.everyTxt = nh.interval + ' ';
    switch (nh.recur) {
        case 'once': nh.everyTxt = 'Uma vez'; break;
        case 'minutes': nh.everyTxt += 'minuto'; break;
        case 'hourly': nh.everyTxt += 'hora'; break;
        case 'daily': nh.everyTxt += 'dia'; break;
        case 'weekly': nh.everyTxt += 'semana'; break;
        case 'monthly': nh.everyTxt += 'mês'; break;
    }
    if (nh.interval > 1 && nh.recur != 'once') nh.everyTxt += 's';
    if (nh.recur == 'weekly') {
        nh.daysOfWeek = (nh.daysOfWeek || []).map(el => Number(el));
        nh.everyTxt += ' (';
        nh.daysOfWeek.forEach(function(num) {
            switch(num) { case 0: nh.everyTxt += 'D'; break; case 1: nh.everyTxt += 'S'; break; case 2: nh.everyTxt += 'T'; break; case 3: nh.everyTxt += 'Q'; break; case 4: nh.everyTxt += 'Q'; break; case 5: nh.everyTxt += 'S'; break; case 6: nh.everyTxt += 'S'; break; }
        });
        nh.everyTxt += ')';
    }
    var d = new Date(0); d.setUTCSeconds(nh.startAt);
    nh.startedTxt = d.toLocaleString();
    d = new Date(0); d.setUTCSeconds(nh.endAt);
    nh.endingTxt = d.toLocaleString();
    if (nh.endAt == null) nh.endingTxt = 'Nunca';
    if (nh.recur == 'once') nh.endingTxt = 'Após a 1ª execução';
    d = new Date(0); d.setUTCSeconds(nh.lastRun);
    nh.lastRunTxt = d.toLocaleString();
    if (nh.lastRun == null) nh.lastRunTxt = 'Nunca';
    d = new Date(0); d.setUTCSeconds(nh.nextRun);
    nh.nextRunTxt = d.toLocaleString();
    if (nh.nextRun == null) nh.nextRunTxt = '—';
    if (nh.nextRun != null && nh.lastRun != null && nh.nextRun < nh.lastRun) nh.nextRunTxt = 'Executando agora';
    nh.actionTxt = '<span class="flink danger" onclick="deleteSchedule(this);">excluir</span>';
    return nh;
}

// ===== variáveis =====
parent.pluginHandler.scripttask.loadVariables = function(message) {
    var ev = (message.event || message);
    if (ev.vars && ev.vars.length) {
        var vars = ev.vars;
        vars.forEach(function(vd) {
            switch (vd.scope) {
                case 'global': vd.scopeTargetHtml = '—'; break;
                case 'script':
                    var s = scriptTree.filter(obj => { return obj._id === vd.scopeTarget })[0];
                    vd.scopeTargetHtml = s ? '<span title="' + esc(s.path) + '">' + esc(s.name) + '</span>' : '—';
                    break;
                case 'mesh':
                    var m = parent.meshes[vd.scopeTarget];
                    vd.scopeTargetHtml = m ? esc(m.name) : '—';
                    break;
                case 'node':
                    var n = parent.nodes.filter(obj => { return obj._id === vd.scopeTarget })[0];
                    vd.scopeTargetHtml = n ? esc(n.name) : '—';
                    break;
                default: vd.scopeTargetHtml = '—'; break;
            }
            vd.scopeTxt = varScopes[vd.scope];
        });
        var ordering = { 'global': 0, 'script': 1, 'mesh': 2, 'node': 3 };
        vars.sort((a, b) => (ordering[a.scope] - ordering[b.scope]) || a.name.localeCompare(b.name) || String(a.scopeTargetHtml).localeCompare(String(b.scopeTargetHtml)));
        variables = vars;
        parseVariables();
    }
}
function parseVariables() {
    var vTbl = document.getElementById('varTbl');
    var rows = vTbl.querySelectorAll('.stVRow');
    rows.forEach(function(r) { r.parentNode.removeChild(r); });
    var sel = document.querySelectorAll('.liselected');
    var scopeTargetScriptId = (sel[0] || {}).getAttribute ? sel[0].getAttribute('x-data-id') : null;
    variables.forEach(function(vd) {
        var ctxNode = mtGlobalNode();
        if (vd.scope == 'script' && vd.scopeTarget != scopeTargetScriptId) return;
        if (vd.scope == 'mesh' && vd.scopeTarget != (ctxNode ? ctxNode.meshid : null)) return;
        if (vd.scope == 'node' && vd.scopeTarget != (ctxNode ? ctxNode._id : null)) return;
        var tr = vTbl.insertRow(-1);
        tr.innerHTML = '<td><b>' + esc(vd.name) + '</b></td><td class="stCellMono">' + esc(vd.value) + '</td><td>' + vd.scopeTxt + '</td><td>' + vd.scopeTargetHtml + '</td>' +
            '<td><span class="flink" onclick="editVar(this);">editar</span> · <span class="flink danger" onclick="delVar(this);">excluir</span></td>';
        tr.classList.add('stVRow');
        tr.setAttribute('x-data-id', vd._id);
    });
}
function newVarEx() {
    var name = parent.document.getElementById('stvarname').value;
    var scope = parent.document.getElementById('stvarscope').value;
    var value = parent.document.getElementById('stvarvalue').value;
    var scopeTarget = null;
    if (scope == 'script') {
        scopeTarget = selectedScriptId();
        if (!scopeTarget) return;
    } else if (scope == 'mesh') {
        var cn1 = mtGlobalNode(); if (!cn1) return;
        scopeTarget = cn1.meshid;
    } else if (scope == 'node') {
        var cn2 = mtGlobalNode(); if (!cn2) return;
        scopeTarget = cn2._id;
    }
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'newVar', name: name, scope: scope, scopeTarget: scopeTarget, value: value, currentNodeId: (mtGlobalNode() || {})._id });
}
function newVar() {
    parent.setDialogMode(2, "Nova Variável", 3, newVarEx, 'Nome: <input type="text" id=stvarname /><br />Escopo: <select id=stvarscope><option value="global">Global</option><option value="script">Script</option><option value="mesh">Mesh</option><option value="node">Node</option></select><br />Valor: <input id="stvarvalue" type="text" />');
    parent.focusTextBox('stvarname');
}
function editVarEx() {
    var varid = parent.document.getElementById('stvarid').value;
    var name = parent.document.getElementById('stvarname').value;
    var scope = parent.document.getElementById('stvarscope').value;
    var value = parent.document.getElementById('stvarvalue').value;
    var scopeTarget = null;
    if (scope == 'script') {
        scopeTarget = selectedScriptId();
        if (!scopeTarget) return;
    } else if (scope == 'mesh') {
        var cn = mtGlobalNode(); if (!cn) return;
        scopeTarget = cn.meshid;
    } else if (scope == 'node') {
        var cn2 = mtGlobalNode(); if (!cn2) return;
        scopeTarget = cn2._id;
    }
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'editVar', id: varid, name: name, scope: scope, scopeTarget: scopeTarget, value: value, currentNodeId: (mtGlobalNode() || {})._id });
}
function editVar(el) {
    var vid = el.parentNode.parentNode.getAttribute('x-data-id');
    var v = variables.filter(obj => { return obj._id === vid })[0];
    var soptHtml = '';
    for (const [k, t] of Object.entries(varScopes)) {
        soptHtml += '<option value="' + k + '"';
        if (v.scope == k) soptHtml += ' selected';
        soptHtml += '>' + t + '</option>';
    }
    parent.setDialogMode(2, "Editar Variável", 3, editVarEx, 'Nome: <input type="text" id=stvarname value="' + esc(v.name) + '" /><br />Escopo: <select id=stvarscope>' + soptHtml + '</select><br />Valor: <input id="stvarvalue" type="text" value="' + esc(v.value) + '" /><input type="hidden" id="stvarid" value="' + vid + '" />');
    parent.focusTextBox('stvarname');
}
function delVarEx() {
    var varid = parent.document.getElementById('stvarid').value;
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'deleteVar', id: varid, currentNodeId: (mtGlobalNode() || {})._id });
}
function delVar(el) {
    var vid = el.parentNode.parentNode.getAttribute('x-data-id');
    var v = variables.filter(obj => { return obj._id === vid })[0];
    parent.setDialogMode(2, "Excluir Variável", 3, delVarEx, 'Confirma? <input type="hidden" id="stvarid" value="' + vid + '" /><br />Nome: ' + esc(v.name) + '<br />Escopo: ' + varScopes[v.scope] + '<br />Valor: ' + esc(v.value));
}

// ===== ⚡ executar comando ad-hoc =====
function mtCmdOpen() {
    Q('mtCmdText').value = '';
    Q('mtCmdFilterInput').value = '';
    QV('mtCmdPreviewBox', false); QV('mtCmdPreviewSummary', false); QV('mtCmdPreviewErr', false);
    Q('mtCmdRecurRow').querySelector('input[value=once]').checked = true;
    mtCmdRecurSelected('once');
    var d = new Date();
    Q('mtCmdStartDate').value = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    Q('mtCmdStartTime').value = d.getHours() + ':' + d.getMinutes();
    Q('mtCmdEndDate').value = '';
    Q('mtCmdEndTime').value = '';
    Q('mtCmdEndNever').checked = true;
    QV('mtCmdOverlay', true);
}
function mtCmdClose() { QV('mtCmdOverlay', false); }
function mtCmdEndNeverChanged() {
    var n = Q('mtCmdEndNever').checked;
    Q('mtCmdEndDate').disabled = n; Q('mtCmdEndTime').disabled = n;
}
function mtCmdRecurSelected(v) {
    QV('mtCmdRowInterval', v != 'once');
    QV('mtCmdRowEnd', v != 'once');
    QV('mtCmdRowDays', v == 'weekly');
    var hints = { minutes: 'minuto(s)', hourly: 'hora(s)', daily: 'dia(s)', weekly: 'semana(s)' };
    QH('mtCmdIntervalHint', hints[v] || '');
}
var mtCmdPreviewTimer = null;
function mtCmdPreviewDebounced() {
    clearTimeout(mtCmdPreviewTimer);
    mtCmdPreviewTimer = setTimeout(mtCmdPreviewRun, 500);
}
function mtCmdPreviewRun() {
    var f = Q('mtCmdFilterInput').value.trim();
    if (f == '') { QV('mtCmdPreviewBox', false); QV('mtCmdPreviewSummary', false); QV('mtCmdPreviewErr', false); return; }
    QH('mtCmdPreviewErr', ''); QV('mtCmdPreviewErr', false);
    QH('mtCmdPreviewSummary', 'Buscando...');
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'previewTargets', filter: f });
}
function mtCmdSave() {
    var cmd = Q('mtCmdText').value;
    var type = Q('mtCmdType').value;
    var filter = Q('mtCmdFilterInput').value.trim();
    if (!cmd.trim()) { mtToast('Digite o comando.', 'err'); return; }
    if (!filter) { mtToast('Informe um filtro de dispositivos.', 'err'); return; }
    var recurEls = document.getElementsByName('mtcmdrecur');
    var recur = 'once';
    recurEls.forEach(function (el) { if (el.checked) recur = el.value; });
    var startAt = Date.parse(Q('mtCmdStartDate').value + ' ' + Q('mtCmdStartTime').value);
    startAt = Math.floor(startAt / 1000);
    if (isNaN(startAt)) { mtToast('Data/hora de início inválida.', 'err'); return; }
    var o = { recur: recur, startAt: startAt };
    if (recur != 'once') {
        o.interval = Number(Q('mtCmdInterval').value) || 1;
        if (Q('mtCmdEndNever').checked) o.endAt = null;
        else {
            o.endAt = Date.parse(Q('mtCmdEndDate').value + ' ' + Q('mtCmdEndTime').value);
            o.endAt = Math.floor(o.endAt / 1000);
            if (isNaN(o.endAt)) { mtToast('Data/hora de fim inválida.', 'err'); return; }
        }
    }
    if (recur == 'weekly') {
        o.dayVals = [];
        document.getElementsByName('mtcmddays').forEach(function (de) { if (de.checked) o.dayVals.push(de.value); });
        if (o.dayVals.length == 0) { mtToast('Selecione ao menos um dia da semana.', 'err'); return; }
    }
    var now = Math.floor(Date.now() / 1000);
    if (recur == 'once' && startAt <= now) {
        parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'runCommand', cmd: cmd, filetype: type, filter: filter, currentNodeId: (mtGlobalNode() || {})._id });
        mtToast('Comando enfileirado.', 'ok');
        mtCmdClose();
        mtShowTab('history', Q('mtTabs').querySelectorAll('span')[2]);
    } else {
        parent.meshserver.send({
            action: 'plugin', plugin: 'scripttask', pluginaction: 'addScheduledJob',
            command: cmd, commandType: type, filter: filter, nodes: null,
            currentNodeId: (mtGlobalNode() || {})._id, schedule: o
        });
        mtToast('Comando agendado.', 'ok');
        mtCmdClose();
        mtShowTab('schedule', Q('mtTabs').querySelectorAll('span')[1]);
    }
}

// ===== drag&drop / upload =====
function handleFileSelect(evt) {
    evt.preventDefault();
    var files = evt.dataTransfer.files;
    QV('dropBlock', false);
    fileUpload(files);
    elementDragged = false;
}
function fileUpload(files) {
    if (files == null) files = document.getElementById('files').files;
    var path = null;
    var isSelected = document.querySelectorAll('.liselected');
    if (isSelected.length) path = isSelected[0].getAttribute('x-data-path');
    for (var i = 0, f; f = files[i]; i++) {
        var reader = new FileReader();
        reader.fileName = f.name;
        reader.readAsBinaryString(f);
        reader.addEventListener('loadend', function(e, file){
            addScript(e.currentTarget.fileName, e.currentTarget.result, path);
        });
    }
}
var dropZone, dropBlock, dragTimer = null;
function allowDrag(e) {
    if (!elementDragged) {
        e.dataTransfer.dropEffect = 'copy';
        QV('dropBlock', true);
        e.preventDefault();
        clearTimeout(dragTimer);
        dragTimer = setTimeout(function(){ QV('dropBlock', false); }, 100);
    }
}
function dropMove(evt) {
    const move_id = evt.dataTransfer.getData('text');
    const container_id = evt.target.parentNode.getAttribute('x-data-id');
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'moveScript', id: move_id, to: container_id });
}

// ===== entrada global (My Server → Plugins) =====
parent.pluginHandler.scripttask.goPageEnd = function (view, event) {
    try {
        if (view == 42) {
            mtInjectServerEntry();
        } else if (mtIsGlobal) {
            mtCloseGlobal();
        }
    } catch (e) { }
};
function mtInjectServerEntry() {
    var box = document.getElementById('p42') || (parent && parent.document.getElementById('p42'));
    var doc = box ? (box.ownerDocument) : null;
    if (!doc) return;
    if (doc.getElementById('mtrunopen')) return;
    var btn = doc.createElement('input');
    btn.id = 'mtrunopen';
    btn.type = 'button';
    btn.value = '⚡ Abrir MeshTask Runner';
    btn.style.margin = '8px 0';
    btn.style.padding = '5px 14px';
    btn.style.cursor = 'pointer';
    btn.onclick = function () { mtOpenGlobal(); };
    var head = doc.querySelector('#p42 .areaHead');
    if (head && head.parentNode) head.parentNode.insertBefore(btn, head.nextSibling);
    else box.appendChild(btn);
}
function mtOpenGlobal() {
    var doc = parent.document || document;
    var ov = doc.getElementById('mtGlobalOverlay');
    if (ov) { ov.style.display = 'flex'; return; }
    ov = doc.createElement('div');
    ov.id = 'mtGlobalOverlay';
    ov.style.cssText = 'display:flex; position:fixed; top:0; right:0; bottom:0; left:90px; background:rgba(0,0,0,0.55); z-index:999; align-items:center; justify-content:center;';
    var box = doc.createElement('div');
    box.style.cssText = 'position:relative; width:calc(100% - 60px); height:calc(100% - 60px); background:#fff; border:1px solid #888; border-radius:6px; box-shadow:0 8px 40px rgba(0,0,0,0.5); overflow:hidden;';
    var close = doc.createElement('span');
    close.style.cssText = 'position:absolute; top:8px; right:10px; z-index:5; cursor:pointer; font-size:22px; color:#555; font-weight:bold;';
    close.textContent = '✕';
    close.onclick = function () { mtCloseGlobal(); };
    var ifr = doc.createElement('iframe');
    ifr.id = 'mtGlobalFrame';
    ifr.style.cssText = 'width:100%; height:100%; border:none;';
    ifr.src = '/pluginadmin.ashx?pin=scripttask&user=1&global=1';
    box.appendChild(ifr);
    box.appendChild(close);
    ov.appendChild(box);
    doc.body.appendChild(ov);
}
function mtCloseGlobal() {
    var ov = (parent.document || document).getElementById('mtGlobalOverlay');
    if (ov) ov.parentNode.removeChild(ov);
}

// ===== init =====
function doOnLoad() {
    dropZone = document.getElementById('scriptTaskUser');
    dropBlock = document.getElementById('dropBlock');
    dropZone.addEventListener('dragenter', allowDrag);
    dropZone.addEventListener('dragover', allowDrag);
    dropZone.addEventListener('dragleave', function(e) {
        QV('dropBlock', false);
        elementDragged = false;
    });
    dropZone.addEventListener('drop', handleFileSelect);
    redrawScriptTree();
    renderToolbar();
    renderScriptDetail();
    // carga inicial
    var ctxNode = mtGlobalNode();
    if (ctxNode && ctxNode._id) {
        parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadNodeHistory', nodeId: ctxNode._id });
    }
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadAllSchedules' });
    parent.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'loadVariables' });
}
