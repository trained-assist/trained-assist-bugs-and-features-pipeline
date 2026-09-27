'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../src/report-store-fs');
const { tmpDir, writeReport } = require('./helpers');

test('v1 report is pending immediately; legacy waits for the quiet gate', () => {
  const root = tmpDir();
  const now = Date.now();
  writeReport(root, 'alice', '2026-09-27-a');
  writeReport(root, 'alice', '2026-09-27-legacy-fresh', { legacy: true });
  writeReport(root, 'bob', '2026-09-26-legacy-old', { legacy: true, mtime: now - 10 * 60_000 });
  const ids = store.listPending({ usersRoot: root, now }).map(p => p.id).sort();
  assert.deepStrictEqual(ids, ['2026-09-26-legacy-old', '2026-09-27-a']);
});

test('triage.json final status hides the report; retrying keeps it pending', () => {
  const root = tmpDir();
  const a = writeReport(root, 'alice', '2026-09-27-a');
  const b = writeReport(root, 'alice', '2026-09-27-b');
  store.writeTriage(a, { status: 'filed', issue: { number: 1, url: 'u' }, attempts: 1 });
  store.writeTriage(b, { status: 'retrying', attempts: 1, reason: 'x' });
  assert.deepStrictEqual(store.listPending({ usersRoot: root }).map(p => p.id), ['2026-09-27-b']);
  const t = store.readTriage(a);
  assert.strictEqual(t.schema, 'bug-feature-triage/v1');
  assert.ok(t.at);
});

test('legacy collector/state.json processed ids are never re-filed', () => {
  const root = tmpDir();
  writeReport(root, 'owner', '2026-09-23-oauth', { legacy: true, mtime: Date.now() - 3600_000 });
  const stateDir = path.join(root, 'owner', 'projects', 'bugs-and-features', 'collector');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ processed: { '2026-09-23-oauth': { issue: 1195 } } }));
  assert.strictEqual(store.listPending({ usersRoot: root }).length, 0);
});

test('in-progress tmp dirs and folders without report.json are ignored', () => {
  const root = tmpDir();
  const reports = path.join(root, 'alice', 'projects', 'bugs-and-features', 'reports');
  fs.mkdirSync(path.join(reports, '.tmp-2026-09-27-x'), { recursive: true });
  fs.writeFileSync(path.join(reports, '.tmp-2026-09-27-x', 'report.json'), '{}');
  fs.mkdirSync(path.join(reports, 'empty'), { recursive: true });
  assert.strictEqual(store.listPending({ usersRoot: root }).length, 0);
});

test('readReport normalizes v1 and lists attachments', () => {
  const root = tmpDir();
  const dir = writeReport(root, 'alice', '2026-09-27-a', { report: { kind: 'feature' }, files: { 'transcript.md': 'raw', 'attachments/s.png': 'x' } });
  const r = store.readReport(dir);
  assert.strictEqual(r.kind, 'feature');
  assert.strictEqual(r.transcript, 'raw');
  assert.deepStrictEqual(r.attachments, ['s.png']);
  assert.strictEqual(r.profile, 'alice');
});
