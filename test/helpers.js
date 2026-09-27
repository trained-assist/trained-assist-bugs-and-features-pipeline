'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir(prefix = 'bf-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Writes a report folder; returns its dir. `legacy` = no schema field (pre-v1).
function writeReport(usersRoot, profile, id, { legacy = false, report = {}, files = {}, mtime } = {}) {
  const dir = path.join(usersRoot, profile, 'projects', 'bugs-and-features', 'reports', id);
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  const r = {
    ...(legacy ? {} : { schema: 'bug-feature-report/v1' }),
    id, kind: 'bug', title: `Title ${id}`, summary: 'Не работает холодный поиск',
    userWords: 'поиск пустой, почта ivan@example.com', status: 'open',
    createdAt: '2026-09-27T10:00:00.000Z', reporter: { profile, channel: 'telegram' },
    ...report,
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r));
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  if (mtime) {
    const t = new Date(mtime);
    for (const p of [dir, path.join(dir, 'report.json'), path.join(dir, 'attachments')]) fs.utimesSync(p, t, t);
  }
  return dir;
}

function fakeGh(existingIssues = []) {
  const calls = { created: [], comments: [], labels: [], removed: [] };
  let next = 1000;
  return {
    calls,
    repo: 'o/r',
    listIssues: async ({ state }) => existingIssues.filter(i => state === 'all' || i.state === state),
    findByMarker: async () => null,
    createIssue: async (x) => { calls.created.push(x); const n = next++; return { number: n, html_url: `https://github.com/o/r/issues/${n}` }; },
    comment: async (n, body) => { calls.comments.push({ n, body }); return {}; },
    addLabels: async (n, labels) => { calls.labels.push({ n, labels }); },
    removeLabel: async (n, l) => { calls.removed.push({ n, l }); },
  };
}

module.exports = { tmpDir, writeReport, fakeGh };
