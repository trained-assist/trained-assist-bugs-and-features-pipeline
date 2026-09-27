'use strict';
// Stage 3 — fixer. Runs inside GitHub Actions (reusable workflow fix-issue.yml) on an
// `issues` event of the target repo, with the target repo checked out in TARGET_DIR.
//   assess (agent, read-only) → labels + verdict comment
//   if auto: execute (agent edits) → verify ×3 → push → draft PR «Closes #N»
//
// Env: GH_TOKEN (PAT — a GITHUB_TOKEN-created PR would not trigger CI), LLM_LADDER_TOKEN,
//      TARGET_REPO, ISSUE_NUMBER, TARGET_DIR, BASE_BRANCH, VERIFY_CMD, DRAFT_PR, FORCE,
//      EXECUTE (false = assess only).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { client } = require('./github');
const { runAgent, MODEL } = require('./opencode');
const A = require('./fixer-assessment');

const MAX_ATTEMPTS = 3;
const PROTECTED = [/^\.github\//, /^secrets/i, /\.env$/];

function sh(cwd, cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8', timeout: 120_000, ...opts });
}

function changedFiles(cwd) {
  return sh(cwd, 'git', ['status', '--porcelain']).split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, ''));
}

function discardChanges(cwd) {
  sh(cwd, 'git', ['checkout', '--', '.']);
  sh(cwd, 'git', ['clean', '-fdq']);
}

function issueContext(issue, comments) {
  const own = comments.filter(c => !String(c.body || '').includes(A.ASSESS_MARKER));
  return [
    `# Issue #${issue.number}: ${issue.title}`,
    `labels: ${(issue.labels || []).map(l => l.name || l).join(', ') || '—'}`,
    '',
    String(issue.body || '(пусто)').slice(0, 12000),
    own.length ? '\n## Комментарии' : '',
    ...own.slice(-10).map(c => `\n### ${c.user && c.user.login}\n${String(c.body || '').slice(0, 3000)}`),
  ].join('\n');
}

function assessTask({ ctx, out, repo }) {
  return `# Задача: оценить issue для автоматического исправления

Ты — оценщик в репо \`${repo}\` (текущая папка — его код). НИЧЕГО не меняй в репо: только читай.
Результат — JSON-файл \`${out}\`.

${ctx}

## Как оценивать
1. Прочитай \`docs/user-scenarios/GOALS.md\` (цели, что в скоупе и что вне) и сценарии
   \`docs/user-scenarios/<домен>/*.md\`. Найди сценарий, к которому относится issue.
   \`scope: "in"\` — только если issue ломает/улучшает существующий сценарий и не попадает в «Вне скоупа».
2. Найди в коде, где это чинится/делается. Оцени размер:
   XS — одна маленькая правка; S — несколько правок в 1–2 файлах + тест; M — несколько модулей;
   L/XL — много модулей или архитектура.
3. \`ambiguity\`: low — понятно, что именно сделать и как проверить; medium — есть 1–2 решения,
   которые надо принять за автора; high — нужны решения архитектора.
4. \`fixable: true\` — только если ты уверен, что сделаешь это сам без вопросов и проверишь тестом.

Запиши в \`${out}\` ТОЛЬКО JSON:
\`\`\`json
{ "scope": "in|out", "scenario": "recruiter/04-cold-search.md или null", "size": "XS|S|M|L|XL",
  "ambiguity": "low|medium|high", "fixable": true, "summary": "суть одной фразой",
  "plan": ["шаг 1 (файл: что меняем)", "…", "тест: что проверяем"], "reason": "почему так" }
\`\`\`
Когда файл записан — ответь «готово».`;
}

