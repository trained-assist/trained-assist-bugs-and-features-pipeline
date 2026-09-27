'use strict';
// Pure logic of stage 2: validate the agent's decision.json and render what the code
// then does on GitHub. No I/O here — everything is unit-tested.

const { redact } = require('./redact');

const MARKER = (profile, id) => `<!-- bugs-and-features:${profile}/${id} -->`;
const PIPELINE_LABEL = 'from-bugs-pipeline';
const MATCHES = ['existing', 'extends', 'new', 'none'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

function extractJson(raw) {
  const text = String(raw || '');
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Normalized decision or throws with a message that is fed back to the agent on retry.
// `knownIssues` = Set of issue numbers from the snapshot: a duplicate must point at a
// real issue, otherwise it's downgraded to `new` (a report is never swallowed).
function validateDecision(raw, { knownIssues = new Set() } = {}) {
  const d = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!d || typeof d !== 'object') throw new Error('decision.json is not an object');
  const action = ['new', 'duplicate', 'skip'].includes(d.action) ? d.action : null;
  if (!action) throw new Error('action must be new|duplicate|skip');
  const kind = d.kind === 'feature' ? 'feature' : d.kind === 'bug' ? 'bug' : null;
  if (!kind) throw new Error('kind must be bug|feature');
  const title = String(d.title || '').trim();
  if (title.length < 3) throw new Error('title is required');
  const sc = d.scenario && typeof d.scenario === 'object' ? d.scenario : {};
  const scenario = {
    path: typeof sc.path === 'string' && sc.path.trim() ? sc.path.trim().replace(/^docs\/user-scenarios\//, '') : null,
    match: MATCHES.includes(sc.match) ? sc.match : 'none',
    note: String(sc.note || ''),
  };
  const out = {
    action,
    duplicate_of: null,
    kind,
    title: title.slice(0, 140),
    body: String(d.body || ''),
    scenario,
    area: slug(d.area) || (scenario.path ? slug(scenario.path.split('/')[0]) : ''),
    severity: SEVERITIES.includes(d.severity) ? d.severity : null,
    reason: String(d.reason || ''),
  };
  if (action === 'duplicate') {
    const n = Number(d.duplicate_of);
    if (Number.isInteger(n) && knownIssues.has(n)) out.duplicate_of = n;
    else { out.action = 'new'; out.reason = `${out.reason} [duplicate_of=${d.duplicate_of} не найден в выгрузке — заведён как новый]`.trim(); }
  }
  if (out.action === 'new' && out.body.trim().length < 20) throw new Error('body is required for a new issue (markdown, по-русски)');
  return out;
}

function scenarioLine(scenario) {
  if (!scenario || !scenario.path) return 'не найден — вероятно, новый сценарий';
  const label = { existing: 'существующий', extends: 'расширяет существующий', new: 'новый', none: '—' }[scenario.match] || scenario.match;
  return `\`docs/user-scenarios/${scenario.path}\` (${label})${scenario.note ? ` — ${scenario.note}` : ''}`;
}

function userWordsBlock(report) {
  const words = report.userWords || report.summary || '';
  const lines = ['<details><summary>Слова пользователя (как есть)</summary>', '', redact(words).slice(0, 6000)];
  if (report.transcript) lines.push('', '---', '', redact(report.transcript).slice(0, 6000));
  lines.push('', '</details>');
  return lines.join('\n');
}

function footer({ profile, id, report }) {
  return [
    '',
    '---',
    `**Источник:** Bugs & Features · профиль \`${profile}\` · отчёт \`${id}\`` +
      `${report.raw && report.raw.reporter && report.raw.reporter.channel ? ` · канал ${report.raw.reporter.channel}` : ''}`,
    report.attachments.length ? `Вложения (лежат в папке отчёта на VM): ${report.attachments.join(', ')}` : '',
    '_Заведено автоматически: [trained-assist-bugs-and-features-pipeline](https://github.com/trained-assist/trained-assist-bugs-and-features-pipeline)._',
  ].filter(Boolean).join('\n');
}

function renderIssue({ decision, report, profile, id }) {
  const body = [
    MARKER(profile, id),
    '',
    `**Тип:** ${decision.kind === 'feature' ? 'фича' : 'баг'}` +
      `${decision.severity ? ` · **важность:** ${decision.severity}` : ''}` +
      `${decision.area ? ` · **область:** ${decision.area}` : ''}`,
    `**Сценарий:** ${scenarioLine(decision.scenario)}`,
    '',
    redact(decision.body),
    '',
    userWordsBlock(report),
    footer({ profile, id, report }),
  ].join('\n');
  const labels = [decision.kind, PIPELINE_LABEL];
  if (decision.area) labels.push(`area:${decision.area}`);
  return { title: redact(decision.title), body, labels };
}

function renderDuplicateComment({ decision, report, profile, id }) {
  return [
    MARKER(profile, id),
    '',
    `🔁 **Ещё один отчёт о том же** (пайплайн Bugs & Features посчитал его дублем).`,
    decision.reason ? `\n${redact(decision.reason)}` : '',
    '',
    `**Отчёт:** ${redact(report.title)}`,
    '',
    userWordsBlock(report),
    footer({ profile, id, report }),
  ].join('\n');
}

// Template issue when the agent failed MAX_ATTEMPTS times — a report is never dropped.
function fallbackIssue({ report, profile, id, lastError }) {
  const body = [
    MARKER(profile, id),
    '',
    `**Тип:** ${report.kind === 'feature' ? 'фича' : 'баг'} · **Сценарий:** не определён (триаж-агент не справился)`,
    '',
    '### Что сообщил пользователь',
    redact(report.summary || '(нет summary)'),
    '',
    userWordsBlock(report),
    '',
    lastError ? `<details><summary>Почему шаблон</summary>\n\n${String(lastError).slice(0, 1500)}\n\n</details>` : '',
    footer({ profile, id, report }),
  ].join('\n');
  return {
    title: `[${report.kind}] ${redact(report.title)}`.slice(0, 140),
    body,
    labels: [report.kind, PIPELINE_LABEL, 'needs-triage'],
  };
}

module.exports = {
  MARKER, PIPELINE_LABEL, extractJson, validateDecision,
  renderIssue, renderDuplicateComment, fallbackIssue, scenarioLine,
};
