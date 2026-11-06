// Regression tests — Lote 1 fixes (S3, S3b, S1, A15, A14, A2) — node test_fixes.js
"use strict";
let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log('  OK ' + name); } else { fail++; console.log('  FALHOU: ' + name); } }

(async function main() {
    var mod = require('/opt/data/mct2/scripttask.js');
    function makePlugin() {
        var meshServer = {
            debug: function(){},
            db: { GetAllTypeNoTypeField: function(type, domain, cb){ cb(null, []); } },
            webserver: { wsagents: {}, wssessions: {}, users: {}, meshes: {}, domains: [{id:''}] },
            connectivityByNode: {},
            DispatchEvent: function(){ }
        };
        var plugin = mod.scripttask({ parent: meshServer });
        var db = {
            docs: {},
            insert: async function (doc) { if (!doc._id) doc._id = 'x' + Math.random().toString(36).slice(2,8); this.docs[doc._id] = doc; return doc; },
            get: async function (id) { var d = this.docs[id]; return d ? [d] : []; },
            update: async function (id, args) { var d = this.docs[id]; if (!d) return { updated: 0 }; for (var k in args) { if (args[k] !== undefined) d[k] = args[k]; } return { updated: 1 }; },
            delete: async function (id) { delete this.docs[id]; return; },
            countPendingJobsForScript: async function (scriptId, ex) { var n = 0; for (var k in this.docs) { var d = this.docs[k]; if (d.type == 'job' && d.scriptId == scriptId && d.completeTime == null && d._id != ex) n++; } return n; },
            getSchedulesDueForJob: async function () { return []; },
            updateScriptJobName: async function () { return; },
            getStaleJobs: async function () { return []; },
            getPendingJobs: async function () { return []; },
            getScriptTree: async function () { return []; },
            getAllJobSchedules: async function () { return []; },
            getVariables: async function () { return []; },
            getJobNodeHistory: async function () { return []; },
            deleteOldHistory: async function () { return; }
        };
        plugin.db = db; plugin.dbReady = Promise.resolve(db);
        return plugin;
    }
    function makeAgent(node) {
        var sent = [];
        return { dbNodeKey: node, send: function (s) { sent.push(s); }, sent: sent, user: null };
    }

    // === S3: determineNextJobTime — intervalos inválidos não travam ===
    console.log('\n=== S3 interval guards ===');
    var p = makePlugin();
    var now = Math.floor(Date.now() / 1000);
    var r0 = p.determineNextJobTime({ _id: 's0', recur: 'minutes', interval: 0, nextRun: now - 1000, startAt: now - 1000, endAt: null });
    t('interval 0 → null (sem loop infinito)', r0 === null);
    var rn = p.determineNextJobTime({ _id: 'sn', recur: 'daily', interval: -5, nextRun: now - 100000, startAt: now - 1000, endAt: null });
    t('interval -5 → null', rn === null);
    var ru = p.determineNextJobTime({ _id: 'su', recur: 'hourly', interval: undefined, nextRun: now - 1000, startAt: now - 1000, endAt: null });
    t('interval undefined → null', ru === null);
    var rok = p.determineNextJobTime({ _id: 'sok', recur: 'minutes', interval: 10, nextRun: now - 100, startAt: now - 100, endAt: null });
    t('interval 10 válido → próximo run em janela', rok > now && rok <= now + 600);

    // === S3b: addScheduledJob rejeita interval inválido na criação ===
    console.log('\n=== S3b validação na criação ===');
    var p2 = makePlugin();
    var created = [];
    p2.db.addJobSchedule = async function (s) { created.push(s); return s; };
    p2.addScheduledJob({ schedule: { recur: 'minutes', interval: 0, startAt: now, endAt: null, dayVals: null }, command: 'echo x', commandType: 'bash', filter: 'os:linux' }, { name: 'admin' });
    await new Promise(function (r) { setTimeout(r, 50); });
    t('addScheduledJob com interval 0 → 0 schedules criados', created.length === 0);
    p2.addScheduledJob({ schedule: { recur: 'minutes', interval: 5, startAt: now, endAt: null, dayVals: null }, command: 'echo x', commandType: 'bash', filter: 'os:linux' }, { name: 'admin' });
    await new Promise(function (r) { setTimeout(r, 50); });
    t('addScheduledJob com interval 5 → 1 schedule criado', created.length === 1);

    // === S1 + A15: jobComplete — posse, timeout e cleanup do efêmero ===
    console.log('\n=== S1 + A15 jobComplete ===');
    var p3 = makePlugin();
    var p3db = p3.db;
    var agentN1 = makeAgent('node1');

    // efêmero + 2 jobs pendentes (node1, node2)
    var eph = await p3db.insert({ type: 'script', _id: 'eph1', name: 'cmd.sh', path: 'Shared', content: 'echo oi', filetype: 'bash', ephemeral: true, contentHash: 'h' });
    var j1 = await p3db.insert({ type: 'job', _id: 'j1', scriptId: 'eph1', node: 'node1', runBy: 'admin', completeTime: null, dispatchTime: 1000, jobSchedule: null });
    var j2 = await p3db.insert({ type: 'job', _id: 'j2', scriptId: 'eph1', node: 'node2', runBy: 'admin', completeTime: null, dispatchTime: null, jobSchedule: null });

    p3.serveraction({ pluginaction: 'jobComplete', jobId: 'j1', retVal: 'ok', errVal: null, dispatchTime: 1000 }, agentN1, null);
    await new Promise(function (r) { setTimeout(r, 100); });
    var ephAfter = await p3db.get('eph1');
    t('S1: efêmero MANTIDO enquanto j2 pendente', ephAfter.length === 1);
    t('S1: j1 concluído com retVal', (await p3db.get('j1'))[0].completeTime != null && (await p3db.get('j1'))[0].returnVal == 'ok');

    var agentWrong = makeAgent('nodeX');
    p3.serveraction({ pluginaction: 'jobComplete', jobId: 'j2', retVal: 'hacker', errVal: null, dispatchTime: 1000 }, agentWrong, null);
    await new Promise(function (r) { setTimeout(r, 100); });
    t('A15: posse negada — j2 continua pendente e sem retorno', j2stillPending());
    function j2stillPending() { var d = p3db.docs['j2']; return d.completeTime == null && d.returnVal == null; }

    // completa o último job do efêmero → agora pode apagar (com o agente DONO do job)
    var agentNode2 = makeAgent('node2');
    p3.serveraction({ pluginaction: 'jobComplete', jobId: 'j2', retVal: 'done', errVal: null, dispatchTime: null }, agentNode2, null);
    await new Promise(function (r) { setTimeout(r, 100); });
    t('S1: efêmero APAGADO quando último job completa', (await p3db.get('eph1')).length === 0);

    // A15: jobComplete tardio NÃO sobrescreve timeout
    var tj = await p3db.insert({ type: 'job', _id: 'tj', scriptId: 's', node: 'node1', completeTime: now, errorVal: 'Timeout: agent did not respond within 180 seconds', dispatchTime: now - 200 });
    agentN1.delayed = true;
    p3.serveraction({ pluginaction: 'jobComplete', jobId: 'tj', retVal: 'tardio', errVal: null, dispatchTime: now - 200 }, agentN1, null);
    await new Promise(function (r) { setTimeout(r, 100); });
    var after = p3db.docs['tj'];
    t('A15: jobComplete tardio não sobrescreve timeout', after.errorVal === 'Timeout: agent did not respond within 180 seconds' && after.returnVal == null);

    // === A14: interpolação sem mutar cache + escapes ===
    console.log('\n=== A14 interpolação ===');
    var src = require('fs').readFileSync('/opt/data/mct2/modules_meshcore/scripttask.js', 'utf8');
    t('A14: runScript clona objeto (JSON.parse(JSON.stringify(sObj)))', src.indexOf('JSON.parse(JSON.stringify(sObj))') !== -1);
    t('A14: key escapado p/ RegExp', src.indexOf('key.replace(') !== -1 && src.indexOf("'\\\\$&'") !== -1);
    t('A14: val como função (sem interpretação de $)', /'g'\),\s*function\(\)\s*\{\s*return val;/.test(src));
    // comportamento real do padrão aplicado no A14:
    var key = 'GBL:node.id';
    var re = new RegExp('#' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '#', 'g');
    t('A14: ponto no key casa literal', re.test('#GBL:node.id#'));
    var valOut = null;
    var replaced = 'echo #VARX#'.replace(new RegExp('#' + 'VARX'.replace(/[.*+?^${}()|[\\]/g, '\\$&') + '#', 'g'), function () { return '$& &1'; });
    t('A14: val com $ não é interpretado como padrão', replaced === 'echo $& &1');

    // === A2: cleanup de runningJobs (itera decrescente, remove por jobId) ===
    console.log('\n=== A2 cleanup runningJobs ===');
    t('A2: usa splice(i, 1) em vez de remove(indexOf(idx))', src.indexOf('runningJobs.splice(i, 1);') !== -1 && src.indexOf('runningJobs.remove(runningJobs.indexOf(idx));') === -1);

    // === A16: fs do meshagent (Duktape) NÃO aceita options no writeFileSync ===
    console.log('\n=== A16 compat Duktape (runBash) ===');
    t('A16: writeFileSync do runBash sem objeto options', src.indexOf(".split('\\r').join('\\n'), { mode: 0o600 })") === -1);
    t('A16: chmodSync 0600 (384) best-effort presente', src.indexOf('fs.chmodSync(path + pName, 384)') !== -1);
    t('A16: chmod 700 no shell (sem a+x)', src.indexOf("child.stdin.write('chmod 700 ' + pName") !== -1 && src.indexOf("child.stdin.write('chmod a+x ' + pName") === -1);

    console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
    process.exit(fail ? 1 : 0);
})().catch(function (e) { console.log('ERRO FATAL: ' + e); process.exit(1); });
