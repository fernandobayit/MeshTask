'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const source = fs.readFileSync(require.resolve('../modules_meshcore/meshtask2'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
  const sent = [], children = [], timers = new Map(); let serial = 0, now = 1000;
  const mesh = { SendCommand(message) { sent.push(clone(message)); if (options.onSend) options.onSend(clone(message)); } };
  const bn = (range) => { if (range !== '115792089237316195423570985008687907853269984665640564039457584007913129639936') throw new Error('range'); return range; };
  bn.random = () => { if (options.rngFail) throw new Error('entropy unavailable'); return { toString: () => BigInt('0x' + randomBytes(32).toString('hex')).toString() }; };
  const modules = {
    MeshAgent: mesh, bignum: bn, os: { uptime: () => options.clockFail ? NaN : Math.floor(now / 1000) },
    SHA256Stream: { create: () => ({ syncHash: (bytes) => createHash('sha256').update(bytes).digest() }) },
    fs: { existsSync: (file) => options.exists ? options.exists(file) : true },
    child_process: { execFile(path, argv, opts) {
      if (options.spawnFail) throw new Error('spawn failed');
      if (options.execFile) return options.execFile(path, clone(argv), clone(opts));
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.writes = [];
      child.stdin = { write(value) { if (options.stdinFail) throw new Error('pipe'); child.writes.push(value); }, end() { child.ended = true; } };
      child.path = path; child.argv = clone(argv); child.options = clone(opts); children.push(child); return child;
    } }
  };
  const sandbox = { module: { exports: {} }, Buffer, process: { platform: options.platform || 'linux', env: { windir: 'C:\\Windows' } }, Date: { now: () => now },
    require(name) { if (!Object.hasOwn(modules, name) || options.missing === name) throw new Error('Unavailable module: ' + name); return modules[name]; },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(source, sandbox, { filename: 'meshtask2-agent.js' });
  const act = (message, rights = null, session = null, parent = mesh) => sandbox.module.exports.consoleaction(clone(message), rights, session, parent);
  function poll() { act({ action: 'plugin', plugin: 'meshtask2', version: 1, type: 'poll', domain: 'lab', node: 'node/lab/one' }); return sent.filter((m) => m.type === 'pull').at(-1); }
  function grant(overrides = {}) {
    const pull = poll(), body = overrides.body || 'printf "unit stdout"; printf "unit stderr" >&2; exit 7';
    const script = { scriptId: 'script-1', revision: 1, engine: options.platform === 'win32' ? 'powershell' : 'bash', body, hash: createHash('sha256').update(body).digest('hex') };
    const extra = { ...overrides }; delete extra.body;
    return { action: 'plugin', plugin: 'meshtask2', version: 1, type: 'execute', jobId: 'job-1', attemptId: 'attempt-1', token: '1'.repeat(64), context: 'service', script, domain: 'lab', node: 'node/lab/one', bootNonce: pull?.bootNonce, requestNonce: pull?.requestNonce, grantTtlMs: 10000, ...extra };
  }
  return { mesh, sent, children, timers, act, poll, grant, advance(delta) { now += delta; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } }, clock: () => now };
}
module.exports = { harness, clone };
