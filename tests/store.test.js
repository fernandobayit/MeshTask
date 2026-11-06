'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store, runtime } = require('../lib/store');
const { temp } = require('./helpers');

test('runtime lower than 22.13 rejected without dependency installation', () => {
  for (const version of ['18.20.0', '20.0.0', '22.12.9']) assert.throws(() => runtime(version), /22.13/);
  runtime('22.13.0'); runtime('22.22.0'); runtime('24.0.0');
});

test('disk database created privately with foreign keys and durable sync setting', (t) => {
  const file = temp(t), store = new Store(file); t.after(() => store.close());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(store.get('PRAGMA synchronous').synchronous, 2);
  assert.equal(store.get('PRAGMA user_version').user_version, 1);
});

test('unsafe directory, unsafe file mode and symlink/hardlink refused', (t) => {
  const file = temp(t), dir = path.dirname(file);
  fs.chmodSync(dir, 0o755); assert.throws(() => new Store(file), /privado/);
  fs.chmodSync(dir, 0o700); fs.writeFileSync(file, '', { mode: 0o644 }); assert.throws(() => new Store(file), /privado/);
  fs.chmodSync(file, 0o600); const link = path.join(dir, 'link.sqlite'); fs.symlinkSync(file, link); assert.throws(() => new Store(link));
  const hard = path.join(dir, 'hard.sqlite'); fs.linkSync(file, hard); assert.throws(() => new Store(file), /hardlink/);
});

test('corrupt/unsupported database rejected without recreating or discarding contents', (t) => {
  const file = temp(t); fs.writeFileSync(file, 'not sqlite', { mode: 0o600 });
  assert.throws(() => new Store(file)); assert.equal(fs.readFileSync(file, 'utf8'), 'not sqlite');
  const other = path.join(path.dirname(file), 'future.sqlite'), store = new Store(other);
  store.db.exec('PRAGMA user_version=99'); store.close();
  assert.throws(() => new Store(other), /não suportada/);
});

test('transactions reject async bodies and roll back synchronous failures', (t) => {
  const store = new Store(); t.after(() => store.close());
  assert.throws(() => store.transaction(() => Promise.resolve()), /síncrona/);
  assert.throws(() => store.transaction(() => { store.run("INSERT INTO scripts VALUES('test','lab','test',1)"); throw new Error('abort'); }), /abort/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM scripts').n, 0);
});
