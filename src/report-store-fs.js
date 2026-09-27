'use strict';
// Filesystem report store — the only module that knows WHERE reports live.
// Moving to Google Cloud Storage later means a sibling module with the same four
// functions (listPending / readReport / writeTriage / readTriage); nothing else changes.
//
// Layout (contract: contracts/bug-feature-report.v1.schema.json):
//   <usersRoot>/<profile>/projects/bugs-and-features/reports/<id>/
//     report.json   what the user reported   (written by the agent's MCP tool)
//     transcript.md optional raw user words
//     attachments/  optional files
//     triage.json   what the pipeline did    (written ONLY here; `retrying` = try again)
//
// Legacy reports (pre-v1, written by the LLM by hand) have no `schema` field and may be
// listed in collector/state.json as already filed — those are never re-filed.

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'bugs-and-features';
const QUIET_MS = Number(process.env.BF_QUIET_MS || 2 * 60 * 1000);
const MAX_ATTEMPTS = 3;
const REPORT_SCHEMA = 'bug-feature-report/v1';
const TRIAGE_SCHEMA = 'bug-feature-triage/v1';

function projectDir(usersRoot, profile) {
  return path.join(usersRoot, profile, 'projects', PROJECT_ID);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Newest mtime anywhere under dir (recursive). 0 if missing.
function newestMtimeMs(dir) {
  let max = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.mtimeMs > max) max = st.mtimeMs;
    if (!st.isDirectory()) return;
    let names = [];
    try { names = fs.readdirSync(p); } catch { return; }
    for (const n of names) walk(path.join(p, n));
  };
  walk(dir);
  return max;
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}

// Ids already filed by the retired in-agent collector (src/bugs-collector.js).
function legacyProcessed(pDir) {
  const s = readJson(path.join(pDir, 'collector', 'state.json'));
  return (s && s.processed && typeof s.processed === 'object') ? s.processed : {};
}

// Reports that need triage: report.json present, no final triage.json (or `retrying`).
// Returns [{ profile, id, dir }], oldest first.
function listPending({ usersRoot, now = Date.now(), quietMs = QUIET_MS } = {}) {
  const out = [];
  for (const profile of listDirs(usersRoot)) {
    const pDir = projectDir(usersRoot, profile);
    const reportsDir = path.join(pDir, 'reports');
    const legacy = legacyProcessed(pDir);
    for (const id of listDirs(reportsDir)) {
      if (id.startsWith('.') || id.startsWith('_')) continue; // .tmp-* = write in progress
      const dir = path.join(reportsDir, id);
      const report = readJson(path.join(dir, 'report.json'));
      if (!report) continue;
      if (legacy[id] || legacy[report.id]) continue;
      const triage = readJson(path.join(dir, 'triage.json'));
      if (triage && triage.status !== 'retrying') continue;
      // v1 reports appear atomically (tmp dir + rename) — ready at once. Legacy reports
      // were written file-by-file by the LLM, so wait until the folder stops changing.
      if (report.schema !== REPORT_SCHEMA && now - newestMtimeMs(dir) < quietMs) continue;
      out.push({ profile, id, dir, createdAt: report.createdAt || '' });
    }
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return out.map(({ profile, id, dir }) => ({ profile, id, dir }));
}

function listFiles(dir) {
  try { return fs.readdirSync(dir).filter(n => !n.startsWith('.')); } catch { return []; }
}

// Normalized view of one report (v1 or legacy).
function readReport(dir) {
  const raw = readJson(path.join(dir, 'report.json')) || {};
  let transcript = '';
  try { transcript = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8'); } catch { /* optional */ }
  return {
    raw,
    kind: raw.kind === 'feature' ? 'feature' : 'bug',
    title: String(raw.title || path.basename(dir)),
    summary: String(raw.summary || ''),
    userWords: String(raw.userWords || ''),
    profile: (raw.reporter && raw.reporter.profile) || null,
    transcript,
    attachments: listFiles(path.join(dir, 'attachments')),
  };
}

function readTriage(dir) {
  return readJson(path.join(dir, 'triage.json'));
}

// Atomic: tmp + rename, so the user/agents never see a half-written triage.json.
function writeTriage(dir, triage) {
  const file = path.join(dir, 'triage.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: TRIAGE_SCHEMA, ...triage, at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  PROJECT_ID, QUIET_MS, MAX_ATTEMPTS, REPORT_SCHEMA, TRIAGE_SCHEMA,
  projectDir, newestMtimeMs, listPending, readReport, readTriage, writeTriage,
};
