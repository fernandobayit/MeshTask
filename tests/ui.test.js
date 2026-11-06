'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createAdmin } = require('../ui/admin');

// Deliberately no HTML parser: any attempt to introduce an HTML sink fails.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = new Map();
    this.disabled = false;
    this._text = '';
    this._value = undefined;
  }
  set innerHTML(_) { throw new Error('innerHTML is forbidden'); }
  set textContent(value) {
    this.replaceChildren();
    this._text = String(value);
  }
  get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
  set value(value) { this._value = String(value); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') return this.children[0]?.value || '';
    return this.attributes.value || '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = '';
    if (this.tagName === 'SELECT') this._value = undefined;
    for (const node of nodes) this.appendChild(node);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  focus() { this.ownerDocument.activeElement = this; }
  dispatch(type) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}
function dom() {
  const document = { createElement(tag) { return new Element(tag, document); } };
  return document.createElement('main');
}
function descendants(root) { return [root, ...root.children.flatMap(descendants)]; }
function find(root, predicate) {
  const node = descendants(root).find(predicate);
  assert.ok(node, 'Expected DOM element was rendered');
  return node;
}
const attr = (root, name, value) => find(root, (node) => node.getAttribute(name) === value);
const role = (root, value) => attr(root, 'data-role', value);
const form = (root, value) => attr(root, 'data-form', value);
const field = (root, value) => attr(root, 'name', value);
const button = (root, label) => find(root, (node) => node.tagName === 'BUTTON' && node.textContent === label);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
const script = { id: 'script-fixture', revision: 3, name: 'Fixture', engine: 'bash' };

// MeshCentral prepExports serializes functions, not their module closures.
// Exercise every UI scenario through that standalone serialization boundary.
function standaloneAdmin() {
  return vm.runInNewContext(`(${createAdmin.toString()})()`, Object.create(null));
}
async function setup(t, overrides = {}) {
  const calls = [];
  const responses = {
    status: { version: '2.0.0-alpha.1', executionEnabled: false, reason: 'Alpha gate' },
    'scripts.list': [], 'jobs.list': [], 'schedules.list': [],
    'scripts.save': { id: script.id, revision: 4 },
    'jobs.create': { id: 'job-fixture' },
    'schedules.create': { id: 'schedule-fixture' },
    ...overrides
  };
  const bridge = { async request(op, input) {
    calls.push({ op, input: plain(input) });
    assert.ok(Object.hasOwn(responses, op), `Unexpected operation: ${op}`);
    const response = responses[op];
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(input) : response;
  } };
  const root = dom();
  const view = standaloneAdmin().mount(root, bridge);
  t.after(() => view.destroy());
  await view.ready;
  return { root, view, calls, responses };
}
function selectTargets(root) {
  field(root, 'scriptId').value = script.id;
  field(root, 'scriptId').dispatch('change');
  field(root, 'targets').value = 'node-fixture-a, node-fixture-b\nnode-fixture-a';
}
async function submit(root, kind) {
  assert.equal(form(root, kind).dispatch('submit').defaultPrevented, true);
  await settle();
}

test('createAdmin survives standalone function.toString evaluation and mounts without module globals', async (t) => {
  const api = standaloneAdmin();
  assert.equal(typeof api.mount, 'function');
  assert.equal(api.utcFrom('2028-02-29T12:00:00Z'), '2028-02-29T12:00:00.000Z');
  const { root, calls } = await setup(t);
  assert.throws(() => { root.innerHTML = '<p>unsafe</p>'; }, /innerHTML is forbidden/);
  assert.deepEqual(calls.map(({ op }) => op).sort(), ['jobs.list', 'schedules.list', 'scripts.list', 'status']);
  assert.equal(role(root, 'message').textContent, 'Status e listas atualizados.');
});

