
"use strict";
(async function(){
let pass=0, fail=0;
function t(name, cond){ if(cond){pass++; console.log('  OK ' + name);} else {fail++; console.log('  FALHOU: ' + name);} }
function makePlugin() {
    var dispatched = [];
    var meshServer = {
        debug: function(){},
        db: { GetAllTypeNoTypeField: function(type, domain, cb){ cb(null, []); } },
        webserver: { wsagents: {}, wssessions: {}, users: {}, meshes: {}, domains: [{id:''}] },
        connectivityByNode: {},
        DispatchEvent: function(ids, source, ev){ dispatched.push(ev); }
    };
    var mod = require('/opt/data/mct2/scripttask.js');
    var plugin = mod.scripttask({ parent: meshServer });
    var db = {
        inserted: [], schedules: [], jobs: [],
        addJobSchedule: async function(s){ this.schedules.push(s); return Object.assign({_id:'sch'+this.schedules.length}, s); },
        addJob: async function(o){ this.jobs.push(o); return Object.assign({_id:'j'+this.jobs.length}, o); },
        insert: async function(doc){ if (!doc._id) doc._id = 'eph' + (this.inserted.length + 1); this.inserted.push(doc); return doc; },
        getSchedulesDueForJob: async function(){ return this.schedules; },
        getIncompleteJobsForSchedule: async function(){ return []; },
        get: async function(id){ return [{_id:id, name:'x.sh', content:'echo', contentHash:'h'}]; },
        update: async function(id, args){ this.updateCalls = this.updateCalls || []; this.updateCalls.push({id: id, args: args}); return {updated:1}; },
        removeJobSchedule: async function(){ return; },
        getStaleJobs: async function(){ return []; },
        getPendingJobs: async function(){ return []; },
        getScriptTree: async function(){ return []; },
        getAllJobSchedules: async function(){ return this.schedules; },
        getJobScriptHistory: async function(){ return []; },
        getJobSchedulesForScript: async function(){ return []; },
        getJobNodeHistory: async function(){ return []; },
        getJobSchedulesForNode: async function(){ return []; },
        getVariables: async function(){ return []; },
        deleteOldHistory: async function(){ return; }
    };
    plugin.db = db; plugin.dbReady = Promise.resolve(db);
    plugin._dispatched = dispatched;
    return plugin;
}
const admin = { user: { siteadmin: 0xFFFFFFFF, name:'admin', _id:'user//admin' } };

// 1) addScheduledJob com command ad-hoc + filter dinâmico
var p = makePlugin();
p.serveraction({
  pluginaction: 'addScheduledJob',
  command: 'echo AGENDADO', commandType: 'bash',
  filter: 'os:linux',
  schedule: { recur:'minutes', interval:10, startAt: Math.floor(Date.now()/1000), endAt:null, dayVals:null }
}, admin, null);
await new Promise(r => setTimeout(r, 100));
t('schedule criado com filter', p.db.schedules.length == 1 && p.db.schedules[0].filter == 'os:linux');
t('schedule tem command', p.db.schedules[0].command == 'echo AGENDADO'.replace('AGENDADO','AGENDADO') && p.db.schedules[0].command.indexOf('echo') == 0);

// 2) createJobsForSchedule cria script efêmero + job (plugin isolado)
var p4 = makePlugin();
var sched = { _id: 'schX', command: 'echo AGENDADO', commandType: 'bash', scheduledBy: 'admin', nextRun: null, recur: 'minutes', interval: 10 };
var nextJobTime = Math.floor(Date.now()/1000);
await p4.createJobsForSchedule(sched, nextJobTime, ['node//a', 'node//b']);
await new Promise(r => setTimeout(r, 100));
t('script efêmero criado', p4.db.inserted.length == 1 && p4.db.inserted[0].ephemeral === true);
t('2 jobs criados (2 targets)', p4.db.jobs.length == 2);
t('jobs apontam pro efêmero', (() => { console.log('DBG inserted:', JSON.stringify(p4.db.inserted.map(d=>d._id)), 'jobs:', JSON.stringify(p4.db.jobs.map(j=>({scriptId: j.scriptId, _id: j._id})))); return p4.db.jobs.every(j => j.scriptId == p4.db.inserted[0]._id); })());
t('schedule nextRun avançado (db.update aplicado)', (() => { 
            var applied = sched; // update mock não aplica; verificar via updateCalls
            return p4.db.updateCalls && p4.db.updateCalls.some(c => c.id == 'schX' && c.args.nextRun == nextJobTime);
        })());

// 3) addScheduledJob por nodes (sem filter)
var p2 = makePlugin();
p2.serveraction({
  pluginaction: 'addScheduledJob',
  scriptId: 's1',
  nodes: ['node//a', 'node//b'],
  schedule: { recur:'daily', interval:1, startAt: Math.floor(Date.now()/1000), endAt:null }
}, admin, null);
await new Promise(r => setTimeout(r, 100));
t('2 schedules (um por node)', p2.db.schedules.length == 2 && p2.db.schedules.every(s => s.node && s.scriptId == 's1'));

// 4) filtro inválido rejeitado
var p3 = makePlugin();
p3.serveraction({ pluginaction: 'addScheduledJob', scriptId:'s1', filter: 'xyz:invalid', schedule: { recur:'once', startAt: 1 } }, admin, null);
await new Promise(r => setTimeout(r, 100));
t('filtro inválido → 0 schedules', p3.db.schedules.length == 0);

// 5) timeout de jobs: getStaleJobs com 180s
var p5 = makePlugin();
var nowS = Math.floor(Date.now()/1000);
var dbReal = require('/opt/data/mct2/db2.js');
// verificação da regra via SQL real é feita no test_db2; aqui só o parâmetro:
t('JOB_TIMEOUT_SEC = 180', p5.JOB_TIMEOUT_SEC === 180);

console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
if (fail > 0) process.exit(1); else process.exit(0);
})().catch(e => { console.error('ERRO FATAL:', e); process.exit(2); });
