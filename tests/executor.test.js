'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { harness, clone } = require('./agent-harness');
const { incoming } = require('../lib/protocol');
const result = (f) => f.sent.filter((m) => m.type === 'result').at(-1);
function query(grant, type = 'query') { const { action, plugin, version, jobId, attemptId, token } = grant; return { action, plugin, version, type, jobId, attemptId, token }; }

test('MeshAgent adapter spawns Bash with argv[0], stdin EOF, captures actual nonzero exit and streams', () => {
  const f = harness(), grant = f.grant();
  assert.equal(f.act(grant), true); assert.equal(f.children.length, 1); assert.equal(f.timers.size, 0);
  const child = f.children[0];
  assert.equal(child.path, '/bin/bash'); assert.deepEqual(child.argv, ['bash', '--noprofile', '--norc', '-s']); assert.deepEqual(child.options, {});
  assert.equal(child.writes.join(''), grant.script.body + '\n'); assert.equal(child.ended, true);
  assert.equal(result(f), undefined); assert.equal(f.sent.at(-1).type, 'ack');
  child.stdout.emit('data', Buffer.from('Olá\n')); child.stderr.emit('data', Buffer.from('erro\n')); child.emit('exit', 7, null);
  assert.deepEqual({ ...incoming(result(f)) }, { ...query(grant, 'result'), outcome: 'completed', exitCode: 7, stdout: 'Olá\n', stderr: 'erro\n', truncated: false });
});

test('positive singleton identity rejects clean tunnel, lookalike parent and every console/user marker including null', () => {
  const f = harness(), grant = f.grant();
  for (const parent of [{}, { SendCommand: f.mesh.SendCommand }, { httprequest: {} }, null]) assert.match(f.act(grant, null, null, parent), /recusada/);
  for (const key of ['_', 'sessionid', 'fromSessionid', 'userid', 'rights', 'routeToNode']) for (const value of [null, false, 0, '', []]) assert.match(f.act({ ...grant, [key]: value }), /recusada/);
  assert.match(f.act(grant, 0, null), /recusada/); assert.match(f.act(grant, null, ''), /recusada/);
  assert.equal(f.act({ ...grant, server: true }), false); assert.equal(f.children.length, 0);
  assert.equal(f.act(grant), true, 'invalid origin never consumes a legitimate pull');
});

test('closed schema, altered hash, cross-node/domain and invalid nonces fail without spawn', () => {
  const f = harness(), grant = f.grant();
  for (const change of [{ node: 'node/lab/two' }, { domain: 'other' }, { bootNonce: '0' }, { requestNonce: '0' }, { grantTtlMs: 99999 }, { version: 2 }, { script: { ...grant.script, body: 'exit 0' } }, { script: { ...grant.script, hash: '0'.repeat(64) } }, { extra: {} }]) f.act({ ...grant, ...change });
  assert.equal(f.children.length, 0);
  assert.equal(f.act(grant), true);
});

test('consume before ACK/spawn prevents duplicate grant and replay under a fresh pull; boot reload rejects old grant', () => {
  const f = harness(), grant = f.grant(); f.act(grant); f.act(grant); assert.equal(f.children.length, 1);
  f.children[0].emit('exit', 0); f.act(grant); assert.equal(f.children.length, 1);
  const fresh = f.grant(); assert.notEqual(fresh.requestNonce, grant.requestNonce);
  f.act({ ...grant, requestNonce: fresh.requestNonce }); assert.equal(f.children.length, 1, 'attempt tombstone retained');
  const reboot = harness(), current = reboot.grant(); assert.notEqual(current.bootNonce, grant.bootNonce);
  reboot.act({ ...grant, requestNonce: current.requestNonce }); assert.equal(reboot.children.length, 0);
});

test('deadline expiration and backward clock fail closed; new request nonce is distinct', () => {
  const f = harness(), grant = f.grant(); f.advance(10000); assert.equal(f.act(grant), false);
  const next = f.grant(); assert.notEqual(next.requestNonce, grant.requestNonce);
  f.advance(-1); assert.equal(f.act(next), false); assert.equal(f.children.length, 0);
});

test('missing CSPRNG/module and RNG failure never use fallback entropy or start a process', () => {
  for (const options of [{ missing: 'bignum' }, { rngFail: true }, { missing: 'SHA256Stream' }, { missing: 'child_process' }, { clockFail: true }]) {
    const f = harness(options); assert.equal(f.poll(), undefined); assert.equal(f.children.length, 0);
    assert.equal(f.sent.at(-1).reason, 'runtime_unavailable');
  }
});

test('runtime/interpreter/context rejection differs from success and cannot be retried with same attempt', () => {
  for (const options of [{ spawnFail: true }, { exists: () => false }, {}]) {
    const f = harness(options), grant = f.grant(options.spawnFail || options.exists ? {} : { context: 'user' });
    f.act(grant); assert.equal(result(f).outcome, 'rejected'); assert.equal(result(f).exitCode, null);
    incoming(result(f)); f.act(grant); assert.equal(f.children.length, 0);
  }
});

