/* MeshAgent ES5 adapter, NOT Node. See docs/RUNTIME-CONTRACTS.md.
 * Trust: TLS control singleton + strict rejection of user/console routes.
 * Single authoritative server only. No disk, shell temp files or offline grants.
 */
'use strict';
var mesh, bootNonce, pending, initialized = false, fatal = false;
var records = Object.create(null), recordCount = 0, running = 0;
var bn, nonceRange, processes, fs, sha, os, clockTimer;
function monotonic() {
    var value = os.uptime();
    if (typeof value !== 'number' || !isFinite(value) || value < 0) throw new Error('clock_unavailable');
    return value;
}
var MAX_RECORDS = 1000, TTL = 10000;
function nonce() { return bn.random(nonceRange).toString(); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) {
    if (!plain(value)) return false;
    for (var key in value) { if (allowed.indexOf(key) < 0) return false; }
    return true;
}
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && value.indexOf('\u0000') < 0; }
function id(value) { return text(value, 128) && /^[a-zA-Z0-9_-]+$/.test(value); }
function send(message) { try { mesh.SendCommand(message); } catch (e) { /* Query/poll can recover retained results. Never spawn again. */ } }
function base(type, command) {
    return { action: 'plugin', plugin: 'meshtask2', version: 1, type: type, jobId: command.jobId, attemptId: command.attemptId, token: command.token };
}
function origin(command, rights, sessionid, parent) {
    if (!mesh) { try { mesh = require('MeshAgent'); } catch (e) { return false; } }
    if (parent !== mesh || rights != null || sessionid != null || !plain(command)) return false;
    if (command.action !== 'plugin' || command.plugin !== 'meshtask2' || command.version !== 1) return false;
    var denied = ['_', 'sessionid', 'fromSessionid', 'userid', 'rights', 'routeToNode'];
    for (var i = 0; i < denied.length; i++) { if (denied[i] in command) return false; }
    return true;
}
function initialize() {
    if (fatal) return false;
    if (initialized) return true;
    try {
        if (process.platform !== 'linux' && process.platform !== 'win32') throw new Error('platform');
        os = require('os'); monotonic();
        bn = require('bignum');
        nonceRange = bn('115792089237316195423570985008687907853269984665640564039457584007913129639936');
        bootNonce = nonce();
        processes = require('child_process');
        fs = require('fs');
        sha = require('SHA256Stream').create();
        if (typeof processes.execFile !== 'function' || typeof fs.existsSync !== 'function' || typeof sha.syncHash !== 'function' || typeof setTimeout !== 'function') throw new Error('runtime');
        initialized = true;
        return true;
    } catch (e) { fatal = true; pending = null; return false; }
}
function interpreter(engine) {
    if (process.platform === 'linux' && engine === 'bash' && fs.existsSync('/bin/bash')) return { path: '/bin/bash', argv: ['bash', '--noprofile', '--norc', '-s'] };
    if (process.platform === 'win32' && engine === 'powershell') {
        var root = process.env && process.env.windir;
        if (typeof root !== 'string' || !/^[a-zA-Z]:\\[^\u0000\r\n]+$/.test(root)) return null;
        var path = root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        if (fs.existsSync(path)) return { path: path, argv: ['powershell', '-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '-'] };
    }
    return null;
}
function clearPending() {
    pending = null;
    if (clockTimer) { clearTimeout(clockTimer); clockTimer = null; }
}
function pull(command) {
    if (!keys(command, ['action', 'plugin', 'version', 'type', 'domain', 'node']) || !text(command.node, 512) || typeof command.domain !== 'string' || command.domain.length > 128 || command.node.indexOf('node/' + command.domain + '/') !== 0) return false;
    // Retained results may have been lost in transit or rejected during DB outage.
    for (var key in records) { if (records[key].result && !records[key].delivered) send(records[key].result); }
    if (recordCount >= MAX_RECORDS) { send({ action: 'plugin', plugin: 'meshtask2', version: 1, type: 'capability', reason: 'executor_capacity' }); return false; }
    if (running) return false;
    try {
        if (!pending) {
            pending = { nonce: nonce(), domain: command.domain, node: command.node, at: Date.now(), monotonic: monotonic() };
            clockTimer = setTimeout(function () { pending = null; clockTimer = null; }, TTL);
        }
        if (pending.domain !== command.domain || pending.node !== command.node) return false;
        var engines = [];
        if (interpreter('bash')) engines.push('bash');
        if (interpreter('powershell')) engines.push('powershell');
        send({ action: 'plugin', plugin: 'meshtask2', version: 1, type: 'pull', bootNonce: bootNonce, requestNonce: pending.nonce, engines: engines, reason: engines.length ? '' : 'interpreter_unavailable' });
        return true;
    } catch (e) { clearPending(); fatal = true; return false; }
}
function reject(record, reason) {
    var result = base('result', record.command);
    result.outcome = 'rejected'; result.exitCode = null; result.reason = reason;
    result.stdout = ''; result.stderr = ''; result.truncated = false;
    record.result = result; send(result);
}
function capture(record, field, chunk) {
    try {
        // Keep up to 8192 original bytes. Hex is bounded and joins split UTF-8
        // sequences without assuming Node StringDecoder or Buffer.concat.
        var left = 8192 - record[field].length / 2;
        if (chunk.length > left) record.truncated = true;
        record[field] += chunk.slice(0, Math.max(0, left)).toString('hex');
    } catch (e) { record.ioFailed = true; }
}
function output(hex) { return Buffer.from(hex, 'hex').toString('utf8').split('\u0000').join('\ufffd'); }
function execute(command) {
    if (!keys(command, ['action', 'plugin', 'version', 'type', 'jobId', 'attemptId', 'token', 'context', 'script', 'domain', 'node', 'bootNonce', 'requestNonce', 'grantTtlMs'])) return false;
    if (!id(command.jobId) || !id(command.attemptId) || !/^[a-f0-9]{64}$/.test(command.token) || typeof command.token !== 'string') return false;
    if (!pending || command.bootNonce !== bootNonce || command.requestNonce !== pending.nonce || command.domain !== pending.domain || command.node !== pending.node || command.grantTtlMs !== TTL || Date.now() < pending.at || Date.now() - pending.at >= TTL || monotonic() < pending.monotonic || monotonic() - pending.monotonic >= 9) return false;
    if (records[command.attemptId] || recordCount >= MAX_RECORDS || running) return false;
    var script = command.script;
    if (!keys(script, ['scriptId', 'revision', 'engine', 'body', 'hash']) || !id(script.scriptId) || typeof script.revision !== 'number' || script.revision < 1 || script.revision % 1 !== 0 || !text(script.body, 65536) || !/^[a-f0-9]{64}$/.test(script.hash)) return false;
    if (Buffer.from(script.body, 'utf8').length > 65536 || sha.syncHash(Buffer.from(script.body, 'utf8')).toString('hex') !== script.hash) return false;
    // Consume synchronously before ANY spawn, send or user-controlled callback.
    clearPending();
    var record = { command: base('execute', command), stdout: '', stderr: '', truncated: false, child: null, result: null, delivered: false, ioFailed: false, exited: false };
    records[command.attemptId] = record; recordCount++;
    if (command.context !== 'service') { reject(record, 'unsupported_context'); return true; }
    var runner;
    try { runner = interpreter(script.engine); } catch (e) { runner = null; }
    if (!runner) { reject(record, 'interpreter_unavailable'); return true; }
    running++;
    try {
        // argv[0] is REQUIRED by MeshAgent. No shell interpolation of the script.
        var child = processes.execFile(runner.path, runner.argv, {});
        record.child = child; // Strong reference until exit; finalizer can kill a live child.
        child.stdout.on('data', function (chunk) { capture(record, 'stdout', chunk); });
        child.stderr.on('data', function (chunk) { capture(record, 'stderr', chunk); });
        child.on('exit', function (code) {
            if (record.exited) return;
            record.exited = true; running--; record.child = null;
            if (record.ioFailed) { sendStatus(record, 'unknown'); return; }
            if (typeof code !== 'number' || code % 1 !== 0 || code < -2147483648 || code > 4294967295) {
                sendStatus(record, 'unknown'); return;
            }
            var result = base('result', command);
            result.outcome = 'completed'; result.exitCode = code;
            result.stdout = output(record.stdout); result.stderr = output(record.stderr); result.truncated = record.truncated;
            record.result = result; send(result);
        });
        send(base('ack', command));
        var body = script.body;
        if (script.engine === 'powershell') {
            // Encode data, not command-line arguments. Parse entire script first;
            // stop on nonterminating PS errors and preserve explicit/native exit.
            body = "$ErrorActionPreference='Stop'; $LASTEXITCODE=0; try { . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(body, 'utf8').toString('base64') + "')))); if (-not $?) { exit 1 }; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }\r\n";
        }
        child.stdin.write(body + '\n');
        child.stdin.end();
    } catch (e) {
        if (!record.child) { running--; reject(record, 'spawn_failed'); }
        else { record.ioFailed = true; sendStatus(record, 'unknown'); } // stdin/listener failure may have started effects.
    }
    return true;
}
function sendStatus(record, state) { var reply = base('status', record.command); reply.state = state; send(reply); }
function query(command) {
    if (!keys(command, ['action', 'plugin', 'version', 'type', 'jobId', 'attemptId', 'token']) || !id(command.attemptId) || !id(command.jobId) || typeof command.token !== 'string' || !/^[a-f0-9]{64}$/.test(command.token)) return false;
    var record = records[command.attemptId];
    if (!record) { var absent = base('status', command); absent.state = 'not_found'; send(absent); return true; }
    if (record.command.jobId !== command.jobId || record.command.token !== command.token) return false;
    if (command.type === 'receipt') { if (record.result) { record.delivered = true; record.result = null; record.stdout = record.stderr = ''; } return true; }
    if (record.result) send(record.result); else sendStatus(record, record.child ? 'running' : 'unknown');
    return true;
}
module.exports.consoleaction = function (command, rights, sessionid, parent) {
    if (!origin(command, rights, sessionid, parent)) return 'MeshTask 2: origem recusada; nenhuma execução autorizada.';
    if (!initialize()) {
        send({ action: 'plugin', plugin: 'meshtask2', version: 1, type: 'capability', reason: 'runtime_unavailable' });
        return 'MeshTask 2: capacidades de runtime indisponíveis; execução recusada.';
    }
    try {
        if (Buffer.from(JSON.stringify(command), 'utf8').length > 196608) return false;
        if (command.type === 'poll') return pull(command);
        if (command.type === 'execute') return execute(command);
        if (command.type === 'query' || command.type === 'receipt') return query(command);
    } catch (e) { return false; }
    return false;
};
