/**
* @description MeshCentral ScriptTask (MeshTask Runner) — v1.0.1 clean rewrite
* @author Fernando Lima
* @license Apache-2.0
*
* v1.0.0 — rewritten from scratch. Architecture:
*   - ONE serveraction switch handles ALL pluginactions (WS + agent sessions).
*     No handleAdminReq for WS actions (it only serves HTTP views/download).
*   - SQLite persistence (db2.js), targeting engine (targeting.js).
*   - Admin-only guard: user sessions require siteadmin === 0xFFFFFFFF;
*     agent sessions (user == null) may only call getScript/jobComplete/clearAllPendingJobs.
*   - Job timeout: 3 minutes (getStaleJobs with 180s).
*   - once-schedules are kept for history (determineNextJobTime returns -1).
*   - ALL DispatchEvent use action:'plugin' (never 'event').
*   - Ad-hoc command scheduling: schedule with command/commandType creates an
*     ephemeral script at dispatch; deleted when its job completes.
*/

"use strict";

module.exports.scripttask = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.db = null;
    obj.intervalTimer = null;
    obj.debug = obj.meshServer.debug;
    obj.VIEWS = __dirname + '/views/';
    obj.db2Path = __dirname + '/db2.js';
    obj.targetingPath = __dirname + '/targeting.js';

    // Job timeout (seconds): dispatched or queued longer than this with no
    // completion => marked as timed out on the next queueRun cycle.
    obj.JOB_TIMEOUT_SEC = 180;
    // Never-dispatched jobs expire after this many seconds in the queue (7 days) —
    // they wait indefinitely for their agent to reconnect, but not forever.
    obj.QUEUE_EXPIRY_SEC = 7 * 86400;

    // Frontend hooks served via prepExports (browser-safe only — no obj./parent refs)
    obj.exports = [
        'onDeviceRefreshEnd',
        'resizeContent',
        'historyData',
        'variableData',
        'newScriptTree',
        'previewTargetsResult',
        'scheduleAdded',
        'goPageEnd'
    ];

    obj.consoleLog = function (msg) { console.log('PLUGIN: ScriptTask: ' + msg); };

    // =====================================================================
    // GUARD — admin-only for users; strict allowlist for agent sessions
    // =====================================================================
    obj.isAdminUser = function (user) {
        return user != null && user.siteadmin === 0xFFFFFFFF;
    };

    obj.AGENT_ALLOWED_ACTIONS = ['getScript', 'jobComplete', 'clearAllPendingJobs'];

    // Blocks plugin websocket actions. Agent connections have no `.user`
    // (meshagent.js builds the object without one) → user === null means agent.
    obj.guardServerAction = function (command, myparent) {
        var user = (myparent && myparent.user) ? myparent.user : null;
        if (user == null) {
            var act = command.pluginaction;
            if (obj.AGENT_ALLOWED_ACTIONS.indexOf(act) === -1) {
                obj.consoleLog('denied agent action "' + act + '" (agents may only call getScript/jobComplete/clearAllPendingJobs)');
                return false;
            }
            if (act === 'jobComplete' && (command.jobId == null || typeof command.jobId !== 'string' || command.jobId.length === 0)) {
                obj.consoleLog('denied agent jobComplete without jobId');
                return false;
            }
            return true;
        }
        if (!obj.isAdminUser(user)) {
            obj.consoleLog('denied action "' + command.pluginaction + '" for non-admin user ' + user._id);
            return false;
        }
        return true;
    };

    // S6: eventos do plugin são admin-only — o '*' (broadcast para todas as
    // sessões de usuário conectadas) vazava historyData/newScriptTree/
    // variableData a não-admins. Sem admins conectados → nada entregue.
    obj.getDispatchTargets = function () {
        var targets = [];
        try {
            var ws = obj.meshServer.webserver;
            if (ws && ws.wssessions) {
                for (var uid in ws.wssessions) {
                    var user = obj.meshServer.webserver.users[uid];
                    if (obj.isAdminUser(user)) { targets.push(uid); }
                }
            }
        } catch (ex) { }
        return targets;
    };

    // =====================================================================
    // STARTUP
    // =====================================================================
    obj.resetQueueTimer = function () {
        clearInterval(obj.intervalTimer);
        obj.intervalTimer = setInterval(obj.queueRun, 1 * 60 * 1000); // every minute
    };

    obj.server_startup = function () {
        var dbModule = require(obj.db2Path);
        obj.dbReady = Promise.resolve(dbModule.CreateDB(obj.meshServer)).then(function (created) {
            if (created && created.ready) return created.ready.then(function () { return created; });
            return created;
        });
        obj.dbReady.then(function (dbi) {
            obj.db = dbi;
            if (obj.meshServer.pluginHandler) obj.meshServer.pluginHandler.scripttask_db = dbi;
            obj.resetQueueTimer();
            obj.consoleLog('v1.0.0 persistence ready (SQLite: ' + (dbi.sqliteFile || 'legacy') + ')');
        }).catch(function (e) {
            obj.consoleLog('DB init FAILED: ' + e);
        });
    };

    // =====================================================================
    // FLEET SNAPSHOT / TARGETING (dynamic, resolved at dispatch time)
    // =====================================================================
    obj.getFleetSnapshot = function (cb) {
        var meshServer = obj.meshServer;
        var webserver = meshServer.webserver;
        var domain = '';
        try { domain = (webserver && webserver.domains && webserver.domains[0]) ? webserver.domains[0].id : ''; } catch (e) { }
        // Fleet from the CORE database (authoritative, all nodes of the domain) —
        // webserver.nodes only caches a subset and matched 0 devices in production.
        meshServer.db.GetAllTypeNoTypeField('node', domain, function (err, docs) {
            var nodes = (err || !docs) ? [] : docs.filter(function (n) { return n && n.meshid; });
            var meshes = (webserver && webserver.meshes) || {};
            var connectivity = {};
            var connByNode = meshServer.connectivityByNode || {};
            nodes.forEach(function (n) { connectivity[n._id] = connByNode[n._id] || 0; });
            cb({ nodes: nodes, meshes: meshes, connectivity: connectivity });
        });
    };

    obj.resolveFilterTargets = function (filterExpr, cb) {
        var TARGETING = require(obj.targetingPath);
        obj.getFleetSnapshot(function (snapshot) {
            var ids = TARGETING.matchNodes(snapshot.nodes, filterExpr, { meshes: snapshot.meshes, connectivity: snapshot.connectivity });
            cb(ids, TARGETING, snapshot);
        });
    };

    // =====================================================================
    // EVENT DELIVERY — all events use action:'plugin' (NEVER 'event')
    // =====================================================================
    obj.dispatch = function (targetIds, pluginaction, eventData) {
        var ev = Object.assign({
            nolog: true,
            action: 'plugin',
            plugin: 'scripttask',
            pluginaction: pluginaction
        }, eventData);
        obj.meshServer.DispatchEvent(targetIds, obj, ev);
    };

    // Push updated data to connected admin frontends.
    obj.updateFrontEnd = function (ids) {
        if (ids.scriptId != null) {
            obj.db.getJobScriptHistory(ids.scriptId)
                .then(function (scriptHistory) {
                    return obj.db.getJobSchedulesForScript(ids.scriptId).then(function (scriptSchedule) {
                        obj.dispatch(obj.getDispatchTargets(), 'historyData', {
                            scriptId: ids.scriptId, nodeId: null,
                            scriptHistory: scriptHistory, nodeHistory: null, scriptSchedule: scriptSchedule
                        });
                    });
                })
                .catch(function (e) { obj.consoleLog('updateFrontEnd(scriptId) error: ' + e); });
        }
        if (ids.nodeId != null) {
            obj.db.getJobNodeHistory(ids.nodeId)
                .then(function (nodeHistory) {
                    return obj.db.getJobSchedulesForNode(ids.nodeId).then(function (nodeSchedule) {
                        obj.dispatch(obj.getDispatchTargets(), 'historyData', {
                            scriptId: null, nodeId: ids.nodeId,
                            scriptHistory: null, nodeHistory: nodeHistory, nodeSchedule: nodeSchedule
                        });
                    });
                })
                .catch(function (e) { obj.consoleLog('updateFrontEnd(nodeId) error: ' + e); });
        }
        if (ids.tree === true) {
            obj.db.getScriptTree()
                .then(function (tree) {
                    obj.dispatch(obj.getDispatchTargets(), 'newScriptTree', { tree: tree });
                })
                .catch(function (e) { obj.consoleLog('updateFrontEnd(tree) error: ' + e); });
        }
        if (ids.variables === true) {
            obj.db.getVariables()
                .then(function (vars) {
                    obj.dispatch(obj.getDispatchTargets(), 'variableData', { vars: vars });
                })
                .catch(function (e) { obj.consoleLog('updateFrontEnd(variables) error: ' + e); });
        }
        if (ids.allSchedules === true) {
            obj.db.getAllJobSchedules()
                .then(function (allSchedules) {
                    obj.dispatch(obj.getDispatchTargets(), 'historyData', {
                        scriptId: null, nodeId: 'ALL',
                        scriptHistory: null, nodeHistory: null, nodeSchedule: allSchedules || []
                    });
                })
                .catch(function (e) { obj.consoleLog('updateFrontEnd(allSchedules) error: ' + e); });
        }
    };

    // =====================================================================
    // QUEUE RUN — dispatch pending jobs, timeout stale ones, advance schedules
    // =====================================================================
    // 1.0.1: dispatch pacing — send to at most MAX_DISPATCH_PER_RUN agents per
    //        cycle so a filter matching ~1000 nodes doesn't stampede the server
    //        and agents; leftovers queue for the next minute. Also re-check the
    //        agent connection right before sending (list may be seconds old) and
    //        leave the job pending if the agent dropped.
    obj.MAX_DISPATCH_PER_RUN = 250;
    obj.queueRun = async function () {
        if (obj.db == null) return; // db not ready yet
        var nowTime = Math.floor(Date.now() / 1000);
        var onlineAgents = Object.keys(obj.meshServer.webserver.wsagents);

        // 1) Timeout stale jobs:
        //    - dispatched >180s ago without completion → agent got the job, never answered;
        //    - never dispatched AND eligible (past dontQueueUntil) for >7 days → agent
        //      never came back; expire so the schedule isn't jammed forever.
        //    Future-dated jobs (dontQueueUntil in the future) are scheduled, not stale —
        //    db.getStaleJobs filters them out.
        try {
            var staleJobs = await obj.db.getStaleJobs(nowTime, obj.JOB_TIMEOUT_SEC, obj.QUEUE_EXPIRY_SEC);
            if (staleJobs && staleJobs.length > 0) {
                staleJobs.forEach(function (sj) {
                    var msg = (sj.dispatchTime != null)
                        ? 'Timeout: agent did not respond within ' + obj.JOB_TIMEOUT_SEC + ' seconds'
                        : 'Expirado: agente offline — job não despachado após ' + Math.round(obj.QUEUE_EXPIRY_SEC / 86400) + ' dias na fila';
                    obj.consoleLog('timing out stale job ' + sj._id +
                        ' (' + (sj.dispatchTime ? 'dispatched ' + (nowTime - sj.dispatchTime) + 's ago' : 'never dispatched, eligible since ' + Math.max(sj.queueTime || 0, sj.dontQueueUntil || 0)) + ')');
                    obj.db.update(sj._id, { completeTime: nowTime, errorVal: msg });
                });
            }
        } catch (e) { obj.consoleLog('stale cleanup error: ' + e); }

        // 2) Dispatch pending jobs to online agents (paced)
        try {
            var jobs = await obj.db.getPendingJobs(onlineAgents);
            if (jobs && jobs.length) {
                jobs.sort(function (a, b) { return (a.queueTime || 0) - (b.queueTime || 0); }); // FIFO by enqueue time
                jobs = jobs.slice(0, obj.MAX_DISPATCH_PER_RUN);
                for (var i in jobs) {
                    if (obj.meshServer.webserver.wsagents[jobs[i].node] == null) continue; // agent left — stays pending
                    try { await obj.dispatchJob(jobs[i]); } catch (e) { obj.consoleLog('Could not dispatch job: ' + e); }
                }
            }
        } catch (e) { obj.consoleLog('pending jobs error: ' + e); }

        // 3) Create jobs from due schedules + occasional history cleanup
        try {
            await obj.makeJobsFromSchedules();
        } catch (e) { obj.consoleLog('makeJobsFromSchedules error: ' + e); }
        obj.cleanHistory();
    };

    obj.dispatchJob = async function (job) {
        var scripts = await obj.db.get(job.scriptId);
        if (!scripts || !scripts.length) {
            // Script deleted — drop the orphan job instead of crashing every cycle.
            obj.consoleLog('dropping orphan job ' + job._id + ' (script ' + job.scriptId + ' no longer exists)');
            return obj.db.delete(job._id);
        }
        var script = scripts[0];

        // Variable substitution: #name# occurrences resolved at dispatch time
        var replaceVars = {};
        var foundVars = script.content.match(/#(.*?)#/g);
        if (foundVars != null && foundVars.length > 0) {
            var foundVarNames = foundVars.map(function (fv) { return fv.replace(/^#+|#+$/g, ''); });
            var agentConn = obj.meshServer.webserver.wsagents[job.node];
            var limiters = {
                scriptId: job.scriptId,
                nodeId: job.node,
                meshId: agentConn ? agentConn['dbMeshKey'] : null,
                names: foundVarNames
            };
            var finvals = await obj.db.getVariables(limiters);
            var ordering = { 'global': 0, 'script': 1, 'mesh': 2, 'node': 3 };
            finvals.sort(function (a, b) { return (ordering[a.scope] - ordering[b.scope]) || a.name.localeCompare(b.name); });
            finvals.forEach(function (fv) { replaceVars[fv.name] = fv.value; });
            if (agentConn) replaceVars['GBL:meshId'] = agentConn['dbMeshKey'];
            replaceVars['GBL:nodeId'] = job.node;
            replaceVars['GBL:runBy'] = job.runBy || 'unknown';
        }

        var dispatchTime = Math.floor(Date.now() / 1000);
        var jObj = {
            action: 'plugin',
            plugin: 'scripttask',
            pluginaction: 'triggerJob',
            jobId: job._id,
            scriptId: job.scriptId,
            replaceVars: replaceVars,
            scriptHash: script.contentHash,
            dispatchTime: dispatchTime
        };
        try {
            obj.meshServer.webserver.wsagents[job.node].send(JSON.stringify(jObj));
            await obj.db.update(job._id, { dispatchTime: dispatchTime });
        } catch (e) { }
    };

    obj.cleanHistory = function () {
        if (Math.round(Math.random() * 100) != 99) return;
        // S11: GC de scripts efêmeros órfãos — clearAllPendingJobs/deleção de
        // schedules/timeout de stale APAGAVAM os jobs mas não os efêmeros
        // (invisíveis na UI, acumulavam no banco para sempre).
        obj.db.deleteOldHistory().catch(function (e) { obj.consoleLog('deleteOldHistory error: ' + e); });
        if (obj.db.deleteOrphanEphemeralScripts) {
            obj.db.deleteOrphanEphemeralScripts(3600).then(function (n) {
                if (n && n > 0) obj.consoleLog('GC: ' + n + ' ephemeral script(s) órfão(s) removido(s)');
            }).catch(function (e) { obj.consoleLog('ephemeral GC error: ' + e); });
        }
    };

    // =====================================================================
    // SCHEDULES → JOBS
    // =====================================================================
    // Returns the next run time for a schedule:
    //   -1        → schedule finished (once already executed; kept for history)
    //   null      → schedule is done / invalid (removed from db)
    //   number    → unix seconds of the next run
    obj.determineNextJobTime = function (s) {
        var nextTime = null;
        var nowTime = Math.floor(Date.now() / 1000);

        if (s.endAt !== null && s.endAt <= nowTime) { return -1; }

        switch (s.recur) {
            case 'once':
                if (s.nextRun == null) nextTime = s.startAt;
                else nextTime = -1; // keep the schedule in the db for history
                break;
            case 'minutes':
            case 'hourly':
            case 'daily': {
                var mult = (s.recur == 'minutes') ? 60 : (s.recur == 'hourly') ? 3600 : 86400;
                // Guard: interval inválido (0, negativo ou ausente → NaN) trava o
                // servidor em loop infinito / re-agenda o job a cada tick. Um
                // schedule assim é inválido: tratado como done (removido).
                if (!(s.interval > 0)) {
                    obj.consoleLog('schedule ' + s._id + ' tem interval inválido (' + s.interval + ') — ignorado');
                    nextTime = null;
                    break;
                }
                if (s.nextRun == null) { nextTime = s.startAt; break; }
                nextTime = s.nextRun + (s.interval * mult);
                while (nextTime < nowTime) { nextTime = nextTime + (s.interval * mult); }
                if (s.startAt > nextTime) nextTime = s.startAt;
                break;
            }
            case 'weekly': {
                if (s.daysOfWeek == null || s.daysOfWeek.length == 0) { nextTime = null; break; }
                var tempDate = new Date();
                var nowDate = new Date(tempDate.getFullYear(), tempDate.getMonth(), tempDate.getDate());
                s.daysOfWeek = s.daysOfWeek.map(function (el) { return Number(el); });
                var baseTime = s.startAt;
                var lastDayOfWeek = Math.max(...s.daysOfWeek);
                if (s.nextRun != null) {
                    // S8: nextRun >7 dias no passado (agent offline + job expirado)
                    // deixava a janela de 8 dias sem nenhum matching → schedule
                    // deletado silenciosamente; re-ancora a busca no presente.
                    if (s.nextRun < nowTime - 604800) baseTime = nowTime;
                    else baseTime = s.nextRun;
                    if (nowDate.getDay() == lastDayOfWeek) { baseTime = baseTime + (s.interval * 604800) - (lastDayOfWeek * 86400); }
                } else if (s.startAt < nowTime) {
                    baseTime = Math.floor(nowDate.getTime() / 1000);
                }
                var dm = null;
                for (var x = 0; x <= 7; x++) {
                    var checkDate = baseTime + (86400 * x);
                    var d = new Date(0); d.setUTCSeconds(checkDate);
                    var dm2 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                    if (s.nextRun == null && s.daysOfWeek.indexOf(dm2.getDay()) !== -1 && dm2.getTime() >= nowDate.getTime()) { dm = dm2; break; }
                    if (s.nextRun != null && s.daysOfWeek.indexOf(dm2.getDay()) !== -1 && dm2.getTime() > nowDate.getTime()) { dm = dm2; break; }
                }
                if (dm == null) { nextTime = null; break; }
                // S9: recompor a HORA LOCAL do startAt no dia alvo (antes era
                // diff em segundos absolutos → deriva ±1h após transição DST).
                var sa = new Date(0); sa.setUTCSeconds(s.startAt);
                nextTime = Math.floor(new Date(dm.getFullYear(), dm.getMonth(), dm.getDate(), sa.getHours(), sa.getMinutes(), sa.getSeconds()).getTime() / 1000);
                break;
            }
            default:
                nextTime = null;
                break;
        }

        if (s.endAt != null && (nextTime === null || nextTime > s.endAt) && nextTime !== -1) nextTime = null;
        return nextTime;
    };

    obj.makeJobsFromSchedules = function (scheduleId) {
        return obj.db.getSchedulesDueForJob(scheduleId)
            .then(function (schedules) {
                if (!schedules || !schedules.length) return Promise.resolve();
                var direct = [], filtered = [];
                schedules.forEach(function (s) {
                    if (s.filter != null && s.filter !== '') filtered.push(s);
                    else direct.push(s);
                });
                // ONE fleet snapshot per cycle for all filter-based schedules
                var snapshotP = filtered.length
                    ? new Promise(function (resolve) { obj.getFleetSnapshot(function (snap) { resolve(snap); }); })
                    : Promise.resolve(null);
                return snapshotP.then(function (snapshot) {
                    var TARGETING = filtered.length ? require(obj.targetingPath) : null;
                    var tasks = [];
                    schedules.forEach(function (s) {
                        var nextJobTime = obj.determineNextJobTime(s);
                        if (nextJobTime === null) {
                            obj.db.removeJobSchedule(s._id);
                            return;
                        }
                        if (nextJobTime === -1) {
                            // once-schedule already executed (or past endAt) — kept for history
                            return;
                        }
                        var targetNodes = null;
                        // 1.0.1: ONLY filter-based schedules resolve targets from the snapshot.
                        // The snapshot is shared per-cycle (any filtered schedule makes it
                        // non-null); passing a direct schedule's null filter to matchNodes
                        // parses to null → matched EVERY node (1147 jobs from a 1-node
                        // schedule in prod E2E). Direct schedules must keep targetNodes
                        // null so addScheduleJobs uses s.node.
                        if (snapshot != null && s.filter != null && s.filter !== '') {
                            var ids = TARGETING.matchNodes(snapshot.nodes, s.filter, { meshes: snapshot.meshes, connectivity: snapshot.connectivity });
                            if (!ids.length) obj.consoleLog('filter schedule "' + s._id + '" matched 0 devices for filter: ' + s.filter);
                            targetNodes = ids;
                        }
                        tasks.push(obj.createJobsForSchedule(s, nextJobTime, targetNodes));
                    });
                    return Promise.all(tasks);
                });
            });
    };

    obj.createJobsForSchedule = function (s, nextJobTime, targetNodes) {
        // Ad-hoc command schedule: create an ephemeral script at dispatch time.
        if (s.command) {
            return obj.createEphemeralScript(s.command, s.commandType, s.scheduledBy)
                .then(function (ephId) {
                    return obj.addScheduleJobs(s, ephId, '⚡ ' + s.command.substring(0, 30), nextJobTime, targetNodes);
                })
                .catch(function (e) { obj.consoleLog('Error creating ad-hoc schedule jobs: ' + e); });
        }
        // Normal script-based schedule
        return obj.db.get(s.scriptId)
            .then(function (scripts) {
                if (!scripts || !scripts.length) return Promise.resolve();
                return obj.addScheduleJobs(s, s.scriptId, scripts[0].name, nextJobTime, targetNodes);
            })
            .catch(function (e) { obj.consoleLog('Error creating jobs for schedule: ' + e); });
    };

    // Shared job-creation path for both command and script schedules
    obj.addScheduleJobs = function (s, scriptId, scriptName, nextJobTime, targetNodes) {
        return obj.db.getIncompleteJobsForSchedule(s._id)
            .then(function (jobs) {
                if (jobs && jobs.length > 0) return Promise.resolve(); // previous run still pending
                var proms = [];
                if (targetNodes != null) {
                    if (targetNodes.length == 0) return Promise.resolve();
                    targetNodes.forEach(function (nid) {
                        proms.push(obj.db.addJob({ scriptId: scriptId, scriptName: scriptName, node: nid, runBy: s.scheduledBy, dontQueueUntil: nextJobTime, jobSchedule: s._id }));
                    });
                    return Promise.all(proms).then(function () { return obj.db.update(s._id, { nextRun: nextJobTime }); });
                }
                proms.push(obj.db.addJob({ scriptId: scriptId, scriptName: scriptName, node: s.node, runBy: s.scheduledBy, dontQueueUntil: nextJobTime, jobSchedule: s._id }));
                return Promise.all(proms).then(function () { return obj.db.update(s._id, { nextRun: nextJobTime }); });
            });
    };

    // Ephemeral script for ad-hoc command schedules/runs — deleted when its job completes
    obj.createEphemeralScript = function (command, commandType, runBy) {
        var content = command;
        var name = '⚡ ' + command.substring(0, 40).replace(/\n/g, ' ');
        var doc = {
            type: 'script',
            name: name,
            path: 'Shared',
            content: content,
            contentHash: require('crypto').createHash('sha384').update(content).digest('hex'),
            filetype: commandType,
            ephemeral: true,
            runBy: runBy,
            created: Math.floor(Date.now() / 1000)
        };
        return obj.db.insert(doc).then(function (s) { return s._id; });
    };

    // =====================================================================
    // SERVER ACTION — the ONE WS handler for ALL pluginactions
    // (user sessions AND agent sessions route here: meshuser.js L4912,
    //  meshagent.js L1565 → serveraction(command, obj, parent))
    // =====================================================================
    obj.serveraction = function (command, myparent, grandparent) {
        // S10: db não pronto (startup lento / falha do dbReady) → nada a fazer;
        // antes, o handler quebrava com TypeError no primeiro uso de obj.db.
        if (obj.db == null) return;
        if (obj.guardServerAction(command, myparent) === false) return;
        var user = (myparent && myparent.user) ? myparent.user : null;

        switch (command.pluginaction) {

            // ---------- agent-originated ----------
            case 'getScript': {
                obj.db.get(command.scriptId)
                    .then(function (script) {
                        if (!script || !script.length) {
                            obj.consoleLog('getScript EMPTY for ' + command.scriptId);
                            return;
                        }
                        myparent.send(JSON.stringify({
                            action: 'plugin',
                            plugin: 'scripttask',
                            pluginaction: 'cacheScript',
                            nodeid: myparent.dbNodeKey,
                            rights: true,
                            sessionid: true,
                            script: script[0]
                        }));
                    })
                    .catch(function (e) { obj.consoleLog('getScript error: ' + e); });
                break;
            }

            case 'jobComplete': {
                var jobId = command.jobId, retVal = command.retVal, errVal = command.errVal, dispatchTime = command.dispatchTime;
                var completeTime = Math.floor(Date.now() / 1000);
                // A15: validação da posse e dos tipos — o agente só pode concluir
                // job do PRÓPRIO nó, e dispatchTime precisa ser numérico.
                if (typeof jobId != 'string' || jobId == null) break;
                obj.db.get(jobId)
                    .then(function (jobs) {
                        // A15: job inexistente ou já concluído (ex.: timeout do servidor)
                        // → nada a fazer; um jobComplete tardio NUNCA sobrescreve o timeout.
                        if (!jobs || !jobs.length || jobs[0].completeTime != null) return null;
                        // A15: posse — apenas o próprio nó pode concluir o job
                        if (jobs[0].node != myparent.dbNodeKey) {
                            obj.consoleLog('jobComplete NEGADO: job ' + jobId + ' pertence a ' + jobs[0].node + ', não a ' + myparent.dbNodeKey);
                            return null;
                        }
                        var upd = { completeTime: completeTime, returnVal: retVal, errorVal: errVal };
                        if (typeof dispatchTime == 'number' && dispatchTime > 0) upd.dispatchTime = dispatchTime; // sanitizado
                        return obj.db.update(jobId, upd);
                    })
                    .then(function (updated) {
                        if (!updated || !updated.updated) return null;
                        return obj.db.get(jobId).then(function (jobs) {
                            // S1: cleanup do efêmero — apagar APENAS quando nenhum
                            // outro job do mesmo script estiver pendente (antes, o
                            // 1º jobComplete apagava o script e os demais targets
                            // perdiam a execução como orfãos).
                            var cleanup = Promise.resolve();
                            if (jobs[0] && jobs[0].scriptId) {
                                var scriptId = jobs[0].scriptId;
                                cleanup = obj.db.get(scriptId).then(function (scripts) {
                                    if (!scripts[0] || scripts[0].ephemeral !== true) return Promise.resolve();
                                    return obj.db.countPendingJobsForScript(scriptId, jobId).then(function (n) {
                                        if (n == 0) return obj.db.delete(scripts[0]._id);
                                        obj.consoleLog('ephemeral script ' + scriptId + ' mantido: ' + n + ' job(s) pendente(s)');
                                    });
                                }).catch(function () { });
                            }
                            return cleanup.then(function () { return (jobs[0] ? jobs[0].jobSchedule : null); });
                        });
                    })
                    .then(function (sId) {
                        if (sId == null) return;
                        return obj.db.update(sId, { lastRun: completeTime })
                            .then(function () { return obj.makeJobsFromSchedules(sId); });
                    })
                    .then(function () {
                        obj.updateFrontEnd({ scriptId: command.scriptId, nodeId: myparent.dbNodeKey });
                    })
                    .catch(function (e) { obj.consoleLog('Failed to complete job: ' + e); });
                break;
            }

            case 'clearAllPendingJobs': {
                obj.db.deletePendingJobsForNode(myparent.dbNodeKey);
                break;
            }

            // ---------- scripts / tree ----------
            case 'addScript': {
                obj.db.addScript(command.name, command.content, command.path, command.filetype)
                    .then(function () { obj.updateFrontEnd({ tree: true }); })
                    .catch(function (e) { obj.consoleLog('addScript error: ' + e); });
                break;
            }

            case 'new': {
                obj.db.get(command.parent_id)
                    .then(function (found) {
                        var parentPath = (found && found.length > 0) ? found[0].path : 'Shared';
                        return obj.db.addScript(command.name, '', parentPath, command.filetype);
                    })
                    .then(function () { obj.updateFrontEnd({ tree: true }); })
                    .catch(function (e) { obj.consoleLog('new script error: ' + e); });
                break;
            }

            case 'newFolder': {
                obj.db.get(command.parent_id)
                    .then(function (found) {
                        var parentPath = (found && found.length > 0) ? found[0].path : 'Shared';
                        return obj.db.addFolder(command.name, parentPath + '/' + command.name);
                    })
                    .then(function () { obj.updateFrontEnd({ tree: true }); })
                    .catch(function (e) { obj.consoleLog('newFolder error: ' + e); });
                break;
            }

            case 'rename': {
                obj.db.get(command.id)
                    .then(function (docs) {
                        var doc = docs[0];
                        if (doc.type == 'folder') {
                            var oldPath = doc.path;
                            var newPath = oldPath.substring(0, oldPath.length - doc.name.length) + command.name;
                            return obj.db.update(command.id, { path: newPath })
                                .then(function () { return obj.db.getByPath(oldPath); })
                                .then(function (found) {
                                    if (found && found.length > 0) {
                                        return Promise.all(found.map(function (f) {
                                            return obj.db.update(f._id, { path: newPath + f.path.substring(oldPath.length) });
                                        }));
                                    }
                                });
                        }
                        return Promise.resolve();
                    })
                    .then(function () { return obj.db.update(command.id, { name: command.name }); })
                    .then(function () { return obj.db.updateScriptJobName(command.id, command.name); })
                    .then(function () { obj.updateFrontEnd({ scriptId: command.id, nodeId: command.currentNodeId, tree: true }); })
                    .catch(function (e) { obj.consoleLog('rename error: ' + e); });
                break;
            }

            case 'moveScript': {
                var toPath = null, fromPath = null;
                obj.db.get(command.to)
                    .then(function (found) {
                        if (found.length == 0) throw Error('Target destination not found');
                        toPath = found[0].path;
                        return obj.db.get(command.id);
                    })
                    .then(function (found) {
                        var file = found[0];
                        if (file.type == 'folder') {
                            fromPath = file.path;
                            toPath = toPath + '/' + file.name;
                            if (file.name == 'Shared' && file.path == 'Shared') throw Error('Cannot move top level directory: Shared');
                        }
                        return obj.db.update(command.id, { path: toPath });
                    })
                    .then(function () { return obj.db.getByPath(fromPath); })
                    .then(function (found) {
                        if (found && found.length > 0) {
                            return Promise.all(found.map(function (f) { return obj.db.update(f._id, { path: toPath + f.path.substring(fromPath.length) }); }));
                        }
                    })
                    .then(function () { obj.updateFrontEnd({ tree: true }); })
                    .catch(function (e) { obj.consoleLog('moveScript error: ' + e); });
                break;
            }

            case 'delete': {
                obj.deleteElement(command);
                break;
            }

            case 'getScriptTree': {
                obj.updateFrontEnd({ tree: true });
                break;
            }

            // ---------- history / schedules / variables loading ----------
            case 'loadAllSchedules': {
                obj.updateFrontEnd({ allSchedules: true });
                break;
            }

            case 'loadNodeHistory': {
                obj.updateFrontEnd({ nodeId: command.nodeId });
                break;
            }

            case 'loadScriptHistory': {
                obj.updateFrontEnd({ scriptId: command.scriptId });
                break;
            }

            case 'loadVariables': {
                obj.updateFrontEnd({ variables: true });
                break;
            }

            case 'previewTargets': {
                var TARGETINGP = require(obj.targetingPath);
                var vres = TARGETINGP.validate(String(command.filter || ''));
                if (!vres.ok) {
                    obj.dispatch([user._id], 'previewTargetsResult', { reqId: command.reqId, error: vres.error });
                    break;
                }
                obj.resolveFilterTargets(command.filter, function (ids, TARGETING2, snapshot) {
                    var byId = {};
                    snapshot.nodes.forEach(function (n) { byId[n._id] = n; });
                    var preview = ids.map(function (nid) {
                        var n = byId[nid];
                        return {
                            nodeid: nid,
                            name: n ? n.name : nid,
                            group: (snapshot.meshes[n.meshid] || {}).name || '',
                            osdesc: n ? (n.osdesc || '') : '',
                            online: ((obj.meshServer.connectivityByNode[nid] || 0) & 1) != 0
                        };
                    });
                    obj.dispatch([user._id], 'previewTargetsResult', {
                        reqId: command.reqId, // U3: eco do id do pedido (anti-race)
                        filter: command.filter,
                        describe: TARGETING2.describe(command.filter),
                        targets: preview
                    });
                });
                break;
            }

            // ---------- run ----------
            case 'runScript': {
                var sel = command.nodes;
                var proms = [];
                if (Array.isArray(sel)) {
                    sel.forEach(function (s) { proms.push(obj.db.addJob({ scriptId: command.scriptId, node: s, runBy: user.name })); });
                } else {
                    proms.push(obj.db.addJob({ scriptId: command.scriptId, node: sel, runBy: user.name }));
                }
                Promise.all(proms)
                    .then(function () { return obj.db.get(command.scriptId); })
                    .then(function (scripts) {
                        if (scripts && scripts.length) return obj.db.updateScriptJobName(command.scriptId, scripts[0].name);
                    })
                    .then(function () {
                        obj.resetQueueTimer();
                        obj.queueRun();
                        obj.updateFrontEnd({ scriptId: command.scriptId, nodeId: command.currentNodeId });
                    })
                    .catch(function (e) { obj.consoleLog('runScript error: ' + e); });
                break;
            }

            case 'runCommand': {
                // Ad-hoc command execution without storing a script in the tree.
                // Creates an ephemeral script doc, queues jobs; the script is deleted
                // automatically when its job completes (jobComplete sees the flag).
                // 0.1.12: accepts filter (resolves targets dynamically) in addition to nodes.
                var cmdContent = String(command.cmd || '');
                var cmdType = String(command.filetype || 'bash');
                var cmdNodes = command.nodes;
                var cmdFilter = (command.filter != null && typeof command.filter == 'string' && command.filter.trim() != '') ? command.filter.trim() : null;
                if (!cmdContent.trim()) break;
                // S7: filtro precisa passar no validate — parse nulo em matchNodes
                // devolve a FROTA INTEIRA; runCommand era o único caminho sem validação.
                if (cmdFilter != null) {
                    var TARGETING_RC = require(obj.targetingPath);
                    var vres = TARGETING_RC.validate(cmdFilter);
                    if (!vres.ok) { obj.consoleLog('runCommand: invalid filter rejected: ' + vres.error); break; }
                }
                if (cmdType == 'bash') cmdContent = cmdContent.split('\r\n').join('\n');
                obj.db.addScript('cmd-' + Math.floor(Date.now() / 1000) + '.' + cmdType, cmdContent, 'Shared', cmdType)
                    .then(function (created) { return obj.db.update(created._id, { ephemeral: true }).then(function () { return created; }); })
                    .then(function (s) {
                        if (cmdFilter) {
                            // Resolve filter to target nodes dynamically
                            obj.resolveFilterTargets(cmdFilter, function (ids) {
                                if (!ids.length) { obj.consoleLog('runCommand filter matched 0 devices: ' + cmdFilter); return; }
                                var proms = ids.map(function (nid) { return obj.db.addJob({ scriptId: s._id, node: nid, runBy: user.name }); });
                                Promise.all(proms).then(function () { return obj.db.updateScriptJobName(s._id, s.name); })
                                    .then(function () { obj.resetQueueTimer(); obj.queueRun(); })
                                    .catch(function (e) { obj.consoleLog('runCommand filter error: ' + e); });
                            });
                        } else {
                            var nodes = Array.isArray(cmdNodes) ? cmdNodes : [cmdNodes];
                            var proms = nodes.map(function (n) { return obj.db.addJob({ scriptId: s._id, node: n, runBy: user.name }); });
                            return Promise.all(proms).then(function () { return obj.db.updateScriptJobName(s._id, s.name); });
                        }
                    })
                    .then(function () { if (!cmdFilter) { obj.resetQueueTimer(); obj.queueRun(); } })
                    .catch(function (e) { obj.consoleLog('runCommand error: ' + e); });
                break;
            }

            // ---------- edit ----------
            case 'editScript': {
                obj.db.update(command.scriptId, { filetype: command.scriptType, name: command.scriptName, content: command.scriptContent })
                    .then(function () { obj.updateFrontEnd({ scriptId: command.scriptId, tree: true }); })
                    .catch(function (e) { obj.consoleLog('editScript error: ' + e); });
                break;
            }

            // ---------- variables ----------
            case 'newVar': {
                obj.db.addVariable(command.name, command.scope, command.scopeTarget, command.value)
                    .then(function () { obj.updateFrontEnd({ variables: true }); })
                    .catch(function (e) { obj.consoleLog('newVar error: ' + e); });
                break;
            }

            case 'editVar': {
                obj.db.update(command.id, { name: command.name, scope: command.scope, scopeTarget: command.scopeTarget, value: command.value })
                    .then(function () { obj.updateFrontEnd({ variables: true }); })
                    .catch(function (e) { obj.consoleLog('editVar error: ' + e); });
                break;
            }

            case 'deleteVar': {
                obj.db.delete(command.id)
                    .then(function () { obj.updateFrontEnd({ variables: true }); })
                    .catch(function (e) { obj.consoleLog('deleteVar error: ' + e); });
                break;
            }

            // ---------- scheduling ----------
            case 'addScheduledJob': {
                obj.addScheduledJob(command, user);
                break;
            }

            default:
                obj.consoleLog('unknown action "' + command.pluginaction + '"');
                break;
        }
    };

    // =====================================================================
    // addScheduledJob — script schedule or ad-hoc command schedule (command +
    // commandType, no scriptId). One schedule per selected node, or ONE
    // schedule with a dynamic filter (re-evaluated at each dispatch).
    // =====================================================================
    obj.addScheduledJob = function (command, user) {
        var sj = command.schedule;
        // Validar interval ANTES de criar o schedule (S3): interval 0/negativo/
        // ausente trava o scheduler em loop infinito ou re-agenda a cada tick.
        var iv = parseInt(sj.interval, 10);
        if (sj.recur != 'once' && sj.recur != 'weekly' && !(iv >= 1)) {
            obj.consoleLog('addScheduledJob rejected: invalid interval (' + sj.interval + ')');
            return;
        }
        var hasCommand = (command.command != null && typeof command.command == 'string' && command.command.trim() != '');
        var base = {
            scriptId: hasCommand ? null : command.scriptId,
            command: hasCommand ? command.command.trim() : null,
            commandType: hasCommand ? (command.commandType || 'bash') : null,
            node: null,
            scheduledBy: user.name,
            recur: sj.recur,
            interval: isNaN(iv) ? sj.interval : iv,
            daysOfWeek: sj.dayVals,
            startAt: sj.startAt,
            endAt: sj.endAt,
            lastRun: null,
            nextRun: null,
            type: 'jobSchedule'
        };
        var proms = [];
        if (command.filter != null && typeof command.filter == 'string' && command.filter.trim() != '') {
            var TARGETING = require(obj.targetingPath);
            var vres = TARGETING.validate(command.filter);
            if (!vres.ok) { obj.consoleLog('invalid filter rejected: ' + vres.error); return; }
            var schedF = Object.assign({}, base, { filter: command.filter.trim() });
            proms.push(obj.db.addJobSchedule(schedF));
        } else if (Array.isArray(command.nodes)) {
            command.nodes.forEach(function (n) {
                proms.push(obj.db.addJobSchedule(Object.assign({}, base, { node: n })));
            });
        } else {
            proms.push(obj.db.addJobSchedule(base));
        }
        Promise.all(proms)
            .then(function () {
                obj.makeJobsFromSchedules();
                obj.updateFrontEnd({ allSchedules: true });
            })
            .catch(function (e) { obj.consoleLog('Error adding schedules: ' + e); });
    };

    // =====================================================================
    // DELETE (script / folder / jobSchedule)
    // =====================================================================
    obj.deleteElement = function (command) {
        var delObj = null;
        obj.db.get(command.id)
            .then(function (found) {
                if (!found || !found.length) throw Error('not found: ' + command.id);
                delObj = Object.assign({}, found[0]);
                var file = found[0];
                if (file.type == 'folder') return obj.db.deleteByPath(file.path);
                if (file.type == 'script') return obj.db.deleteSchedulesForScript(file._id);
                if (file.type == 'jobSchedule') return obj.db.deletePendingJobsForSchedule(file._id);
                return Promise.resolve();
            })
            .then(function () { return obj.db.delete(command.id); })
            .then(function () {
                var updateObj = { tree: true };
                if (delObj.type == 'jobSchedule') { updateObj.allSchedules = true; }
                return obj.updateFrontEnd(updateObj);
            })
            .catch(function (e) { obj.consoleLog('Error deleting: ' + (e.stack || e)); });
    };

    // =====================================================================
    // HTTP (pluginadmin.ashx) — view rendering + script download ONLY.
    // NO pluginactions here (all WS actions live in serveraction).
    // =====================================================================
    obj.downloadFile = function (req, res) {
        obj.db.get(req.query.dl)
            .then(function (found) {
                if (!found || found.length != 1) { res.sendStatus(401); return; }
                var file = found[0];
                res.setHeader('Content-disposition', 'attachment; filename=' + encodeURIComponent(file.name));
                res.setHeader('Content-type', 'text/plain');
                res.send(file.content);
            })
            .catch(function () { res.sendStatus(500); });
    };

    obj.handleAdminReq = function (req, res, user) {
        if (req.query.admin == 1) {
            // admin panel view not used (hasAdminPanel false) — deny to non-admins anyway
            if (!obj.isAdminUser(user)) { res.sendStatus(401); return; }
            res.render(obj.VIEWS + 'admin', {});
            return;
        }
        if (req.query.user == 1) {
            if (!obj.isAdminUser(user)) { res.sendStatus(401); return; }
            if (req.query.dl != null) return obj.downloadFile(req, res);
            var vars = { scriptTree: 'null' };
            obj.db.getScriptTree()
                .then(function (tree) {
                    // U1: escape para contexto <script> — nome com "</script>" não
                    // pode fechar a tag cedo (XSS armazenado); \u2028/29 quebram JS.
                    vars.scriptTree = JSON.stringify(tree)
                        .replace(/</g, '\\u003c')
                        .replace(/\u2028/g, '\\u2028')
                        .replace(/\u2029/g, '\\u2029');
                    res.render(obj.VIEWS + 'user', vars);
                })
                .catch(function () { res.sendStatus(500); });
            return;
        }
        res.sendStatus(401);
    };

    // =====================================================================
    // FRONTEND HOOKS (executed in the browser via prepExports)
    // =====================================================================

    // Device page: register the ScriptTask tab — full site admins only.
    obj.onDeviceRefreshEnd = function () {
        if (!userinfo || userinfo.siteadmin !== 0xFFFFFFFF) return;
        pluginHandler.registerPluginTab({ tabTitle: 'ScriptTask', tabId: 'pluginScriptTask' });
        QA('pluginScriptTask', '<iframe id="pluginIframeScriptTask" style="width: 100%; height: 700px; overflow: auto" scrolling="yes" frameBorder=0 src="/pluginadmin.ashx?pin=scripttask&user=1" />');
    };

    obj.resizeContent = function () {
        var iFrame = document.getElementById('pluginIframeScriptTask');
        if (iFrame) iFrame.style.height = '700px';
    };

    // Frontend event relays — the MeshCentral UI calls these on the
    // pluginHandler (default.handlebars: pluginHandler[plugin][pluginaction]).
    obj.historyData = function (message) {
        if (typeof pluginHandler.scripttask.loadHistory == 'function') pluginHandler.scripttask.loadHistory(message);
        if (typeof pluginHandler.scripttask.loadSchedule == 'function') pluginHandler.scripttask.loadSchedule(message);
    };

    obj.variableData = function (message) {
        if (typeof pluginHandler.scripttask.loadVariables == 'function') pluginHandler.scripttask.loadVariables(message);
    };

    obj.newScriptTree = function (message) {
        if (typeof pluginHandler.scripttask.newScriptTree == 'function') pluginHandler.scripttask.newScriptTree(message);
    };

    obj.scheduleAdded = function (message) {
        if (typeof pluginHandler.scripttask.scheduleAdded == 'function') pluginHandler.scripttask.scheduleAdded(message);
    };

    obj.previewTargetsResult = function (message) {
        if (typeof pluginHandler.scripttask.previewTargetsResult == 'function') pluginHandler.scripttask.previewTargetsResult(message);
    };

    // 1.0.0: global entry point — injects an "Open MeshTask Runner" button on
    // the My Server → Plugins page (p42) via the goPageEnd hook. Browser-safe:
    // prepExports copies toString() to the front, so no obj./parent references.
    obj.goPageEnd = function (view, event) {
        try {
            if (view != 42) return;
            var p42 = document.getElementById('p42');
            if (!p42 || document.getElementById('mtrunopen')) return;
            var btn = document.createElement('input');
            btn.id = 'mtrunopen';
            btn.type = 'button';
            btn.value = '⚡ Abrir MeshTask Runner';
            btn.style.cssText = 'margin:8px 0; padding:5px 14px; cursor:pointer; font-weight:bold;';
            btn.onclick = function () {
                var ov = document.getElementById('mtGlobalOverlay');
                if (ov) { ov.style.display = 'flex'; return; }
                ov = document.createElement('div');
                ov.id = 'mtGlobalOverlay';
                // left:90px (clears the nav sidebar), z-index:1001 (above dialogs at 1000)
                ov.style.cssText = 'display:flex; position:fixed; top:0; right:0; bottom:0; left:90px; background:rgba(0,0,0,0.55); z-index:1001; align-items:center; justify-content:center;';
                var box = document.createElement('div');
                box.style.cssText = 'position:relative; width:calc(100% - 60px); height:calc(100% - 60px); background:#fff; border:1px solid #888; border-radius:6px; box-shadow:0 8px 40px rgba(0,0,0,0.5); overflow:hidden;';
                var close = document.createElement('span');
                close.style.cssText = 'position:absolute; top:8px; right:10px; z-index:5; cursor:pointer; font-size:22px; color:#555; font-weight:bold;';
                close.textContent = '✕';
                close.onclick = function () { var o = document.getElementById('mtGlobalOverlay'); if (o) o.parentNode.removeChild(o); };
                var ifr = document.createElement('iframe');
                ifr.style.cssText = 'width:100%; height:100%; border:none;';
                ifr.src = '/pluginadmin.ashx?pin=scripttask&user=1&global=1';
                box.appendChild(ifr);
                box.appendChild(close);
                ov.appendChild(box);
                document.body.appendChild(ov);
            };
            var head = p42.querySelector('.areaHead');
            if (head && head.parentNode) head.parentNode.insertBefore(btn, head.nextSibling);
            else p42.appendChild(btn);
        } catch (e) { console.log(e); }
    };

    return obj;
};