test('stdin failure after spawn is unknown even if child later exits zero; no fabricated completion', () => {
  const f = harness({ stdinFail: true }), grant = f.grant(); f.act(grant);
  assert.equal(f.sent.at(-1).state, 'unknown'); f.children[0].emit('exit', 0);
  assert.equal(result(f), undefined); assert.equal(f.sent.at(-1).state, 'unknown');
});

test('retained result is resent on poll/query until receipt; tombstone survives receipt', () => {
  const f = harness(), grant = f.grant(); f.act(grant); f.children[0].emit('exit', 0);
  const saved = result(f); f.act(query(grant)); assert.deepEqual(f.sent.at(-1), saved);
  f.act(query(grant, 'receipt')); f.poll(); const count = f.sent.filter((m) => m.type === 'result').length;
  f.poll(); assert.equal(f.sent.filter((m) => m.type === 'result').length, count);
  f.act(grant); assert.equal(f.children.length, 1);
});

test('output is bounded, null bytes sanitized and invalid exit never claims success', () => {
  const f = harness(), grant = f.grant(); f.act(grant);
  f.children[0].stdout.emit('data', Buffer.from('\0' + '😀'.repeat(20000))); f.children[0].stderr.emit('data', Buffer.from('é'.repeat(20000))); f.children[0].emit('exit', 0);
  const out = incoming(result(f)); assert.equal(out.truncated, true); assert.ok(Buffer.byteLength(out.stdout) <= 32768); assert.ok(Buffer.byteLength(out.stderr) <= 32768); assert.equal(out.stdout.includes('\0'), false);
  const next = f.grant({ attemptId: 'attempt-2' }); f.act(next); f.children[1].emit('exit', undefined);
  assert.equal(f.sent.at(-1).state, 'unknown');
});

test('PowerShell uses fixed argv and base64 data over stdin, with explicit failure/native exit policy', () => {
  const f = harness({ platform: 'win32' }), body = 'Write-Output "Olá"\r\nexit 9', grant = f.grant({ body });
  assert.equal(f.act(grant), true);
  const child = f.children[0];
  assert.equal(child.path, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(child.argv, ['powershell', '-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '-']);
  assert.equal(child.argv.some((value) => value.includes('Olá')), false);
  const encoded = child.writes[0].match(/FromBase64String\('([^']+)'\)/)[1]; assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), body);
  assert.match(child.writes[0], /ErrorActionPreference='Stop'/); assert.match(child.writes[0], /exit \$LASTEXITCODE/); assert.equal(child.ended, true);
  child.emit('exit', 9); assert.equal(result(f).exitCode, 9);
});

test('isolated real Bash stdin check via explicit Node-to-MeshAgent test adapter; no filesystem/services', async (t) => {
  let finished;
  const completion = new Promise((resolve) => { finished = resolve; });
  let native;
  const f = harness({ onSend: (message) => { if (message.type === 'result') finished(message); }, execFile(path, argv) {
    native = spawn(path, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    const adapter = new EventEmitter(); adapter.stdout = native.stdout; adapter.stderr = native.stderr; adapter.stdin = native.stdin;
    // Pinned MeshAgent process pipe drains before exit. Node's close is its test equivalent.
    native.on('close', (code) => adapter.emit('exit', code, null)); return adapter;
  } });
  t.after(() => { if (native && native.exitCode === null) native.kill('SIGKILL'); });
  assert.equal(f.act(f.grant({ body: 'printf "Olá\\n"; printf "erro\\n" >&2; exit 7' })), true);
  const timer = setTimeout(() => finished(null), 2000);
  const out = await completion; clearTimeout(timer);
  assert.ok(out, 'unit subprocess completed'); assert.equal(out.exitCode, 7); assert.equal(out.stdout, 'Olá\n'); assert.equal(out.stderr, 'erro\n');
});

test('split UTF-8 data is reconstructed before decoding within bounded capture', () => {
  const f = harness(), grant = f.grant(); f.act(grant);
  const bytes = Buffer.from('á😀');
  for (const byte of bytes) f.children[0].stdout.emit('data', Buffer.from([byte]));
  f.children[0].emit('exit', 0); assert.equal(result(f).stdout, 'á😀');
});

test('monotonic second-resolution deadline rejects at nine seconds even before timer fires', () => {
  const f = harness(), grant = f.grant(); f.advance(9000);
  assert.equal(f.timers.size, 1); assert.equal(f.act(grant), false); assert.equal(f.children.length, 0);
});

test('dedup capacity closes execution instead of evicting tombstones', () => {
  const f = harness(); let first;
  for (let i = 0; i < 1000; i++) {
    const grant = f.grant({ attemptId: 'attempt-' + i }); if (!first) first = grant;
    assert.equal(f.act(grant), true); f.children[i].emit('exit', 0); f.act(query(grant, 'receipt'));
  }
  f.poll(); assert.equal(f.sent.at(-1).reason, 'executor_capacity');
  assert.equal(f.act(first), false); assert.equal(f.children.length, 1000);
});