test('hostile script names and job output remain literal DOM text', async (t) => {
  const hostile = '<script>globalThis.compromised=true</script><img src=x onerror=alert(1)>';
  const details = { job: { id: 'job-fixture' }, attempts: [{ stdout: hostile, stderr: hostile }], events: [{ message: hostile }] };
  const { root, calls } = await setup(t, {
    'scripts.list': [{ ...script, name: hostile }],
    'jobs.list': [{ id: 'job-fixture', scriptId: script.id, revision: 3, targets: ['node-fixture-a'], status: 'failed' }],
    'jobs.get': details
  });
  assert.ok(descendants(role(root, 'scripts')).some((node) => node.tagName === 'TD' && node.textContent === hostile));
  assert.equal(field(root, 'scriptId').children[1].textContent, hostile + ' — revisão 3');
  button(root, 'Ver detalhes').dispatch('click');
  await settle();
  assert.deepEqual(descendants(role(root, 'details')).filter((node) => node.tagName === 'PRE').map((node) => node.textContent),
    [details.job, details.attempts, details.events].map((value) => JSON.stringify(value, null, 2)));
  assert.deepEqual(calls.at(-1), { op: 'jobs.get', input: { jobId: 'job-fixture' } });
  assert.equal(descendants(root).some((node) => ['SCRIPT', 'IMG'].includes(node.tagName)), false);
  assert.equal(descendants(root).some((node) => Object.keys(node.attributes).some((name) => /^on/i.test(name))), false);
});

test('empty lists are successful empty states, not transport failures', async (t) => {
  const { root } = await setup(t);
  assert.match(role(root, 'scripts').textContent, /Nenhum script cadastrado/);
  assert.match(role(root, 'jobs').textContent, /Nenhuma solicitação registrada/);
  assert.match(role(root, 'schedules').textContent, /Nenhum agendamento registrado/);
  assert.equal(role(root, 'message').getAttribute('role'), 'status');
  assert.match(role(root, 'status').textContent, /Execução real bloqueada \(alpha\)/);
});

for (const key of ['scripts', 'jobs', 'schedules']) {
  test(`${key} list failure is unavailable, not empty, and can recover manually`, async (t) => {
    const { root, view, responses, calls } = await setup(t, { [key + '.list']: new Error('fixture offline') });
    assert.match(role(root, key).textContent, /Listagem indisponível/);
    assert.doesNotMatch(role(root, key).textContent, /Nenhum/);
    assert.equal(role(root, 'message').getAttribute('role'), 'alert');
    assert.match(role(root, 'message').textContent, /fixture offline/);
    assert.equal(calls.filter(({ op }) => op === key + '.list').length, 1);
    responses[key + '.list'] = [];
    await view.refresh();
    assert.match(role(root, key).textContent, /Nenhum/);
    assert.equal(role(root, 'message').getAttribute('role'), 'status');
  });
}

for (const badStatus of [new Error('status offline'), {}, { executionEnabled: 'true' }]) {
  test(`unavailable or malformed status fails closed: ${JSON.stringify(badStatus)}`, async (t) => {
    const { root, calls } = await setup(t, { status: badStatus, 'scripts.list': [script] });
    assert.match(role(root, 'status').textContent, /Status indisponível/);
    assert.equal(button(root, 'Registrar solicitação imediata').disabled, true);
    assert.equal(button(root, 'Criar agendamento').disabled, true);
    selectTargets(root);
    // Synthetic submission also must fail closed, independently of disabled buttons.
    await submit(root, 'job');
    assert.equal(calls.some(({ op }) => op === 'jobs.create'), false);
    assert.match(role(root, 'message').textContent, /Consulte o status/);
  });
}

test('enabled server status is qualified and never claims runtime validation', async (t) => {
  const { root } = await setup(t, { status: { executionEnabled: true, version: 'fixture', reason: 'fixture' } });
  assert.match(role(root, 'status').textContent, /Execução habilitada segundo o servidor/);
  assert.match(role(root, 'status').textContent, /esta tela não valida o runtime/);
});

