'use strict';
// Stage 2 — triage. One pass over every user's bugs-and-features/reports/:
//   report → opencode agent (decision.json) → code files an issue / comments a duplicate
//          → triage.json back into the report folder.
// Run by ops/triage-cron.sh every 2 minutes on the GCP VM. The agent decides, the code
// acts: the agent never gets a GitHub token.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const store = require('./report-store-fs');
const { client } = require('./github');
const { runAgent, MODEL } = require('./opencode');
const {
  MARKER, validateDecision, renderIssue, renderDuplicateComment, fallbackIssue,
} = require('./triage-decision');

const REPO = process.env.BF_TARGET_REPO || 'trained-assist/trained-assist-agent';
const USERS_ROOT = process.env.USERS_DIR || path.join(os.homedir(), 'users');
const DATA_DIR = process.env.BF_DATA_DIR || path.join(os.homedir(), 'agent-data', 'bugs-and-features-pipeline');
const CLOSED_LOOKBACK_DAYS = 90;
const MAX_PER_PASS = Number(process.env.BF_MAX_PER_PASS || 5);

function githubToken() {
  if (process.env.GITHUB_ISSUES_TOKEN) return process.env.GITHUB_ISSUES_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  return null;
}

// ── Workspace ────────────────────────────────────────────────────────────────

// Shallow clone of the target repo, refreshed once per pass: docs/user-scenarios + code.
function refreshTargetRepo(dataDir, repo = REPO) {
  const dir = path.join(dataDir, 'target-repo');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', timeout: 120_000 });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dataDir, { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, dir], { stdio: 'pipe', timeout: 300_000 });
  } else {
    git('fetch', '--depth', '1', 'origin', 'HEAD');
    git('reset', '--hard', 'FETCH_HEAD');
    git('clean', '-fdq');
  }
  return dir;
}

function issueFile(i) {
  const labels = (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)).join(', ');
  return [
    `# #${i.number} [${i.state}] ${i.title}`,
    `labels: ${labels || '—'} · created: ${String(i.created_at).slice(0, 10)}${i.closed_at ? ` · closed: ${String(i.closed_at).slice(0, 10)}` : ''}`,
    '',
    String(i.body || '').slice(0, 4000),
  ].join('\n');
}

// Open issues + issues closed in the last 90 days → issues/INDEX.md + issues/<n>.md.
async function snapshotIssues(gh, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const since = new Date(Date.now() - CLOSED_LOOKBACK_DAYS * 86400_000).toISOString();
  const open = await gh.listIssues({ state: 'open' });
  const closed = (await gh.listIssues({ state: 'closed', since, maxPages: 5 }))
    .filter(i => i.closed_at && i.closed_at >= since);
  const all = [...open, ...closed];
  const index = ['# Issues snapshot', `repo: ${gh.repo} · open: ${open.length} · closed ≤${CLOSED_LOOKBACK_DAYS}d: ${closed.length}`, ''];
  for (const i of all) {
    const labels = (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)).join(', ');
    index.push(`#${i.number} [${i.state}] ${i.title}${labels ? `  {${labels}}` : ''}`);
    fs.writeFileSync(path.join(dir, `${i.number}.md`), issueFile(i));
  }
  fs.writeFileSync(path.join(dir, 'INDEX.md'), index.join('\n') + '\n');
  return new Set(all.map(i => i.number));
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: false });
}

