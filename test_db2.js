// Unit tests for db2.js (SQLite layer) — run with: node test_db2.js
"use strict";
const fs = require('fs');
const path = require('path');
const os = require('os');

const TESTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-db2-test-'));
process.env.SQLITE_TEST_PATH = TESTDIR;

// stub the meshserver object with datapath
const meshserver = { datapath: TESTDIR, parentpath: null };

let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ FALHOU: ' + name); } }
function section(s) { console.log('\n=== ' + s + ' ==='); }

(async function main() {
    const CreateDB = require('./db2.js').CreateDB;

    section('abertura + schema');
    const db = CreateDB(meshserver);
    const mig = await db.ready;
    t('db abriu', !!db.scriptFile === false && !!db.get === true); // API surface via closure
    t('migração: sem nedb → no-op', mig.migrated === false && mig.reason == 'no-nedb-file');

    section('scripts/folders');
    const s1 = await db.addScript('teste.sh', '#!/bin/bash\necho oi\n', 'Shared', 'bash');
    t('addScript retorna doc com _id', s1 && s1._id && s1.contentHash.length == 96);
    const got1 = await db.get(s1._id);
    t('get recupera script', got1.length == 1 && got1[0].name == 'teste.sh');
    await db.addFolder('Linux', 'Shared/Linux');
    const s2 = await db.addScript('linux.sh', '#!/bin/bash\n', 'Shared/Linux', 'bash');
    const tree = await db.getScriptTree();
    t('tree tem 2 scripts + 2 folders', tree.length == 4);
    t('tree ordena por path', tree[0].path == 'Shared' && tree[tree.length - 1].path == 'Shared/Linux');
    await db.update(s1._id, { name: 'renomeado.sh' });
    const got1b = await db.get(s1._id);
    t('update renomeia', got1b[0].name == 'renomeado.sh');
    await db.update(s2._id, { content: '#!/bin/bash\necho novo\n' });
    const got2 = await db.get(s2._id);
    t('update re-hasha conteúdo', got2[0].contentHash.length == 96 && got2[0].contentHash != s2.contentHash);
    const byPath = await db.getByPath('Shared/Linux');
    t('getByPath inclui script', byPath.some(d => d._id == s2._id));

    section('jobs');
    const j1 = await db.addJob({ scriptId: s1._id, node: 'node//x', runBy: 'admin' });
    t('addJob cria job', j1 && j1._id && j1.queueTime > 0 && j1.completeTime == null);
    const j2 = await db.addJob({ scriptId: s1._id, node: 'node//y', runBy: 'admin' });
    const pend = await db.getPendingJobs(['node//x', 'node//y']);
    t('getPendingJobs retorna 2', Array.isArray(pend) && pend.length == 2);
    const pendX = await db.getPendingJobs(['node//x']);
    t('getPendingJobs filtra por node', pendX.length == 1 && pendX[0]._id == j1._id);
    await db.update(j1._id, { completeTime: 123, returnVal: 'ok' });
    const pendAfter = await db.getPendingJobs(['node//x', 'node//y']);
    t('job completado sai do pending', pendAfter.length == 1);
    const hist = await db.getJobNodeHistory('node//x');
    t('history do node tem job completo', hist.length == 1 && hist[0].returnVal == 'ok');
    await db.updateScriptJobName(s1._id, 'Novo Nome');
    const j1full = (await db.get(j1._id))[0];
    t('updateScriptJobName replica', j1full._id && j1full.scriptName == 'Novo Nome');

    section('schedules');
    const now = Math.floor(Date.now() / 1000);
    const sch1 = await db.addJobSchedule({ scriptId: s1._id, node: 'node//x', recur: 'minutes', interval: 5, startAt: now, endAt: null, scheduledBy: 'admin' });
    t('addJobSchedule (node)', sch1 && sch1._id);
    const schF = await db.addJobSchedule({ scriptId: s1._id, filter: 'os:linux', recur: 'daily', interval: 1, startAt: now, endAt: null, scheduledBy: 'admin' });
    t('addJobSchedule (filter)', schF && schF._id && schF.filter == 'os:linux');
    const due = await db.getSchedulesDueForJob(null);
    t('schedules due inclui ambos', due.length == 2);
    const dueFiltered = await db.getSchedulesDueForJob(schF._id);
    t('schedules due por id', dueFiltered.length == 1 && dueFiltered[0]._id == schF._id);
    const fs1 = await db.getJobSchedulesForFilter();
    t('getJobSchedulesForFilter só o de filtro', fs1.length == 1 && fs1[0]._id == schF._id);
    await db.update(schF._id, { nextRun: now + 3600 });
    const due2 = await db.getSchedulesDueForJob(null);
    t('nextRun futuro sai da due list', due2.length == 1 && due2[0]._id == sch1._id);
    const jSched = await db.addJob({ scriptId: s1._id, node: 'node//x', runBy: 'admin', jobSchedule: sch1._id });
    const inc = await db.getIncompleteJobsForSchedule(sch1._id);
    t('incomplete jobs p/ schedule', inc.length == 1 && inc[0]._id == jSched._id);
    await db.deletePendingJobsForSchedule(sch1._id);
    const inc2 = await db.getIncompleteJobsForSchedule(sch1._id);
    t('deletePendingJobsForSchedule', inc2.length == 0);

    section('variáveis');
    await db.addVariable('ENV', 'global', null, 'prod');
    await db.addVariable('ENV', 'node', 'node//x', 'dev');
    const allv = await db.getVariables();
    t('getVariables all', allv.length == 2);
    const scoped = await db.getVariables({ names: ['ENV'], scriptId: null, meshId: null, nodeId: 'node//x' });
    t('getVariables resolve node>global', scoped.length == 2 && scoped[0].value == 'prod' && scoped[1].value == 'dev');
    const scopedG = await db.getVariables({ names: ['ENV'], scriptId: null, meshId: null, nodeId: 'node//other' });
    t('getVariables só global p/ node desconhecido', scopedG.length == 1 && scopedG[0].value == 'prod');

    section('delete ops');
    await db.addScript('del.sh', 'x', 'Shared/Temp', 'bash');
    await db.deleteByPath('Shared/Temp');
    const treeAfter = await db.getScriptTree();
    t('deleteByPath remove da tree', treeAfter.every(d => d.name != 'del.sh'));
    await db.deleteSchedulesForScript(s1._id);
    const schAfter = await db.getJobSchedulesForScript(s1._id);
    t('deleteSchedulesForScript', schAfter.length == 0);

    section('migração NeDB → SQLite');
    // create a fake legacy nedb file in ANOTHER tmpdir
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'st-db2-mig-'));
    const nedbLines = [];
    const mkdoc = (d) => nedbLines.push(JSON.stringify(d));
    mkdoc({ type: 'folder', path: 'Shared', name: 'Shared', _id: 'DWHyz22O2ragPEJ1' });
    mkdoc({ $$indexCreated: { fieldName: 'name' } }); // index line — must be ignored
    mkdoc({ type: 'script', path: 'Shared', name: 'old.sh', content: '#!/bin/bash\necho old\n', contentHash: 'a'.repeat(96), filetype: 'bash', _id: 'abcDEF1234567890' });
    mkdoc({ type: 'variable', name: 'OLDVAR', scope: 'global', scopeTarget: null, value: 'x', _id: 'var0001234567890' });
    fs.writeFileSync(path.join(dir2, 'plugin-scripttask.db'), nedbLines.join('\n') + '\n');
    const db2 = CreateDB({ datapath: dir2, parentpath: null });
    const mig2 = await db2.ready;
    t('migração executou', mig2.migrated === true && mig2.docs == 3);
    t('nedb renomeado p/ backup', !fs.existsSync(path.join(dir2, 'plugin-scripttask.db')) && fs.existsSync(mig2.backup));
    const old = await db2.get('abcDEF1234567890');
    t('script migrado recuperável', old.length == 1 && old[0].name == 'old.sh');
    const tree2 = await db2.getScriptTree();
    t('tree pós-migração', tree2.length == 2 && tree2.some(d => d.name == 'Shared'));
    const vs = await db2.getVariables();
    t('variável migrada', vs.length == 1 && vs[0].name == 'OLDVAR');
    // idempotency: re-open → should NOT duplicate
    const db3 = CreateDB({ datapath: dir2, parentpath: null });
    const mig3 = await db3.ready;
    t('re-abertura não duplica', mig3.migrated === false);
    const tree3 = await db3.getScriptTree();
    t('sem duplicação de docs', tree3.length == 2);
    const oldv = await db3.getVariables();
    t('sem duplicação de variáveis', oldv.length == 1);

    section('getStaleJobs — regra de timeout 3 min');
    const nowT = Math.floor(Date.now() / 1000);
    const jStale1 = await db.addJob({ scriptId: s1._id, node: 'node//stale1' }); // dispatched 200s atrás
    await db.update(jStale1._id, { dispatchTime: nowT - 200 });
    const jStale2 = await db.addJob({ scriptId: s1._id, node: 'node//stale2' }); // nunca despachado, na fila 200s atrás
    const raw2 = await db.get(jStale2._id);
    // simular queueTime antigo (addJob define queueTime=now)
    const jFresh = await db.addJob({ scriptId: s1._id, node: 'node//fresh' }); // despachado agora
    await db.update(jFresh._id, { dispatchTime: nowT });
    const stale = await db.getStaleJobs(nowT, 180);
    t('stale: dispatched antigo pego', stale.some(j => j._id == jStale1._id));
    t('stale: nunca despachado + queueTime antigo é pego? (queueTime é agora — não)', !stale.some(j => j._id == jStale2._id));
    t('stale: recente não pego', !stale.some(j => j._id == jFresh._id));
    // forçar queueTime antigo no jStale2
    await db.update(jStale2._id, { queueTime: nowT - 200 });
    const stale2 = await db.getStaleJobs(nowT, 180);
    t('stale: dispatchTime IS NULL + queueTime < limite → pego', stale2.some(j => j._id == jStale2._id));

    section('persistência entre instâncias');
    const sPersist = await db.addScript('persist.sh', 'x', 'Shared', 'bash');
    await db.close();
    const db4 = CreateDB(meshserver);
    await db4.ready;
    const gotP = await db4.get(sPersist._id);
    t('doc persiste entre instâncias', gotP.length == 1 && gotP[0].name == 'persist.sh');
    await db4.close();

    console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO FATAL:', e); process.exit(2); });