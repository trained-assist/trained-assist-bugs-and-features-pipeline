'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { main } = require('../src/fixer');
const A = require('../src/fixer-assessment');
const { tmpDir, fakeGh } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

function repoWithOrigin() {
  const origin = tmpDir('bf-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const work = tmpDir('bf-work-');
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'app.js'), 'module.exports = 1;\n');
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  return { origin, work };
}

function ghFor(issue) {
  const gh = fakeGh([]);
  gh.getIssue = async () => issue;
  gh.listComments = async () => [];
  gh.createPr = async (x) => { gh.calls.pr = x; return { html_url: 'https://github.com/o/r/pull/1' }; };
  return gh;
}

// Agent: the assess prompt names the output file; the execute prompt edits app.js.
function agent({ assessment, edit = (cwd) => fs.writeFileSync(path.join(cwd, 'app.js'), 'module.exports = 2;\n') }) {
  return async ({ cwd, prompt }) => {
    const m = prompt.match(/JSON-файл `([^`]+)`/);
    if (m) fs.writeFileSync(m[1], JSON.stringify(assessment));
    else edit(cwd);
    return { code: 0, output: 'готово' };
  };
}

const ISSUE = { number: 12, state: 'open', title: 'Сломан расчёт', body: 'repro…', labels: [{ name: 'bug' }] };
const AUTO = { scope: 'in', scenario: 'core/01.md', size: 'XS', ambiguity: 'low', fixable: true, summary: 'поправить', plan: ['app.js'], reason: 'r' };

test('needs-human: labels + verdict comment, no branch, no PR', async () => {
  const { work } = repoWithOrigin();
  const gh = ghFor(ISSUE);
  const r = await main({ env: { TARGET_REPO: 'o/r', ISSUE_NUMBER: '12', TARGET_DIR: work, RUNNER_TEMP: tmpDir() }, gh, logger: quiet,
    agent: agent({ assessment: { ...AUTO, size: 'L' } }) });
  assert.strictEqual(r.status, 'needs-human');
  assert.ok(gh.calls.labels[0].labels.includes('fixer:needs-human'));
  assert.ok(gh.calls.comments[0].body.includes(A.ASSESS_MARKER));
  assert.strictEqual(gh.calls.pr, undefined);
});

test('auto: edits, verifies, pushes a fixer branch and opens a DRAFT PR', async () => {
  const { origin, work } = repoWithOrigin();
  const gh = ghFor(ISSUE);
  const r = await main({ env: { TARGET_REPO: 'o/r', ISSUE_NUMBER: '12', TARGET_DIR: work, RUNNER_TEMP: tmpDir(), VERIFY_CMD: 'grep -q 2 app.js' }, gh, logger: quiet,
    agent: agent({ assessment: AUTO }) });
  assert.strictEqual(r.status, 'pr-opened');
  assert.strictEqual(gh.calls.pr.draft, true);
  assert.ok(gh.calls.pr.body.includes('Closes #12'));
  assert.match(git(origin, 'branch', '--list', 'fixer/issue-12-*'), /fixer\/issue-12-/);
  assert.ok(gh.calls.labels.some(l => l.labels.includes('fixer:pr-opened')));
});

test('auto but verify keeps failing → fixer:failed after 3 attempts, nothing pushed', async () => {
  const { origin, work } = repoWithOrigin();
  const gh = ghFor(ISSUE);
  const r = await main({ env: { TARGET_REPO: 'o/r', ISSUE_NUMBER: '12', TARGET_DIR: work, RUNNER_TEMP: tmpDir(), VERIFY_CMD: 'false' }, gh, logger: quiet,
    agent: agent({ assessment: AUTO }) });
  assert.strictEqual(r.status, 'failed');
  assert.ok(gh.calls.labels.some(l => l.labels.includes('fixer:failed')));
  assert.strictEqual(git(origin, 'branch', '--list', 'fixer/*').trim(), '');
});

test('edits to .github/ are reverted; a protected-only change is not a fix', async () => {
  const { work } = repoWithOrigin();
  const gh = ghFor(ISSUE);
  const r = await main({ env: { TARGET_REPO: 'o/r', ISSUE_NUMBER: '12', TARGET_DIR: work, RUNNER_TEMP: tmpDir(), VERIFY_CMD: 'true' }, gh, logger: quiet,
    agent: agent({ assessment: AUTO, edit: (cwd) => { fs.mkdirSync(path.join(cwd, '.github'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.github', 'x.yml'), 'x'); } }) });
  assert.strictEqual(r.status, 'failed');
  assert.ok(!fs.existsSync(path.join(work, '.github', 'x.yml')));
});

test('skip label stops the run before any agent call; open PR with marker too', async () => {
  let called = false;
  const gh = ghFor({ ...ISSUE, labels: [{ name: 'needs-architect' }] });
  const r = await main({ env: { TARGET_REPO: 'o/r', ISSUE_NUMBER: '12', TARGET_DIR: tmpDir() }, gh, logger: quiet, agent: async () => { called = true; } });
  assert.strictEqual(r.status, 'skipped');
  const gh2 = ghFor(ISSUE);
  gh2.findByMarker = async () => ({ number: 3, url: 'u' });
  const r2 = await main({ env: { TARGET_REPO: 'o/r', ISSUE_NUMBER: '12', TARGET_DIR: tmpDir() }, gh: gh2, logger: quiet, agent: async () => { called = true; } });
  assert.strictEqual(r2.status, 'skipped');
  assert.strictEqual(called, false);
});