function buildTask({ repo, profile, id, previousError }) {
  return `# Задача: триаж отчёта пользователя (Bugs & Features)

Ты — триаж-агент продукта trained-assist (AI-агенты для пользователей в Telegram/вебе).
Пользователь \`${profile}\` оставил отчёт — баг или пожелание. Твоя работа — решить, что с ним
делать в GitHub-репо \`${repo}\`. Сам ты в GitHub НИЧЕГО не пишешь — только файл \`decision.json\`.

## Что лежит в этой папке
- \`report/\` — отчёт: \`report.json\` (что сообщили), возможно \`transcript.md\`, \`attachments/\`.
- \`scenarios/\` — пользовательские сценарии продукта (\`docs/user-scenarios\`): \`GOALS.md\`
  (цели и скоуп) + \`<домен>/<NN>-<slug>.md\`.
- \`issues/INDEX.md\` — все открытые issues и закрытые за 90 дней (номер, статус, заголовок, лейблы);
  \`issues/<N>.md\` — текст issue.
- \`repo/\` — код продукта (read-only; смотри, если нужно понять область или компонент).

## Шаги
1. Прочитай \`report/\`. Пойми, что случилось или что хотят, своими словами.
2. **Дубли.** Поищи в \`issues/\` (grep по ключевым словам, синонимам, компонентам). Дубль — это
   ТА ЖЕ проблема/просьба, а не просто та же область. Сомневаешься — это не дубль.
3. **Сценарий.** Как шаг «define-use-case» плейбука feature: сначала найди СУЩЕСТВУЮЩИЙ сценарий
   в \`scenarios/\`, к которому это относится (\`existing\` — ломает/касается его; \`extends\` —
   расширяет его). Только если такого нет — \`new\` (нужен новый сценарий) или \`none\`
   (к сценариям не относится: вопрос, мусор, тест).
4. **Действие:**
   - \`new\` — завести новый issue. Напиши \`body\` по-русски, так чтобы разработчик взял
     в работу без переспросов: «Что происходит / что нужно», «Кто и зачем» (без персональных
     данных — имён, телефонов, e-mail, токенов не переносить), «Шаги воспроизведения / ожидаемое /
     фактическое» (для бага, если видно), «Критерии готовности», «Где в коде смотреть» (если нашёл
     в \`repo/\`). Не выдумывай фактов — чего нет, помечай «уточнить».
   - \`duplicate\` — это уже есть в issue №N (открытом или недавно закрытом): \`duplicate_of: N\`,
     в \`reason\` — чем совпадает.
   - \`skip\` — только явный тест/мусор без содержания (например «проверка связи»).
5. Запиши \`decision.json\` в корень этой папки — ТОЛЬКО JSON:

\`\`\`json
{
  "action": "new | duplicate | skip",
  "duplicate_of": null,
  "kind": "bug | feature",
  "title": "краткий заголовок issue по-русски",
  "body": "markdown по-русски (для action=new)",
  "scenario": { "path": "recruiter/04-cold-search.md или null", "match": "existing | extends | new | none", "note": "одна фраза: как связано" },
  "area": "домен: recruiter | engineering | exhibition | freelance | core | …",
  "severity": "low | medium | high | critical",
  "reason": "почему такое решение"
}
\`\`\`

Не меняй ничего, кроме \`decision.json\`. Когда файл записан — ответь «готово».
${previousError ? `\n## Прошлая попытка отклонена\n${previousError}\nИсправь и перезапиши decision.json.\n` : ''}`;
}

function prepareWorkspace({ dataDir, targetRepoDir, issuesDir, report, previousError, repo }) {
  const ws = path.join(dataDir, 'work', `${report.profile}__${report.id}`);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  copyDir(report.dir, path.join(ws, 'report'));
  fs.rmSync(path.join(ws, 'report', 'triage.json'), { force: true });
  const scen = path.join(targetRepoDir, 'docs', 'user-scenarios');
  if (fs.existsSync(scen)) copyDir(scen, path.join(ws, 'scenarios'));
  copyDir(issuesDir, path.join(ws, 'issues'));
  fs.symlinkSync(targetRepoDir, path.join(ws, 'repo'));
  fs.writeFileSync(path.join(ws, 'TASK.md'), buildTask({ repo, profile: report.profile, id: report.id, previousError }));
  return ws;
}

// ── One report ───────────────────────────────────────────────────────────────

