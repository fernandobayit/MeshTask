
"use strict";
// ---- mocks ----
function makePlugin() {
    var sentToAgent = [], dispatched = [], dbCalls = [];
    var meshServer = {
        debug: function(){},
        db: { GetAllTypeNoTypeField: function(type, domain, cb){ cb(null, []); } },
        webserver: { wsagents: {}, wssessions: {}, users: {}, meshes: {}, domains: [{id:''}] },
        connectivityByNode: {},
        DispatchEvent: function(ids, source, ev){ dispatched.push(ev); }
    };
    var parent = { parent: meshServer };
    var mod = require('/opt/data/mct2/scripttask.js');
    var plugin = mod.scripttask(parent);
    // mock db
    var db = {
        addScript: async function(n,c,p,f){ return { _id:'s1', name:n }; },
        get: async function(id){ return [{ _id:id, name:'t.sh', content:'echo', contentHash:'h', filetype:'bash' }]; },
        update: async function(id,args){ return {updated:1}; },
        delete: async function(id){ return {deleted:1}; },
        addFolder: async function(n,p){ return {_id:'f1'}; },
        getScriptTree: async function(){ return []; },
        addJob: async function(o){ return Object.assign({_id:'j1'}, o); },
        addJobSchedule: async function(s){ return Object.assign({_id:'s9'}, s); },
        removeJobSchedule: async function(id){ return; },
        getSchedulesDueForJob: async function(){ return []; },
        getPendingJobs: async function(){ return []; },
        getStaleJobs: async function(){ return []; },
        getJobNodeHistory: async function(){ return []; },
        getJobScriptHistory: async function(){ return []; },
        getJobSchedulesForScript: async function(){ return []; },
        getJobSchedulesForNode: async function(){ return []; },
        getAllJobSchedules: async function(){ return []; },
        getVariables: async function(){ return []; },
        deleteOldHistory: async function(){ return; },
        deleteByPath: async function(){ return; },
        deleteSchedulesForScript: async function(){ return; },
        deletePendingJobsForNode: async function(){ return; },
        getByPath: async function(){ return []; },
        updateScriptJobName: async function(){ return; },
        getIncompleteJobsForSchedule: async function(){ return []; }
    };
    plugin.db = db; plugin.dbReady = Promise.resolve(db);
    plugin._dispatched = dispatched; plugin._dbCalls = dbCalls;
    return plugin;
}
(async function(){
let pass=0, fail=0;
function t(name, cond){ if(cond){pass++; console.log('  OK ' + name);} else {fail++; console.log('  FALHOU: ' + name);} }
function section(s){ console.log('\n=== ' + s + ' ==='); }

const adminConn = { user: { siteadmin: 0xFFFFFFFF, name:'admin', _id:'user//admin' }, send: function(m){}, dbNodeKey: 'node//a' };
const nonAdminConn = { user: { siteadmin: 2048, name:'peao', _id:'user//peao' }, send: function(m){} };
const agentConn = { user: null, dbNodeKey: 'node//agent1', send: function(m){ sentAgent = m; } };
var sentAgent = null;

section('guard');
var p = makePlugin();
t('admin pode chamar', p.guardServerAction({pluginaction:'addScript'}, adminConn) === true);
t('non-admin negado', p.guardServerAction({pluginaction:'addScript'}, nonAdminConn) === false);
t('agente: getScript ok', p.guardServerAction({pluginaction:'getScript', scriptId:'s1'}, agentConn) === true);
t('agente: jobComplete ok', p.guardServerAction({pluginaction:'jobComplete', jobId:'j1'}, agentConn) === true);
t('agente: jobComplete sem jobId negado', p.guardServerAction({pluginaction:'jobComplete'}, agentConn) === false);
t('agente: addScript NEGADO', p.guardServerAction({pluginaction:'addScript'}, agentConn) === false);
t('agente: clearAllPendingJobs ok', p.guardServerAction({pluginaction:'clearAllPendingJobs'}, agentConn) === true);
t('agente: runScript NEGADO', p.guardServerAction({pluginaction:'runScript'}, agentConn) === false);
t('agente: loadVariables NEGADO', p.guardServerAction({pluginaction:'loadVariables'}, agentConn) === false);

section('serveraction unificado (todas as ações no mesmo switch)');
var actions = ['loadAllSchedules','loadNodeHistory','previewTargets','addScheduledJob','runScript','runCommand','addScript','delete','new','newFolder','rename','moveScript','getScript','jobComplete','loadVariables'];
var missing = [];
for (const a of actions) {
    var p2 = makePlugin();
    var origSA = p2.serveraction;
    var handled = true;
    // capturar console 'unknown action'
    var logs = [];
    var oldLog = console.log; console.log = function(m){ logs.push(String(m)); };
    try { p2.serveraction({ pluginaction: a }, adminConn, null); } catch(e) { logs.push('EXC:'+e.message); }
    console.log = oldLog;
    var unknown = logs.filter(l => l.indexOf('unknown action') >= 0).length > 0;
    if (unknown) missing.push(a);
}
t('nenhuma ação cai no default (15 ações)', missing.length === 0);

section('determineNextJobTime — once mantido p/ histórico');
var p3 = makePlugin();
t('once nunca rodado → startAt', p3.determineNextJobTime({recur:'once', nextRun:null, startAt:100, endAt:null}) === 100);
t('once já rodado → -1 (mantém p/ histórico)', p3.determineNextJobTime({recur:'once', nextRun:100, startAt:100, endAt:null}) === -1);
t('endAt passado → -1', p3.determineNextJobTime({recur:'minutes', interval:5, nextRun:50, startAt:10, endAt:40}) === -1);
t('minutes avança', (() => { var now = Math.floor(Date.now()/1000); var r = p3.determineNextJobTime({recur:'minutes', interval:5, nextRun:now-600, startAt:now-1000, endAt:null}); return r >= now; })());

section('event delivery — action plugin');
var p4 = makePlugin();
await p4.updateFrontEnd({ tree: true });
await new Promise(r => setTimeout(r, 50));
t('newScriptTree dispatch com action plugin', p4._dispatched.length == 1 && p4._dispatched[0].action == 'plugin' && p4._dispatched[0].pluginaction == 'newScriptTree');
t('plugin field correto', p4._dispatched[0].plugin == 'scripttask');
await p4.updateFrontEnd({ variables: true });
await p4.updateFrontEnd({ allSchedules: true });
await new Promise(r => setTimeout(r, 80));
t('variableData dispatch', p4._dispatched.some(e => e.pluginaction == 'variableData'));
t('historyData (ALL) dispatch', p4._dispatched.some(e => e.pluginaction == 'historyData' && e.nodeId == 'ALL'));
t('nenhum dispatch com action:event', p4._dispatched.every(e => e.action == 'plugin'));

section('getDispatchTargets — só admins conectados');
var p5 = makePlugin();
p5.meshServer.webserver.wssessions = { 'user//admin': [{}], 'user//peao': [{}] };
p5.meshServer.webserver.users = { 'user//admin': { siteadmin: 0xFFFFFFFF }, 'user//peao': { siteadmin: 2048 } };
var targets = p5.getDispatchTargets();
t('targets: só admin id (sem * broadcast — S6)', targets.indexOf('*') < 0 && targets.indexOf('user//admin') >= 0 && targets.indexOf('user//peao') < 0);

console.log('\n' + pass + ' passaram, ' + fail + ' falharam'); process.exit(0);
})().catch(e => { console.error('ERRO FATAL:', e); process.exit(2); });