function executeTask({ ctx, a, previousFailure, verifyCmd }) {
  return `# Задача: исправить issue (ты — разработчик в этом репо)

${ctx}

## Оценка и план
- Сценарий: ${a.scenario || '—'}
- Суть: ${a.summary}
${a.plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Жёсткие правила
- Минимальный дифф, только то, что нужно для issue. Стиль — как в окружающем коде.
- Добавь или обнови тест, который падал бы без фикса.
- НЕ трогай \`.github/\`, секреты, \`.env\`, lock-файлы (если не нужно для фикса), деплой-скрипты.
- Не делай git commit/push — это сделает пайплайн.
- Проверка, которую запустит пайплайн: \`${verifyCmd}\`. Можешь запускать её сам.
${previousFailure ? `\n## Прошлая попытка не прошла проверку\nИсправь причину:\n\`\`\`\n${previousFailure}\n\`\`\`\n` : ''}
Когда закончишь — ответь «готово».`;
}

function verify(cwd, cmd) {
  const r = spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  return { ok: r.status === 0, tail: out.slice(-4000) };
}

async function main({
  env = process.env, agent = runAgent, gh = null, logger = console,
} = {}) {
  const repo = env.TARGET_REPO;
  const number = Number(env.ISSUE_NUMBER);
  const cwd = env.TARGET_DIR || process.cwd();
  const base = env.BASE_BRANCH || 'main';
  const verifyCmd = env.VERIFY_CMD || 'npm test';
  const draft = env.DRAFT_PR !== 'false';
  const force = env.FORCE === 'true';
  const execute = env.EXECUTE !== 'false';
  const tmp = env.RUNNER_TEMP || os.tmpdir();
  if (!repo || !number) throw new Error('TARGET_REPO and ISSUE_NUMBER are required');
  gh = gh || client({ token: env.GH_TOKEN, repo });

  const issue = await gh.getIssue(number);
  const labels = (issue.labels || []).map(l => l.name || l);
  const skip = A.shouldSkip({ issue, labels, force });
  if (skip) { logger.log(`[fixer] #${number}: skip — ${skip}`); return { status: 'skipped', reason: skip }; }
  const openPr = await gh.findByMarker(A.PR_MARKER(number), { type: 'pr', state: 'open' }).catch(() => null);
  if (openPr) { logger.log(`[fixer] #${number}: open PR already exists ${openPr.url}`); return { status: 'skipped', reason: 'PR уже открыт' }; }

  const ctx = issueContext(issue, await gh.listComments(number));

  // ── assess ──
  const assessOut = path.join(tmp, `assessment-${number}.json`);
  let a = null;
  let err = '';
  for (let i = 0; i < 2 && !a; i++) {
    fs.rmSync(assessOut, { force: true });
    const r = await agent({ cwd, prompt: assessTask({ ctx, out: assessOut, repo }) });
    try { a = A.validateAssessment(fs.readFileSync(assessOut, 'utf8')); } catch (e) { err = `${e.message}\n${String(r.output).slice(-1500)}`; }
    if (changedFiles(cwd).length) discardChanges(cwd); // read-only step — drop accidental edits
  }
  if (!a) {
    await gh.comment(number, `${A.ASSESS_MARKER}\n🤖 **Фиксер:** не смог оценить issue (агент не вернул валидный вердикт). Перезапуск — лейбл \`fixer:retry\`.\n\n<details><summary>лог</summary>\n\n\`\`\`\n${err.slice(-2500)}\n\`\`\`\n</details>`);
    await gh.addLabels(number, ['fixer:failed']);
    return { status: 'assess-failed' };
  }
  const verdict = A.decide(a);
  const next = A.labelsFor(a, verdict);
  for (const l of A.staleLabels(labels, next)) await gh.removeLabel(number, l);
  await gh.addLabels(number, next);
  await gh.comment(number, A.renderVerdictComment(a, verdict, { model: MODEL, execute }));
  logger.log(`[fixer] #${number}: ${verdict.auto ? 'auto' : `needs-human (${verdict.why.join('; ')})`}`);
  if (!verdict.auto || !execute) return { status: verdict.auto ? 'assessed-auto' : 'needs-human', assessment: a };

  // ── execute ──
  const branch = `fixer/issue-${number}-${Math.floor(Date.now() / 1000)}`;
  sh(cwd, 'git', ['checkout', '-b', branch]);
  let failure = null;
  let attempts = 0;
  let ok = false;
  for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
    await agent({ cwd, prompt: executeTask({ ctx, a, previousFailure: failure, verifyCmd }) });
    const files = changedFiles(cwd);
    const touched = files.filter(f => PROTECTED.some(re => re.test(f)));
    for (const f of touched) {
      try { sh(cwd, 'git', ['checkout', '--', f]); } catch { fs.rmSync(path.join(cwd, f), { recursive: true, force: true }); }
    }
    if (changedFiles(cwd).length === 0) { failure = 'Изменений нет (или менялись только защищённые файлы). Нужен реальный фикс.'; continue; }
    const v = verify(cwd, verifyCmd);
    if (v.ok) { ok = true; break; }
    failure = v.tail;
    logger.warn(`[fixer] #${number}: attempt ${attempts} failed verify`);
  }
  if (!ok) {
    await gh.addLabels(number, ['fixer:failed']);
    await gh.comment(number, `🤖 **Фиксер:** не смог сделать зелёный фикс за ${MAX_ATTEMPTS} попытки — нужен человек.\n\n<details><summary>последний лог</summary>\n\n\`\`\`\n${String(failure).slice(-3000)}\n\`\`\`\n</details>`);
    return { status: 'failed', attempts: MAX_ATTEMPTS };
  }

  sh(cwd, 'git', ['add', '-A']);
  sh(cwd, 'git', ['-c', 'user.name=trained-assist-fixer', '-c', 'user.email=fixer@trained-assist.invalid',
    'commit', '-m', `fix: ${issue.title} (#${number})\n\nAutomated by bugs-and-features-pipeline fixer.`]);
  // actions/checkout persisted GH_TOKEN (the PAT) as origin's credential — no token in argv.
  sh(cwd, 'git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { timeout: 300_000 });
  const pr = await gh.createPr({
    head: branch, base, draft,
    title: `fix: ${issue.title} (#${number})`.slice(0, 200),
    body: A.renderPrBody({ issue, a, attempts, draft }),
  });
  await gh.addLabels(number, ['fixer:pr-opened']);
  await gh.comment(number, `🤖 **Фиксер:** PR готов — ${pr.html_url}${draft ? ' (draft: посмотри и нажми «Ready for review»)' : ''}`);
  logger.log(`[fixer] #${number}: PR ${pr.html_url}`);
  return { status: 'pr-opened', pr: pr.html_url, attempts };
}

if (require.main === module) {
  main().then((r) => { console.log(`[fixer] result: ${JSON.stringify(r)}`); })
    .catch((e) => { console.error('[fixer] fatal:', e.message); process.exit(1); });
}

module.exports = { main, assessTask, executeTask, issueContext };
