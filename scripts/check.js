'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const files = ['meshtask2.js'];
for (const dir of ['lib', 'ui', 'modules_meshcore', 'tests', 'scripts']) {
  for (const name of fs.readdirSync(path.join(root, dir))) if (name.endsWith('.js')) files.push(path.join(dir, name));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(result.status || 1); }
}
const pkg = require('../package.json'), config = require('../config.json');
assert.equal(pkg.version, '2.0.0-alpha.1'); assert.equal(config.version, pkg.version); assert.equal(config.shortName, 'meshtask2');
assert.equal(typeof require('../meshtask2').meshtask2, 'function');
assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
const agent = fs.readFileSync(path.join(root, 'modules_meshcore/meshtask2.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
assert.doesNotMatch(agent, /\b(?:const|let|class|async|await)\b|=>|`|\.\.\./, 'Conservative ES5 syntax gate');
for (const file of ['ui/admin.js', 'ui/bridge.js']) assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /\.innerHTML\s*=|insertAdjacentHTML|\beval\s*\(/);
console.log(`Syntax OK: ${files.length} JS files; version/config/import/ES5-subset and safe DOM checks OK. Not MeshAgent E2E.`);