test('script save, immediate job and schedule use service context and frozen revision', async (t) => {
  const { root, calls } = await setup(t, { 'scripts.list': [script] });
  field(root, 'name').value = ' Fixture name ';
  field(root, 'body').value = 'printf fixture';
  field(root, 'engine').value = 'bash';
  await submit(root, 'script');
  assert.deepEqual(calls.find(({ op }) => op === 'scripts.save').input,
    { name: 'Fixture name', engine: 'bash', body: 'printf fixture', context: 'service' });
  selectTargets(root);
  assert.match(role(root, 'selection').textContent, /Revisão fixa: 3 \| Contexto: serviço/);
  const expected = { scriptId: script.id, revision: 3, targets: ['node-fixture-a', 'node-fixture-b'], context: 'service' };
  await submit(root, 'job');
  assert.deepEqual(calls.find(({ op }) => op === 'jobs.create').input, expected);
  assert.match(role(root, 'message').textContent, /Isto não confirma execução/);
  field(root, 'kind').value = 'once';
  field(root, 'at').value = '2028-02-29T12:34:56Z';
  await submit(root, 'schedule');
  assert.deepEqual(calls.find(({ op }) => op === 'schedules.create').input,
    { ...expected, kind: 'once', at: '2028-02-29T12:34:56.000Z' });
  assert.equal(descendants(root).some((node) => node.getAttribute('name') === 'context'), false);
});

test('UTC validation rejects offsets, local time, impossible dates and noncanonical values before send', async (t) => {
  const { root, calls } = await setup(t, { 'scripts.list': [script] });
  selectTargets(root);
  const invalid = ['', '2028-02-29T12:00:00', '2028-02-29T12:00:00+00:00', '2027-02-29T12:00:00Z',
    '2028-04-31T12:00:00Z', '2028-01-01T24:00:00Z', '2028-01-01T00:00:60Z', '2028-01-01T00:00:00.1Z'];
  for (const value of invalid) {
    field(root, 'at').value = value;
    await submit(root, 'schedule');
    assert.equal(role(root, 'message').getAttribute('role'), 'alert', value);
    assert.equal(calls.some(({ op }) => op === 'schedules.create'), false, value);
  }
  field(root, 'at').value = '2028-02-29T12:34:56.123Z';
  await submit(root, 'schedule');
  assert.equal(calls.find(({ op }) => op === 'schedules.create').input.at, '2028-02-29T12:34:56.123Z');
});

test('interval validation and explicit targets prevent invalid submissions', async (t) => {
  const { root, calls } = await setup(t, { 'scripts.list': [script] });
  selectTargets(root);
  for (const targets of ['', '*', 'node fixture', 'node-fixture-*']) {
    field(root, 'targets').value = targets;
    await submit(root, 'job');
    assert.equal(calls.some(({ op }) => op === 'jobs.create'), false, targets);
    assert.equal(role(root, 'message').getAttribute('role'), 'alert');
  }
  selectTargets(root);
  field(root, 'kind').value = 'interval';
  field(root, 'kind').dispatch('change');
  assert.equal(field(root, 'intervalMs').disabled, false);
  assert.equal(field(root, 'intervalMs').required, true);
  field(root, 'at').value = '2028-01-01T00:00:00Z';
  for (const interval of ['', '999', '-1000', '1000.5', '1e3', '9007199254740992']) {
    field(root, 'intervalMs').value = interval;
    await submit(root, 'schedule');
    assert.equal(calls.some(({ op }) => op === 'schedules.create'), false, interval);
  }
  field(root, 'intervalMs').value = '1000';
  await submit(root, 'schedule');
  assert.equal(calls.find(({ op }) => op === 'schedules.create').input.intervalMs, 1000);
});

test('failed mutation is not resent and UI destroy detaches stable listeners', async (t) => {
  const { root, view, calls } = await setup(t, { 'scripts.list': [script], 'jobs.create': new Error('fixture connection lost') });
  selectTargets(root);
  await submit(root, 'job');
  await settle();
  assert.equal(calls.filter(({ op }) => op === 'jobs.create').length, 1);
  assert.match(role(root, 'message').textContent, /Nenhum reenvio automático/);
  const oldForm = form(root, 'job');
  const oldButton = button(root, 'Registrar solicitação imediata');
  const count = calls.length;
  view.destroy();
  oldForm.dispatch('submit');
  await view.refresh();
  assert.equal(root.children.length, 0);
  assert.equal(oldButton.disabled, true);
  assert.equal(oldForm.listeners.get('submit').size, 0);
  assert.equal(calls.length, count);
});

test('missing authenticated bridge refuses to mount', () => {
  const root = dom();
  assert.throws(() => standaloneAdmin().mount(root, null), /ponte autenticada/);
  assert.match(root.textContent, /Acesso indisponível/);
});