async function triageOne({ item, gh, knownIssues, dataDir, targetRepoDir, issuesDir, agent, repo, logger }) {
  const { profile, id, dir } = item;
  const report = store.readReport(dir);
  const prev = store.readTriage(dir);
  const attempts = (prev && prev.status === 'retrying' ? prev.attempts || 0 : 0) + 1;
  const marker = MARKER(profile, id);

  // Idempotency: state lost / crashed after creating the issue → adopt, don't duplicate.
  const existing = await gh.findByMarker(marker).catch(() => null);
  if (existing) {
    store.writeTriage(dir, { status: 'filed', issue: existing, attempts, reason: 'найден по маркеру (уже заведён ранее)' });
    return { profile, id, status: 'filed', issue: existing, adopted: true };
  }

  let decision = null;
  let lastError = prev && prev.reason;
  const ws = prepareWorkspace({ dataDir, targetRepoDir, issuesDir, report: { ...item }, previousError: prev && prev.status === 'retrying' ? prev.reason : null, repo });
  const prompt = 'Прочитай TASK.md в текущей папке и выполни его. Результат — файл decision.json.';
  const agentRun = await agent({ cwd: ws, prompt });
  try {
    const raw = fs.readFileSync(path.join(ws, 'decision.json'), 'utf8');
    decision = validateDecision(raw, { knownIssues });
  } catch (e) {
    lastError = `decision.json невалиден/отсутствует: ${e.message}. Хвост вывода агента:\n${String(agentRun.output).slice(-1500)}`;
  }

  if (!decision) {
    if (attempts < store.MAX_ATTEMPTS) {
      store.writeTriage(dir, { status: 'retrying', issue: null, attempts, reason: lastError });
      logger.warn(`[triage] ${profile}/${id}: attempt ${attempts} failed — will retry`);
      return { profile, id, status: 'retrying' };
    }
    const fb = fallbackIssue({ report, profile, id, lastError });
    const created = await gh.createIssue(fb);
    const issue = { number: created.number, url: created.html_url };
    store.writeTriage(dir, { status: 'filed-fallback', issue, attempts, kind: report.kind, reason: 'триаж-агент не справился — заведён шаблон' });
    return { profile, id, status: 'filed-fallback', issue };
  }

  const base = { attempts, kind: decision.kind, scenario: decision.scenario, reason: decision.reason, model: MODEL };
  if (decision.action === 'skip') {
    store.writeTriage(dir, { ...base, status: 'skipped', issue: null });
    return { profile, id, status: 'skipped' };
  }
  if (decision.action === 'duplicate') {
    const n = decision.duplicate_of;
    await gh.comment(n, renderDuplicateComment({ decision, report, profile, id }));
    const url = `https://github.com/${repo}/issues/${n}`;
    store.writeTriage(dir, { ...base, status: 'duplicate', issue: { number: n, url }, duplicateOf: n });
    return { profile, id, status: 'duplicate', issue: { number: n, url } };
  }
  const created = await gh.createIssue(renderIssue({ decision, report, profile, id }));
  const issue = { number: created.number, url: created.html_url };
  store.writeTriage(dir, { ...base, status: 'filed', issue });
  return { profile, id, status: 'filed', issue };
}

// ── Pass ─────────────────────────────────────────────────────────────────────

async function run({
  usersRoot = USERS_ROOT, dataDir = DATA_DIR, repo = REPO, token = githubToken(),
  dryRun = false, agent = runAgent, gh = null, targetRepoDir = null, logger = console,
  maxPerPass = MAX_PER_PASS, now = Date.now(),
} = {}) {
  const pending = store.listPending({ usersRoot, now }).slice(0, maxPerPass);
  const result = { pending: pending.length, done: [], errors: [] };
  if (pending.length === 0 || dryRun) {
    for (const p of pending) result.done.push({ ...p, status: 'dry-run' });
    return result;
  }
  if (!token && !gh) throw new Error('no GitHub token (GITHUB_ISSUES_TOKEN / GH_TOKEN)');
  gh = gh || client({ token, repo });
  const repoDir = targetRepoDir || refreshTargetRepo(dataDir, repo);
  const issuesDir = path.join(dataDir, 'issues-snapshot');
  const knownIssues = await snapshotIssues(gh, issuesDir);

  for (const item of pending) {
    try {
      const r = await triageOne({ item, gh, knownIssues, dataDir, targetRepoDir: repoDir, issuesDir, agent, repo, logger });
      result.done.push(r);
      logger.log(`[triage] ${item.profile}/${item.id} -> ${r.status}${r.issue ? ` ${r.issue.url}` : ''}`);
    } catch (e) {
      result.errors.push(`${item.profile}/${item.id}: ${e.message}`);
      logger.error(`[triage] ${item.profile}/${item.id} failed: ${e.message}`);
    }
  }
  return result;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun }).then((r) => {
    if (r.pending === 0) console.log('[triage] no reports pending.');
    else {
      console.log(`[triage] pending=${r.pending} done=${r.done.length} errors=${r.errors.length}${dryRun ? ' (dry-run)' : ''}`);
      for (const d of r.done) console.log(`  + ${d.profile}/${d.id} ${d.status}${d.issue ? ` ${d.issue.url}` : ''}`);
      for (const e of r.errors) console.log(`  ! ${e}`);
    }
  }).catch((e) => { console.error('[triage] fatal:', e.message); process.exit(1); });
}

module.exports = { run, triageOne, buildTask, prepareWorkspace, snapshotIssues, refreshTargetRepo };
