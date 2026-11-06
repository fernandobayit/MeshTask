/* MeshTask 2 admin view. The host must supply an authenticated, admin-authorized
 * bridge; this view never opens a transport or implements authentication.
 * mount(root, bridge) returns { ready, refresh, destroy }. No automatic retries.
 */
function createAdmin() {
  'use strict';

  function targetsFrom(value) {
    const targets = String(value).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!targets.length || targets.some((s) => /[\s*]/.test(s))) {
      throw new Error('Informe IDs de nós explícitos, separados por linha ou vírgula, sem espaços ou curingas.');
    }
    return Array.from(new Set(targets));
  }

  function utcFrom(value) {
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
      throw new Error('Informe a data UTC no formato AAAA-MM-DDTHH:mm:ssZ (ou com milissegundos).');
    }
    const date = new Date(text);
    const canonical = text.includes('.') ? text : text.replace('Z', '.000Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) {
      throw new Error('A data UTC informada não existe.');
    }
    return date.toISOString();
  }

  function intervalFrom(value) {
    const text = String(value).trim();
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1000) {
      throw new Error('O intervalo deve ser um número inteiro de pelo menos 1000 milissegundos.');
    }
    return number;
  }

  function mount(root, bridge) {
    if (!root || !root.ownerDocument || typeof root.replaceChildren !== 'function') {
      throw new TypeError('Forneça um elemento DOM para a interface administrativa.');
    }
    if (!bridge || typeof bridge.request !== 'function') {
      root.textContent = 'Ponte administrativa do host ausente. Acesso indisponível; abra esta interface no host autenticado.';
      throw new TypeError('A ponte autenticada bridge.request(op, input) é obrigatória.');
    }
    const doc = root.ownerDocument;
    let destroyed = false;
    let busy = false;
    let statusKnown = false;
    let scripts = [];
    let editingId = null;
    const listeners = [];
    const controls = [];
    const view = element('section', null, { class: 'meshtask2-admin', lang: 'pt-BR' });
    root.replaceChildren(view);

    function element(tag, text, attrs) {
      const node = doc.createElement(tag);
      if (text !== null && text !== undefined) node.textContent = String(text);
      Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
      return node;
    }
    function append(parent, tag, text, attrs) {
      const node = element(tag, text, attrs);
      parent.appendChild(node);
      return node;
    }
    function listen(node, type, handler) {
      node.addEventListener(type, handler);
      listeners.push([node, type, handler]);
    }
    function control(node, unavailable) {
      controls.push({ node, unavailable: unavailable || (() => false) });
      return node;
    }
    function updateControls() {
      controls.forEach(({ node, unavailable }) => { node.disabled = destroyed || busy || unavailable(); });
      view.setAttribute('aria-busy', String(busy));
    }
    function field(parent, label, name, tag, attrs) {
      const wrapper = append(parent, 'label');
      append(wrapper, 'span', label);
      return control(append(wrapper, tag || 'input', null, Object.assign({ name }, attrs)));
    }
    function button(parent, label, handler, unavailable) {
      const node = control(append(parent, 'button', label, { type: 'button' }), unavailable);
      if (handler) listen(node, 'click', () => run(handler));
      return node;
    }
    function section(title) {
      const node = append(view, 'section');
      append(node, 'h3', title);
      return node;
    }
    function option(parent, text, value) {
      append(parent, 'option', text, { value });
    }
    function errorText(error) {
      return error && error.message ? String(error.message) : String(error);
    }
    function announce(text, error) {
      if (destroyed) return;
      message.setAttribute('role', error ? 'alert' : 'status');
      message.textContent = text;
    }
    async function request(op, input) {
      if (destroyed) throw new Error('A interface foi encerrada.');
      return bridge.request(op, input || {});
    }
    async function run(action) {
      if (busy || destroyed) return;
      busy = true;
      updateControls();
      announce('Processando…');
      try { await action(); }
      catch (error) {
        announce('Falha: ' + errorText(error) + ' Nenhum reenvio automático foi feito. Se houve perda de conexão durante uma alteração, consulte a lista antes de tentar novamente.', true);
      } finally {
        busy = false;
        updateControls();
      }
    }

    append(view, 'h2', 'MeshTask 2 — Administração');
    append(view, 'p', 'Listas limitadas a 200 registros neste alpha. Agendamentos são materializados somente por tick explícito no servidor; não há temporizador automático.');
    append(view, 'p', 'Versão alpha. Contexto exclusivo: serviço. Uma solicitação, um ACK ou um agendamento não comprovam execução no agente.');
    append(view, 'p', 'Esta tela exige a ponte autenticada e autorizada do host. A autorização administrativa, o domínio e a propriedade dos nós devem ser validados pelo servidor.');
    const status = append(view, 'p', 'Consultando status; execução não confirmada.', { role: 'status', 'data-role': 'status' });
    const message = append(view, 'p', '', { role: 'status', 'aria-live': 'polite', 'data-role': 'message' });
    button(view, 'Atualizar status e listas', refreshData);

    const library = section('Scripts e revisões');
    const scriptList = append(library, 'div', null, { 'data-role': 'scripts' });
    const editor = append(library, 'form', null, { 'data-form': 'script' });
    const editing = append(editor, 'p', 'Novo script.', { 'data-role': 'editing' });
    const name = field(editor, 'Nome', 'name', 'input', { type: 'text', required: '' });
    const engine = field(editor, 'Interpretador', 'engine', 'select');
    option(engine, 'Bash', 'bash');
    option(engine, 'PowerShell', 'powershell');
    const body = field(editor, 'Conteúdo completo do script', 'body', 'textarea', { rows: '10', required: '', spellcheck: 'false' });
    append(editor, 'p', 'A listagem não fornece o conteúdo anterior. Para revisar, informe o corpo completo; a revisão anterior permanece no histórico do servidor.');
    control(append(editor, 'button', 'Salvar nova revisão', { type: 'submit' }));
    button(editor, 'Novo script / cancelar revisão', () => { resetEditor(); announce('Editor preparado para um novo script.'); });
    function resetEditor() {
      editingId = null;
      name.value = '';
      engine.value = 'bash';
      body.value = '';
      editing.textContent = 'Novo script.';
    }
    listen(editor, 'submit', (event) => {
      event.preventDefault();
      run(async () => {
        if (!name.value.trim() || !body.value.trim()) throw new Error('Nome e conteúdo completo são obrigatórios.');
        if (!['bash', 'powershell'].includes(engine.value)) throw new Error('Interpretador inválido.');
        const input = { name: name.value.trim(), engine: engine.value, body: body.value, context: 'service' };
        if (editingId !== null) input.id = editingId;
        const saved = await request('scripts.save', input);
        if (destroyed) return;
        resetEditor();
        announce('Revisão salva: ' + saved.id + ' / ' + saved.revision + '. Nenhuma execução foi solicitada.');
        await refreshList('scripts');
      });
    });

    const submission = section('Solicitação imediata e agendamento');
    const targetForm = append(submission, 'form', null, { 'data-form': 'job' });
    const selectedScript = field(targetForm, 'Script e revisão fixa', 'scriptId', 'select', { required: '' });
    const targetText = field(targetForm, 'IDs dos nós de destino (um por linha ou separados por vírgula)', 'targets', 'textarea', { required: '', rows: '4', spellcheck: 'false' });
    append(targetForm, 'p', 'Somente os nós informados serão incluídos. Não há seleção de todos os dispositivos nem execução no contexto do usuário conectado.');
    const selectionInfo = append(targetForm, 'p', 'Selecione um script.', { 'data-role': 'selection' });
    listen(selectedScript, 'change', describeSelection);
    function currentScript() { return scripts.find((script) => script.id === selectedScript.value); }
    function describeSelection() {
      const script = currentScript();
      selectionInfo.textContent = script ? 'Revisão fixa: ' + script.revision + ' | Contexto: serviço.' : 'Selecione um script.';
    }
    function jobInput() {
      if (!statusKnown) throw new Error('Consulte o status do servidor antes de registrar solicitações.');
      const script = currentScript();
      if (!script || !Number.isSafeInteger(script.revision) || script.revision < 1) throw new Error('Selecione um script com revisão válida.');
      return { scriptId: script.id, revision: script.revision, targets: targetsFrom(targetText.value), context: 'service' };
    }
    control(append(targetForm, 'button', 'Registrar solicitação imediata', { type: 'submit' }), () => !statusKnown || !scripts.length);
    append(targetForm, 'p', 'No alpha, o servidor pode registrar a solicitação como bloqueada. Registrar não significa executar. Consulte o histórico.');
    listen(targetForm, 'submit', (event) => {
      event.preventDefault();
      run(async () => {
        const job = await request('jobs.create', jobInput());
        announce('Solicitação registrada: ' + job.id + '. Isto não confirma execução no agente. Consulte o histórico.');
        await refreshList('jobs');
      });
    });

    const scheduleForm = append(submission, 'form', null, { 'data-form': 'schedule' });
    append(scheduleForm, 'p', 'O agendamento usa o script, a revisão e os nós selecionados acima.');
    const kind = field(scheduleForm, 'Tipo de agendamento', 'kind', 'select');
    option(kind, 'Uma vez', 'once');
    option(kind, 'Intervalo', 'interval');
    const at = field(scheduleForm, 'Início em UTC (AAAA-MM-DDTHH:mm:ssZ)', 'at', 'input', { type: 'text', required: '', placeholder: 'AAAA-MM-DDTHH:mm:ssZ' });
    const interval = field(scheduleForm, 'Intervalo em milissegundos (somente para intervalo)', 'intervalMs', 'input', { type: 'number', min: '1000', step: '1' });
    controls.find((entry) => entry.node === interval).unavailable = () => kind.value !== 'interval';
    listen(kind, 'change', () => { interval.required = kind.value === 'interval'; updateControls(); });
    control(append(scheduleForm, 'button', 'Criar agendamento', { type: 'submit' }), () => !statusKnown || !scripts.length);
    listen(scheduleForm, 'submit', (event) => {
      event.preventDefault();
      run(async () => {
        if (!['once', 'interval'].includes(kind.value)) throw new Error('Tipo de agendamento inválido.');
        const input = Object.assign(jobInput(), { kind: kind.value, at: utcFrom(at.value) });
        if (kind.value === 'interval') input.intervalMs = intervalFrom(interval.value);
        const schedule = await request('schedules.create', input);
        announce('Agendamento registrado: ' + schedule.id + '. Isto não confirma execução no agente.');
        await refreshList('schedules');
      });
    });

    const history = section('Histórico de solicitações');
    append(history, 'p', 'Estados e eventos são os retornados pelo servidor. ACK não é conclusão; timeout não é cancelamento. Atualize manualmente para consultar novas informações.');
    const jobList = append(history, 'div', null, { 'data-role': 'jobs' });
    const details = append(history, 'div', null, { 'data-role': 'details', 'aria-live': 'polite' });
    const schedules = section('Agendamentos');
    const scheduleList = append(schedules, 'div', null, { 'data-role': 'schedules' });

    // List buttons have their own listeners, discarded on refresh instead of
    // retaining detached rows. Only stable controls are in the lifecycle arrays.
    function rowButton(parent, label, action, disabled) {
      const node = append(parent, 'button', label, { type: 'button' });
      node.disabled = !!disabled;
      node.addEventListener('click', () => { if (!node.disabled) run(action); });
      return node;
    }
    function table(parent, headings) {
      parent.replaceChildren();
      const node = append(parent, 'table');
      const head = append(append(node, 'thead'), 'tr');
      headings.forEach((title) => append(head, 'th', title, { scope: 'col' }));
      return append(node, 'tbody');
    }
    function display(value) { return value === undefined || value === null ? 'Não informado' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
    function renderScripts(items) {
      scripts = items;
      const oldSelection = selectedScript.value;
      selectedScript.replaceChildren();
      option(selectedScript, 'Selecione um script', '');
      const rows = table(scriptList, ['Nome', 'ID', 'Revisão', 'Interpretador', 'Ação']);
      items.forEach((script) => {
        option(selectedScript, script.name + ' — revisão ' + script.revision, script.id);
        const row = append(rows, 'tr');
        [script.name, script.id, script.revision, script.engine].forEach((value) => append(row, 'td', display(value)));
        rowButton(append(row, 'td'), 'Revisar', () => {
          editingId = script.id;
          name.value = script.name;
          engine.value = script.engine;
          body.value = '';
          editing.textContent = 'Nova revisão de ' + script.id + ' (atual: ' + script.revision + '). Informe o corpo completo.';
          body.focus();
          announce('Modo de revisão. Nenhum conteúdo anterior foi carregado.');
        });
      });
      selectedScript.value = items.some((item) => item.id === oldSelection) ? oldSelection : '';
      describeSelection();
      if (!items.length) append(scriptList, 'p', 'Nenhum script cadastrado.');
    }
    function renderJobs(items) {
      const rows = table(jobList, ['ID', 'Script', 'Revisão', 'Destinos', 'Estado informado', 'Ação']);
      items.forEach((job) => {
        const row = append(rows, 'tr');
        [job.id, job.scriptId, job.revision, job.targets, job.status].forEach((value) => append(row, 'td', display(value)));
        async function loadDetails(cursors) {
          const result = await request('jobs.get', Object.assign({ jobId: job.id }, cursors || {}));
          if (destroyed) return;
          details.replaceChildren();
          [['Solicitação', result.job], ['Tentativas', result.attempts], ['Eventos de auditoria', result.events]].forEach(([title, value]) => {
            append(details, 'h4', title);
            append(details, 'pre', JSON.stringify(value, null, 2) || 'Não informado');
          });
          if (result.nextAttempt) rowButton(details, 'Próxima página de tentativas', () => loadDetails({ afterAttempt: result.nextAttempt, afterEvent: (cursors && cursors.afterEvent) || 0 }));
          if (result.nextEvent) rowButton(details, 'Próxima página de eventos', () => loadDetails({ afterEvent: result.nextEvent, afterAttempt: (cursors && cursors.afterAttempt) || '' }));
          announce('Detalhes retornados pelo servidor.');
        }
        rowButton(append(row, 'td'), 'Ver detalhes', () => loadDetails());
      });
      if (!items.length) append(jobList, 'p', 'Nenhuma solicitação registrada.');
    }
    function renderSchedules(items) {
      const rows = table(scheduleList, ['ID', 'Script / revisão', 'Destinos', 'Tipo', 'Início UTC', 'Intervalo (ms)', 'Ativo', 'Ação']);
      items.forEach((schedule) => {
        const row = append(rows, 'tr');
        [schedule.id, display(schedule.scriptId) + ' / ' + display(schedule.revision), schedule.targets, schedule.kind, schedule.at, schedule.intervalMs, schedule.enabled].forEach((value) => append(row, 'td', display(value)));
        rowButton(append(row, 'td'), 'Desativar', async () => {
          await request('schedules.disable', { scheduleId: schedule.id });
          announce('Agendamento desativado. Isto não cancela solicitações já criadas.');
          await refreshList('schedules');
        }, schedule.enabled === false);
      });
      if (!items.length) append(scheduleList, 'p', 'Nenhum agendamento registrado.');
    }
    const renderers = { scripts: renderScripts, jobs: renderJobs, schedules: renderSchedules };
    const containers = { scripts: scriptList, jobs: jobList, schedules: scheduleList };
    async function refreshList(key) {
      try {
        const items = await request(key + '.list');
        if (destroyed) return;
        if (!Array.isArray(items)) throw new Error('Formato de listagem inválido: ' + key);
        renderers[key](items);
      } catch (error) {
        if (!destroyed) {
          if (key === 'scripts') renderScripts([]);
          containers[key].textContent = 'Listagem indisponível. Atualize antes de repetir uma alteração.';
        }
        throw error;
      }
    }
    async function refreshStatus() {
      statusKnown = false;
      try {
        const result = await request('status');
        if (destroyed) return;
        if (!result || typeof result.executionEnabled !== 'boolean') throw new Error('Resposta de status inválida.');
        statusKnown = true;
        status.textContent = 'Versão: ' + display(result.version) + ' — ' + (result.executionEnabled ? 'Execução habilitada segundo o servidor; esta tela não valida o runtime.' : 'Execução real bloqueada (alpha).') + ' Motivo: ' + display(result.reason);
      } catch (error) {
        if (!destroyed) status.textContent = 'Status indisponível. Execução não confirmada; novas solicitações estão indisponíveis.';
        throw error;
      }
    }
    async function refreshData() {
      details.replaceChildren();
      const results = await Promise.allSettled([refreshStatus(), refreshList('scripts'), refreshList('jobs'), refreshList('schedules')]);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) throw new Error(failures.map((result) => errorText(result.reason)).join('; '));
      announce('Status e listas atualizados.');
    }
    const ready = run(refreshData);
    return {
      ready,
      refresh: () => run(refreshData),
      destroy: () => {
        destroyed = true;
        listeners.forEach(([node, type, handler]) => node.removeEventListener(type, handler));
        updateControls();
        if (view.parentNode === root) root.replaceChildren();
      }
    };
  }

  return Object.freeze({ mount, targetsFrom, utcFrom, intervalFrom });
}
if (typeof module !== 'undefined' && module.exports) module.exports = { ...createAdmin(), createAdmin };
if (typeof window !== 'undefined') window.MeshTask2Admin = createAdmin();
