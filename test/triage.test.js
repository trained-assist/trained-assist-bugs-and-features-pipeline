'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run } = require('../src/triage');
const D = require('../src/triage-decision');
const store = require('../src/report-store-fs');
const { tmpDir, writeReport, fakeGh } = require('./helpers');

function targetRepo() {
  const dir = tmpDir('bf-repo-');
  fs.mkdirSync(path.join(dir, 'docs', 'user-scenarios', 'recruiter'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'user-scenarios', 'GOALS.md'), '# goals');
  fs.writeFileSync(path.join(dir, 'docs', 'user-scenarios', 'recruiter', '04-cold-search.md'), '# cold search');
  return dir;
}

// Fake agent: checks the workspace, writes the given decision.
function agentWriting(decision, seen = []) {
  return async ({ cwd }) => {
    seen.push({
      task: fs.readFileSync(path.join(cwd, 'TASK.md'), 'utf8'),
      hasReport: fs.existsSync(path.join(cwd, 'report', 'report.json')),
      hasScenarios: fs.existsSync(path.join(cwd, 'scenarios', 'recruiter', '04-cold-search.md')),
      hasIndex: fs.existsSync(path.join(cwd, 'issues', 'INDEX.md')),
    });
    if (decision !== null) fs.writeFileSync(path.join(cwd, 'decision.json'), typeof decision === 'string' ? decision : JSON.stringify(decision));
    return { code: 0, output: 'готово' };
  };
}

const NEW = {
  action: 'new', kind: 'bug', title: 'Холодный поиск пустой', area: 'recruiter', severity: 'high',
  body: '## Что происходит\nХолодный поиск возвращает пусто на любой вакансии.',
  scenario: { path: 'recruiter/04-cold-search.md', match: 'existing', note: 'ломает шаг поиска' }, reason: 'нет похожих',
};

test('new: files an issue with marker, scenario, redacted user words; writes triage.json', async () => {
  const users = tmpDir(); const data = tmpDir();
  const dir = writeReport(users, 'alice', '2026-09-27-cold');
  const gh = fakeGh([{ number: 7, state: 'open', title: 'other', labels: [], body: '' }]);
  const seen = [];
  const r = await run({ usersRoot: users, dataDir: data, gh, targetRepoDir: targetRepo(), agent: agentWriting(NEW, seen), logger: { log() {}, warn() {}, error() {} } });
  assert.strictEqual(r.done[0].status, 'filed');
  assert.ok(seen[0].hasReport && seen[0].hasScenarios && seen[0].hasIndex);
  const issue = gh.calls.created[0];
  assert.ok(issue.body.startsWith(D.MARKER('alice', '2026-09-27-cold')));
  assert.ok(issue.body.includes('docs/user-scenarios/recruiter/04-cold-search.md'));
  assert.ok(!issue.body.includes('ivan@example.com'), 'user e-mail must be masked');
  assert.deepStrictEqual(issue.labels, ['bug', 'from-bugs-pipeline', 'area:recruiter']);
  const t = store.readTriage(dir);
  assert.strictEqual(t.status, 'filed');
  assert.strictEqual(t.issue.number, 1000);
  assert.strictEqual(t.scenario.match, 'existing');
  // processed → not pending any more
  assert.strictEqual(store.listPending({ usersRoot: users }).length, 0);
});

test('duplicate: comments on the known issue instead of creating one', async () => {
  const users = tmpDir(); const data = tmpDir();
  const dir = writeReport(users, 'bob', '2026-09-27-dup');
  const gh = fakeGh([{ number: 42, state: 'open', title: 'Холодный поиск пустой', labels: [], body: '' }]);
  await run({ usersRoot: users, dataDir: data, gh, targetRepoDir: targetRepo(), agent: agentWriting({ ...NEW, action: 'duplicate', duplicate_of: 42, reason: 'то же самое' }), logger: { log() {}, warn() {}, error() {} } });
  assert.strictEqual(gh.calls.created.length, 0);
  assert.strictEqual(gh.calls.comments[0].n, 42);
  assert.strictEqual(store.readTriage(dir).status, 'duplicate');
});

