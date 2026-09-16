/**
* @description MeshCentral-ScriptTask database module (SQLite)
* @author Fernando Lima (based on Ryan Blenis' NeDB/Mongo db.js)
* @license Apache-2.0
*
* SQLite persistence for the ScriptTask plugin. Independent file
* (<datapath>/plugin-scripttask.sqlite), same table-style API as the old
* NeDB/Mongo module so scripttask.js keeps a uniform call surface.
*
* On first run, if the legacy NeDB file (plugin-scripttask.db) exists and
* the SQLite db is empty, all documents are migrated automatically
* (scripts, folders, jobs, schedules, variables) and the NeDB file is
* renamed to plugin-scripttask.db.migrated-<ts> as backup.
*
* Uses the same sqlite3 driver MeshCentral core ships (require('sqlite3')),
* resolved from MeshCentral's node_modules.
*/

"use strict";
var fs = null;
var path = null;

function log(msg) { console.log('PLUGIN: ScriptTask DB: ' + msg); }

module.exports.CreateDB = function (meshserver) {
    var obj = {};
    obj.parent = meshserver;
    obj.dbVersion = 2; // schema version of this module
    obj.migrated = false;

    // Resolve sqlite3 from MeshCentral's own node_modules (same driver as core)
    function requireSqlite3() {
        try { return require('sqlite3'); } catch (e) { }
        var candidates = [];
        if (meshserver && meshserver.parentpath) candidates.push(require('path').join(meshserver.parentpath, 'node_modules', 'sqlite3'));
        try {
            // walk up from this file: plugins/scripttask -> plugins -> <datapath> -> parent install dir
            var p = __dirname;
            for (var i = 0; i < 6; i++) {
                p = require('path').dirname(p);
                candidates.push(require('path').join(p, 'node_modules', 'sqlite3'));
            }
        } catch (e) { }
        for (var c in candidates) {
            try { return require(candidates[c]); } catch (e) { }
        }
        throw new Error('sqlite3 driver not found (MeshCentral node_modules)');
    }

    fs = fs || require('fs');
    path = path || require('path');

    var sqlite3 = requireSqlite3();
    var datapath = (meshserver && (meshserver.datapath || (meshserver.parent && meshserver.parent.datapath))) || '.';
    var sqliteFile = path.join(datapath, 'plugin-scripttask.sqlite');
    var nedbFile = path.join(datapath, 'plugin-scripttask.db');

    obj.sqliteFile = sqliteFile;

    // ---------- schema ----------
    var SCHEMA =
        'CREATE TABLE IF NOT EXISTS docs (' +
        '  id TEXT PRIMARY KEY,' +            // _id (random like NeDB for compat)
        '  type TEXT NOT NULL,' +             // script | folder | job | jobSchedule | variable | meta
        '  name TEXT,' +                      // name for scripts/folders/variables
        '  path TEXT,' +                      // script/folder path
        '  scriptId TEXT,' +                  // jobs/schedules
        '  node TEXT,' +                      // jobs/schedules
        '  completeTime INTEGER,' +           // jobs
        '  dispatchTime INTEGER,' +           // jobs
        '  queueTime INTEGER,' +              // jobs
        '  nextRun INTEGER,' +                // schedules
        '  filter TEXT,' +                    // schedules targeting a device filter (0.1.0)
        '  doc TEXT NOT NULL' +               // full JSON document (source of truth)
        ');' +
        'CREATE INDEX IF NOT EXISTS idx_docs_type ON docs(type);' +
        'CREATE INDEX IF NOT EXISTS idx_docs_scriptid ON docs(scriptId);' +
        'CREATE INDEX IF NOT EXISTS idx_docs_node ON docs(node);' +
        'CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);' +
        'CREATE INDEX IF NOT EXISTS idx_docs_complete ON docs(completeTime);' +
        'CREATE INDEX IF NOT EXISTS idx_docs_name ON docs(name);';

    var db = null;
    var serialQueue = [];   // serialize all writes: sqlite3 is async-callback and we need determinism
    var draining = false;

    function enqueue(fn) { serialQueue.push(fn); drain(); }
    function drain() {
        if (draining) return;
        draining = true;
        var step = function () {
            var fn = serialQueue.shift();
            if (fn == null) { draining = false; return; }
            try { fn(step); } catch (e) { log('write error: ' + e); step(); }
        };
        step();
    }

    function randId() {
        // 16-char id compatible with existing NeDB ids
        var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        var s = '';
        for (var i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
    }

    function esc(s) { return (s == null) ? '' : String(s).replace(/'/g, "''"); }

    // ---------- init ----------
    obj.initFunctions = function () {
        obj.updateDBVersion = function (new_version) {
            return new Promise(function (res, rej) {
                enqueue(function (next) {
                    db.run("INSERT INTO docs (id, type, doc) VALUES ($1, 'meta', $2) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc",
                        {'$1': 'db_version', '$2':JSON.stringify({ type: 'db_version', version: new_version }) },
                        function (e) { next(); (e ? rej(e) : res()); });
                });
            });
        };

        obj.getDBVersion = function () {
            return new Promise(function (res) {
                db.get("SELECT doc FROM docs WHERE id = 'db_version'", [], function (e, row) {
                    res((row && row.doc) ? (JSON.parse(row.doc).version || 1) : 1);
                });
            });
        };

        // ---------- scripts / folders ----------
        // 0.1.9: generic insert (for ephemeral scripts)
        obj.insert = function (doc) {
            if (!doc._id) doc._id = randId();
            if (!doc.type) doc.type = 'script';
            return insertDoc(doc).then(function () { return doc; });
        };

        obj.addScript = function (name, content, path_, filetype) {
            if (path_ == null) path_ = 'Shared';
            if (filetype == 'bash') content = content.split('\r\n').join('\n').split('\r').join('\n');
            var id = randId();
            var sObj = {
                type: 'script', _id: id, path: path_, name: name, content: content,
                contentHash: require('crypto').createHash('sha384').update(content).digest('hex'),
                filetype: filetype
            };
            return insertDoc(sObj).then(function () { return sObj; });
        };

        obj.addFolder = function (name, path_) {
            var id = randId();
            var sObj = { type: 'folder', _id: id, path: path_, name: name };
            return insertDoc(sObj).then(function () { return sObj; });
        };

        obj.getScriptTree = function () {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type IN ('script','folder') ORDER BY LOWER(path), type, LOWER(name)", [], function (e, rows) {
                    if (e) return rej(e);
                    res(rows.map(function (r) { return JSON.parse(r.doc); }).filter(function (d) { return d.ephemeral !== true; })
                        .map(function (d) { return { name: d.name, path: d.path, type: d.type, filetype: d.filetype, _id: d._id }; }));
                });
            });
        };

        obj.update = function (id, args) {
            return new Promise(function (res, rej) {
                db.get('SELECT doc FROM docs WHERE id = $1', {'$1': id }, function (e, row) {
                    if (e) return rej(e);
                    if (!row) return res({ updated: 0 });
                    var d = JSON.parse(row.doc);
                    for (var k in args) { if (args[k] !== undefined) d[k] = args[k]; }
                    if (d.type == 'script' && d.content != null) {
                        if (d.filetype == 'bash') d.content = d.content.split('\r\n').join('\n').split('\r').join('\n');
                        d.contentHash = require('crypto').createHash('sha384').update(d.content).digest('hex');
                    }
                    enqueue(function (next) {
                        db.run('UPDATE docs SET doc = $1, name = $2, path = $3, completeTime = $4, dispatchTime = $5, queueTime = $6, nextRun = $7 WHERE id = $8',
                            {'$1': JSON.stringify(d), '$2':d.name || null, '$3':d.path || null,
                              4: (d.completeTime != null ? d.completeTime : null),
                              5: (d.dispatchTime != null ? d.dispatchTime : null),
                              6: (d.queueTime != null ? d.queueTime : null),
                              7: (d.nextRun != null ? d.nextRun : null), 8: id },
                            function (e2) { next(); (e2 ? rej(e2) : res({ updated: 1 })); });
                    });
                });
            });
        };

        obj.delete = function (id) {
            return new Promise(function (res, rej) {
                enqueue(function (next) {
                    db.run('DELETE FROM docs WHERE id = $1', {'$1': id }, function (e) { next(); (e ? rej(e) : res({ deleted: this.changes })); });
                });
            });
        };

        obj.deleteByPath = function (path_) {
            return new Promise(function (res, rej) {
                enqueue(function (next) {
                    db.run("DELETE FROM docs WHERE path = $1 AND type IN ('script','folder')", {'$1': path_ }, function (e) { next(); (e ? rej(e) : res()); });
                });
            });
        };

        obj.deleteSchedulesForScript = function (id) {
            return new Promise(function (res, rej) {
                enqueue(function (next) {
                    db.run("DELETE FROM docs WHERE scriptId = $1 AND type = 'jobSchedule'", {'$1': id }, function (e) { next(); (e ? rej(e) : res()); });
                });
            });
        };

        obj.getByPath = function (path_) {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type IN ('script','folder') AND path = $1", {'$1': path_ }, function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        obj.get = function (id) {
            if (id == null || id == 'null') return Promise.resolve([]);
            return new Promise(function (res, rej) {
                db.all('SELECT doc FROM docs WHERE id = $1', {'$1': id }, function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        // ---------- jobs ----------
        obj.addJob = function (passedObj) {
            var nowTime = Math.floor(new Date() / 1000);
            var defaultObj = {
                type: 'job', queueTime: nowTime, dontQueueUntil: nowTime, dispatchTime: null,
                completeTime: null, node: null, scriptId: null, scriptName: null,
                replaceVars: null, returnVal: null, errorVal: null, returnAct: null,
                runBy: null, jobSchedule: null
            };
            var jObj = Object.assign({}, defaultObj, passedObj);
            if (jObj.node == null || jObj.scriptId == null) { log('Could not add job (node/scriptId null)'); return Promise.resolve(false); }
            jObj._id = randId();
            return insertDoc(jObj).then(function () { return jObj; });
        };

        obj.addJobSchedule = function (schedObj) {
            schedObj.type = 'jobSchedule';
            if (schedObj.node == null && schedObj.filter == null) { log('Could not add job schedule (no node/filter)'); return Promise.resolve(false); }
            schedObj._id = randId();
            return insertDoc(schedObj).then(function () { return schedObj; });
        };

        obj.removeJobSchedule = function (id) { return obj.delete(id); };

        obj.getSchedulesDueForJob = function (scheduleId) {
            var nowTime = Math.floor(new Date() / 1000);
            var lim = scheduleId ? (' AND id = ' + JSON.stringify(String(scheduleId)).replace('"', "'").replace('"', "'")) : '';
            // scheduleId is used internally with known-good ids; still parameterize when present
            var sql = "SELECT doc FROM docs WHERE type = 'jobSchedule'" + (scheduleId ? ' AND id = $3' : '');
            var params = scheduleId ? { '$3': scheduleId } : {};
            return new Promise(function (res, rej) {
                db.all(sql, params, function (e, rows) {
                    if (e) return rej(e);
                    res(rows.map(rowDoc).filter(function (s) {
                        if (s.endAt != null && s.endAt <= nowTime) return false;
                        return (s.nextRun == null) || (s.nextRun <= nowTime + 60);
                    }));
                });
            });
        };

        obj.deletePendingJobsForNode = function (node) {
            return new Promise(function (res, rej) {
                enqueue(function (next) {
                    db.run("DELETE FROM docs WHERE type = 'job' AND node = $1 AND completeTime IS NULL", {'$1': node }, function (e) { next(); (e ? rej(e) : res()); });
                });
            });
        };

        // 0.1.8: jobs dispatched > timeoutSec ago with no completion (stale)
    // 1.0.1: never-dispatched jobs expire only after queueExpirySec (7 days) of
    //        eligibility (past dontQueueUntil) — they wait for their agent to
    //        reconnect; future-dated jobs (dontQueueUntil > now) are NEVER stale.
    obj.getStaleJobs = function (now, timeoutSec, queueExpirySec) {
        if (queueExpirySec == null) queueExpirySec = timeoutSec;
        return new Promise(function (resolve, reject) {
            // Never-dispatched jobs expire 7 days after they become ELIGIBLE
            // (baseline = max(queueTime, dontQueueUntil)) — a job queued months
            // ahead of its slot waits for the slot, then 7 days for its agent.
            db.all("SELECT id, doc, completeTime, dispatchTime FROM docs WHERE type = 'job' AND completeTime IS NULL AND (json_extract(doc, '$.dontQueueUntil') IS NULL OR json_extract(doc, '$.dontQueueUntil') <= $2) AND ((dispatchTime IS NOT NULL AND dispatchTime < $1) OR (dispatchTime IS NULL AND queueTime < $3 AND (json_extract(doc, '$.dontQueueUntil') IS NULL OR json_extract(doc, '$.dontQueueUntil') < $3)))", { $1: now - timeoutSec, $2: now, $3: now - queueExpirySec }, function (err, rows) {
                if (err) return reject(err);
                resolve(rows.map(function (r) { return rowDoc(r); }));
            });
        });
    };

    obj.getPendingJobs = function (nodeScope) {
            if (nodeScope == null || !Array.isArray(nodeScope)) return Promise.resolve(false);
            var nowTime = Math.floor(new Date() / 1000);
            var inClause = nodeScope.map(function (n, i) { return '$' + (i + 2); }).join(',');
            var params = { '$1': nowTime };
            nodeScope.forEach(function (n, i) { params['$' + (i + 2)] = n; });
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type = 'job' AND node IN (" + inClause + ") AND completeTime IS NULL AND (json_extract(doc, '$.dontQueueUntil') IS NULL OR json_extract(doc, '$.dontQueueUntil') <= $1)", params, function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        obj.getJobNodeHistory = function (nodeId) {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type = 'job' AND node = $1 ORDER BY queueTime DESC LIMIT 200", {'$1': nodeId }, function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        obj.getJobScriptHistory = function (scriptId) {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type = 'job' AND scriptId = $1 ORDER BY COALESCE(completeTime, 0) DESC, queueTime DESC LIMIT 200", {'$1': scriptId }, function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        obj.updateScriptJobName = function (scriptId, scriptName) {
            return new Promise(function (res, rej) {
                enqueue(function (next) {
                    db.run("UPDATE docs SET name = $1, doc = json_set(doc, '$.scriptName', json($2)) WHERE type = 'job' AND scriptId = $3",
                        {'$1': scriptName, '$2': JSON.stringify(scriptName), '$3': scriptId },
                        function (e2) { next(); (e2 ? rej(e2) : res()); });
                });
            });
        };

        obj.getJobSchedulesForScript = function (scriptId) {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type = 'jobSchedule' AND scriptId = $1", {'$1': scriptId }, function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        obj.getJobSchedulesForNode = function (nodeId) {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type = 'jobSchedule' AND node = $1", {'$1': nodeId }, function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        // schedules that target a FILTER (new in 0.1.0)
        // 0.1.9: get ALL schedules (for global mode)
        obj.getAllJobSchedules = function () {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type = 'jobSchedule' ORDER BY queueTime DESC", [], function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        obj.getJobSchedulesForFilter = function () {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type = 'jobSchedule' AND filter IS NOT NULL", [], function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        obj.getIncompleteJobsForSchedule = function (schedId) {
            return new Promise(function (res, rej) {
                db.all("SELECT doc FROM docs WHERE type = 'job' AND json_extract(doc, '$.jobSchedule') = $1 AND completeTime IS NULL", {'$1': schedId }, function (e, rows) {
                    if (e) return rej(e); res(rows.map(rowDoc));
                });
            });
        };

        obj.deletePendingJobsForSchedule = function (schedId) {
            return new Promise(function (res, rej) {
                enqueue(function (next) {
                    db.run("DELETE FROM docs WHERE type = 'job' AND json_extract(doc, '$.jobSchedule') = $1 AND completeTime IS NULL", {'$1': schedId }, function (e) { next(); (e ? rej(e) : res()); });
                });
            });
        };

        obj.deleteOldHistory = function () {
            var oldTime = Math.floor(new Date() / 1000) - (86400 * 90);
            return new Promise(function (res, rej) {
                enqueue(function (next) {
                    db.run("DELETE FROM docs WHERE type = 'job' AND completeTime IS NOT NULL AND completeTime <= $1", {'$1': oldTime }, function (e) { next(); (e ? rej(e) : res()); });
                });
            });
        };

        // ---------- variables ----------
        obj.addVariable = function (name, scope, scopeTarget, value) {
            var id = randId();
            var vObj = { type: 'variable', _id: id, name: name, scope: scope, scopeTarget: scopeTarget, value: value };
            return insertDoc(vObj).then(function () { return vObj; });
        };

        obj.getVariables = function (limiters) {
            if (limiters != null) {
                return new Promise(function (res, rej) {
                    db.all("SELECT doc FROM docs WHERE type = 'variable' AND name IN (" + limiters.names.map(function (_, i) { return '$' + (i + 1); }).join(',') + ') ORDER BY LOWER(name)',
                        limiters.names.reduce(function (a, n, i) { a['$' + (i + 1)] = n; return a; }, {}), function (e, rows) {
                            if (e) return rej(e);
                            var docs = rows.map(rowDoc).filter(function (v) {
                                return (v.scope == 'global') ||
                                    (v.scope == 'script' && v.scopeTarget == limiters.scriptId) ||
                                    (v.scope == 'mesh' && v.scopeTarget == limiters.meshId) ||
                                    (v.scope == 'node' && v.scopeTarget == limiters.nodeId);
                            });
                            res(docs);
                        });
                });
            } else {
                return new Promise(function (res, rej) {
                    db.all("SELECT doc FROM docs WHERE type = 'variable' ORDER BY LOWER(name)", [], function (e, rows) {
                        if (e) return rej(e); res(rows.map(rowDoc));
                    });
                });
            }
        };

        // filter schedules listing for UI
        obj.getAllFilterSchedules = obj.getJobSchedulesForFilter;

        obj.checkDefaults = function () {
            db.get("SELECT doc FROM docs WHERE type = 'folder' AND name = 'Shared' AND path = 'Shared'", [], function (e, row) {
                if (!e && !row) obj.addFolder('Shared', 'Shared');
            });
        };

        // ---------- migration from NeDB ----------
        obj.migrateFromNedb = function () {
            return new Promise(function (resolve) {
                if (!fs.existsSync(nedbFile)) return resolve({ migrated: false, reason: 'no-nedb-file' });
                db.get('SELECT COUNT(*) c FROM docs', [], function (e, row) {
                    var existing = (row && row.c) || 0;
                    // only auto-migrate when target is empty (idempotent)
                    if (existing > 1) return resolve({ migrated: false, reason: 'target-not-empty', docs: existing });
                    var raw = fs.readFileSync(nedbFile, 'utf8').split('\n');
                    var docs = [];
                    for (var i in raw) {
                        if (!raw[i] || raw[i].charAt(0) != '{') continue;
                        try { var d = JSON.parse(raw[i]); if (d && d.type && d._id && d.$$indexCreated == null) docs.push(d); } catch (ex) { }
                    }
                    if (docs.length == 0) return resolve({ migrated: false, reason: 'no-docs' });
                    var done = 0, failed = 0;
                    for (var k in docs) {
                        (function (doc) {
                            insertDoc(doc).then(function () { if (++done + failed == docs.length) finish(); })
                                .catch(function () { failed++; if (done + failed == docs.length) finish(); });
                        })(docs[k]);
                    }
                    function finish() {
                        // backup the old file so nothing is lost
                        var bak = nedbFile + '.migrated-' + Math.floor(new Date() / 1000);
                        try { fs.renameSync(nedbFile, bak); } catch (ex) { log('NeDB backup rename failed: ' + ex); }
                        log('Migrated ' + done + ' documents from NeDB to SQLite (backup: ' + path.basename(bak) + ')');
                        obj.migrated = true;
                        resolve({ migrated: true, docs: done, failed: failed, backup: bak });
                    }
                });
            });
        };

        obj.close = function () {
            return new Promise(function (res) { db.close(function () { res(); }); });
        };

        // (checkDefaults é chamado após a migração, em obj.ready)
    };

    function rowDoc(r) { return JSON.parse(r.doc); }

    function insertDoc(d) {
        return new Promise(function (res, rej) {
            enqueue(function (next) {
                db.run('INSERT OR REPLACE INTO docs (id, type, name, path, scriptId, node, completeTime, dispatchTime, queueTime, nextRun, filter, doc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
                    {'$1': d._id, '$2':d.type, '$3':d.name || null, '$4':d.path || null, '$5':d.scriptId || null,
                      6: d.node || null, 7: (d.completeTime != null ? d.completeTime : null),
                      8: (d.dispatchTime != null ? d.dispatchTime : null), 9: (d.queueTime != null ? d.queueTime : null),
                      10: (d.nextRun != null ? d.nextRun : null), 11: d.filter || null, 12: JSON.stringify(d) },
                    function (e) { next(); (e ? rej(e) : res()); });
            });
        });
    }

    // filter column needs to exist in schema (added after initial draft; included in SCHEMA below via extra index)
    // ---------- open ----------
    var ready = new Promise(function (resolve, reject) {
        db = new sqlite3.Database(sqliteFile, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, function (err) {
            if (err) {
                log('open failed (' + err + '), retrying without flags');
                db = new sqlite3.Database(sqliteFile, function (err2) {
                    if (err2) return reject(err2);
                    afterOpen(resolve, reject);
                });
                return;
            }
            afterOpen(resolve, reject);
        });
    });

    function afterOpen(resolve, reject) {
        db.serialize(function () {
            db.run('PRAGMA journal_mode = WAL');
            db.run('PRAGMA synchronous = NORMAL');
            SCHEMA.split(';').forEach(function (stmt) {
                if (stmt.trim()) db.run(stmt + ';');
            });
            db.run('CREATE INDEX IF NOT EXISTS idx_docs_filter ON docs(filter)', [], function (e) { if (e) log('index filter: ' + e); resolve(); });
        });
    }

    // initFunctions must only run after schema is ready; migration runs BEFORE
    // initFunctions so checkDefaults doesn't duplicate the 'Shared' folder from the migrated data.
    obj.ready = ready.then(function () {
        obj.initFunctions();           // define todas as funções (incl. migrateFromNedb)
        return obj.migrateFromNedb().then(function (m) {
            obj.checkDefaults();       // depois da migração: não duplica 'Shared'
            return m;
        });
    });

    return obj;
};