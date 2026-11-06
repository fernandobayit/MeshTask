'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ensure, TaskError } = require('./errors');
function runtime(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  ensure(major > 22 || (major === 22 && minor >= 13), 'RUNTIME', 'MeshTask 2 exige Node >=22.13 e node:sqlite.');
}
// A disk store requires a pre-created, private directory; no silently insecure fallback.
function privateFile(filename) {
  ensure(path.isAbsolute(filename), 'STORAGE', 'Caminho absoluto do banco obrigatório.');
  ensure(process.platform !== 'win32', 'STORAGE', 'ACL de armazenamento Windows ainda não homologada; use servidor POSIX.');
  const parent = path.dirname(filename);
  const dir = fs.lstatSync(parent);
  ensure(dir.isDirectory() && !dir.isSymbolicLink() && (dir.mode & 0o077) === 0 && dir.uid === process.getuid(), 'STORAGE', 'Diretório privado (0700), próprio e sem symlink obrigatório.');
  ensure(fs.realpathSync(parent) === parent, 'STORAGE', 'Caminho de armazenamento não pode conter symlink.');
  const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    ensure(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.uid === process.getuid(), 'STORAGE', 'Banco deve ser privado (0600), próprio e sem hardlink.');
  } finally { fs.closeSync(fd); }
}
class Store {
  constructor(filename = ':memory:') {
    runtime();
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { throw new TaskError('RUNTIME', 'node:sqlite indisponível; inicialização recusada.'); }
    if (filename !== ':memory:') privateFile(filename);
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      ensure(version === 0 || version === 1, 'SCHEMA', 'Versão de banco não suportada.');
      ensure(this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'STORAGE', 'Banco inconsistente.');
      if (version === 0) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE admin_requests (domain TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(domain,actor,request_id));
          CREATE TABLE scripts (id TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE TABLE revisions (script_id TEXT NOT NULL REFERENCES scripts(id), revision INTEGER NOT NULL, engine TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(script_id,revision));
          CREATE TABLE jobs (id TEXT PRIMARY KEY, domain TEXT NOT NULL, actor TEXT NOT NULL, snapshot TEXT NOT NULL, created INTEGER NOT NULL, schedule_id TEXT, occurrence INTEGER, UNIQUE(schedule_id,occurrence));
          CREATE TABLE targets (job_id TEXT NOT NULL REFERENCES jobs(id), node TEXT NOT NULL, eligible_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY(job_id,node));
          CREATE TABLE attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), node TEXT NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('claimed','acknowledged','unknown','succeeded','failed','rejected')), claimed INTEGER NOT NULL, deadline INTEGER NOT NULL, result TEXT, UNIQUE(job_id,node));
          CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), attempt_id TEXT REFERENCES attempts(id), type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, dedup TEXT UNIQUE);
          CREATE TABLE schedules (id TEXT PRIMARY KEY, domain TEXT NOT NULL, actor TEXT NOT NULL, snapshot TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('once','interval')), at INTEGER NOT NULL, interval_ms INTEGER, next_due INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_check INTEGER NOT NULL DEFAULT 0, last_error TEXT);
          CREATE TABLE schedule_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL REFERENCES schedules(id), type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, dedup TEXT UNIQUE);
          CREATE INDEX attempts_deadline ON attempts(state,deadline);
          CREATE INDEX events_attempt ON events(attempt_id,type);
          CREATE INDEX events_job ON events(job_id,seq);
          CREATE INDEX jobs_domain ON jobs(domain,created);
          CREATE TRIGGER immutable_target_identity BEFORE UPDATE OF job_id,node ON targets BEGIN SELECT RAISE(ABORT,'immutable target'); END;
          CREATE TRIGGER immutable_schedule_snapshot BEFORE UPDATE OF domain,actor,snapshot,kind,at,interval_ms ON schedules BEGIN SELECT RAISE(ABORT,'immutable schedule'); END;
          CREATE TRIGGER immutable_revision_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
          CREATE TRIGGER immutable_revision_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
          CREATE TRIGGER immutable_job_update BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'immutable job'); END;
          CREATE TRIGGER immutable_job_delete BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT,'immutable job'); END;
          CREATE TRIGGER immutable_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
          CREATE TRIGGER immutable_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
          CREATE TRIGGER immutable_schedule_event_update BEFORE UPDATE ON schedule_events BEGIN SELECT RAISE(ABORT,'immutable schedule event'); END;
          CREATE TRIGGER immutable_schedule_event_delete BEFORE DELETE ON schedule_events BEGIN SELECT RAISE(ABORT,'immutable schedule event'); END;
          CREATE TRIGGER immutable_final_result BEFORE UPDATE ON attempts WHEN OLD.result IS NOT NULL AND (NEW.result IS NOT OLD.result OR NEW.state IS NOT OLD.state) BEGIN SELECT RAISE(ABORT,'immutable final result'); END;
          PRAGMA user_version=1;
        `);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    ensure(fn.constructor.name !== 'AsyncFunction', 'STORAGE', 'Transação deve ser síncrona.');
    const depth = this.depth || 0, savepoint = 'nested_' + depth;
    this.db.exec(depth ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
    this.depth = depth + 1;
    try {
      const result = fn();
      ensure(!result || typeof result.then !== 'function', 'STORAGE', 'Transação deve ser síncrona.');
      this.db.exec(depth ? 'RELEASE SAVEPOINT ' + savepoint : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(depth ? 'ROLLBACK TO SAVEPOINT ' + savepoint + '; RELEASE SAVEPOINT ' + savepoint : 'ROLLBACK');
      throw error;
    } finally { this.depth = depth; }
  }
  event(jobId, attemptId, type, at, data = {}, dedup = null) {
    return this.run('INSERT OR IGNORE INTO events(job_id,attempt_id,type,at,data,dedup) VALUES(?,?,?,?,?,?)', jobId, attemptId, type, at, JSON.stringify(data), dedup);
  }
  scheduleEvent(scheduleId, type, at, data = {}, dedup = null) {
    return this.run('INSERT OR IGNORE INTO schedule_events(schedule_id,type,at,data,dedup) VALUES(?,?,?,?,?)', scheduleId, type, at, JSON.stringify(data), dedup);
  }
  close() { this.db.close(); }
}
module.exports = { Store, runtime };