test('duplicate of an unknown issue is downgraded to a new issue (never swallowed)', async () => {
  const users = tmpDir(); const data = tmpDir();
  writeReport(users, 'bob', '2026-09-27-dup2');
  const gh = fakeGh([]);
  await run({ usersRoot: users, dataDir: data, gh, targetRepoDir: targetRepo(), agent: agentWriting({ ...NEW, action: 'duplicate', duplicate_of: 999 }), logger: { log() {}, warn() {}, error() {} } });
  assert.strictEqual(gh.calls.created.length, 1);
});

test('bad decision → retrying with feedback; after 3 attempts → fallback template issue', async () => {
  const users = tmpDir(); const data = tmpDir();
  const dir = writeReport(users, 'carol', '2026-09-27-bad');
  const gh = fakeGh([]);
  const seen = [];
  const quiet = { log() {}, warn() {}, error() {} };
  for (let i = 0; i < 2; i++) {
    await run({ usersRoot: users, dataDir: data, gh, targetRepoDir: targetRepo(), agent: agentWriting('not json', seen), logger: quiet });
    assert.strictEqual(store.readTriage(dir).status, 'retrying');
  }
  assert.ok(seen[1].task.includes('Прошлая попытка отклонена'), 'previous error is fed back to the agent');
  await run({ usersRoot: users, dataDir: data, gh, targetRepoDir: targetRepo(), agent: agentWriting(null), logger: quiet });
  const t = store.readTriage(dir);
  assert.strictEqual(t.status, 'filed-fallback');
  assert.strictEqual(t.attempts, 3);
  assert.ok(gh.calls.created[0].labels.includes('needs-triage'));
});

test('an issue already carrying the marker is adopted, not duplicated', async () => {
  const users = tmpDir(); const data = tmpDir();
  const dir = writeReport(users, 'dan', '2026-09-27-x');
  const gh = fakeGh([]);
  gh.findByMarker = async () => ({ number: 5, url: 'https://github.com/o/r/issues/5' });
  let called = false;
  await run({ usersRoot: users, dataDir: data, gh, targetRepoDir: targetRepo(), agent: async () => { called = true; return {}; }, logger: { log() {}, warn() {}, error() {} } });
  assert.strictEqual(called, false);
  assert.strictEqual(gh.calls.created.length, 0);
  assert.strictEqual(store.readTriage(dir).issue.number, 5);
});

test('skip: records skipped, files nothing', async () => {
  const users = tmpDir(); const data = tmpDir();
  const dir = writeReport(users, 'eve', '2026-09-27-test');
  const gh = fakeGh([]);
  await run({ usersRoot: users, dataDir: data, gh, targetRepoDir: targetRepo(), agent: agentWriting({ ...NEW, action: 'skip', scenario: { match: 'none' } }), logger: { log() {}, warn() {}, error() {} } });
  assert.strictEqual(gh.calls.created.length, 0);
  assert.strictEqual(store.readTriage(dir).status, 'skipped');
});

test('dry-run touches nothing', async () => {
  const users = tmpDir();
  writeReport(users, 'alice', '2026-09-27-a');
  const r = await run({ usersRoot: users, dataDir: tmpDir(), dryRun: true, token: null });
  assert.strictEqual(r.done[0].status, 'dry-run');
});

test('validateDecision rejects a new issue without body and normalizes scenario path', () => {
  assert.throws(() => D.validateDecision({ ...NEW, body: '' }), /body/);
  const d = D.validateDecision({ ...NEW, scenario: { path: 'docs/user-scenarios/recruiter/04-cold-search.md', match: 'weird' } });
  assert.strictEqual(d.scenario.path, 'recruiter/04-cold-search.md');
  assert.strictEqual(d.scenario.match, 'none');
  assert.strictEqual(D.validateDecision('```json\n' + JSON.stringify(NEW) + '\n```').title, NEW.title);
});
