'use strict';
// Pure logic of stage 3: validate the assess agent's verdict, apply the conservative
// rule, compute labels and render the verdict comment. No I/O — unit-tested.

const { extractJson } = require('./triage-decision');

const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const AMBIGUITY = ['low', 'medium', 'high'];
const ASSESS_MARKER = '<!-- bf-fixer:assessment -->';
const PR_MARKER = (n) => `<!-- bf-fixer:issue-${n} -->`;

// Labels that stop the fixer unless the run is forced (fixer:retry / workflow_dispatch).
const SKIP_LABELS = ['needs-architect', 'epic', 'fixer:skip', 'fixer:pr-opened'];
// Labels this stage owns — stale ones from an earlier assessment are replaced.
const OWNED_PREFIXES = ['size:', 'ambiguity:', 'scope:'];
const OWNED_LABELS = ['fixer:auto', 'fixer:needs-human', 'fixer:failed', 'fixer:retry'];

function validateAssessment(raw) {
  const a = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!a || typeof a !== 'object') throw new Error('assessment is not an object');
  const scope = a.scope === 'in' ? 'in' : a.scope === 'out' ? 'out' : null;
  if (!scope) throw new Error('scope must be in|out');
  const size = SIZES.includes(String(a.size).toUpperCase()) ? String(a.size).toUpperCase() : null;
  if (!size) throw new Error('size must be XS|S|M|L|XL');
  const ambiguity = AMBIGUITY.includes(a.ambiguity) ? a.ambiguity : null;
  if (!ambiguity) throw new Error('ambiguity must be low|medium|high');
  if (typeof a.fixable !== 'boolean') throw new Error('fixable must be boolean');
  return {
    scope, size, ambiguity, fixable: a.fixable,
    scenario: typeof a.scenario === 'string' && a.scenario.trim() ? a.scenario.trim() : null,
    summary: String(a.summary || ''),
    plan: Array.isArray(a.plan) ? a.plan.map(String).filter(Boolean).slice(0, 15) : [],
    reason: String(a.reason || ''),
  };
}

// Conservative rule, in code (the model can only downgrade, never upgrade):
// auto only when in scope AND small AND unambiguous AND the model says fixable.
function decide(a) {
  const why = [];
  if (a.scope !== 'in') why.push('вне скоупа сценариев');
  if (!['XS', 'S'].includes(a.size)) why.push(`размер ${a.size} (авто — только XS/S)`);
  if (a.ambiguity !== 'low') why.push(`неоднозначность ${a.ambiguity}`);
  if (!a.fixable) why.push('агент считает, что без человека не сделать');
  return { auto: why.length === 0, why };
}

function labelsFor(a, verdict) {
  const labels = [`size:${a.size}`, `ambiguity:${a.ambiguity}`, `scope:${a.scope}`, verdict.auto ? 'fixer:auto' : 'fixer:needs-human'];
  if (a.ambiguity === 'high') labels.push('needs-architect');
  return labels;
}

// Current labels that must go before `next` is applied (stale owned labels).
function staleLabels(current, next) {
  return current.filter(l =>
    !next.includes(l) &&
    (OWNED_LABELS.includes(l) || OWNED_PREFIXES.some(p => l.startsWith(p))));
}

function shouldSkip({ issue, labels, force }) {
  if (issue.state !== 'open') return 'issue закрыт';
  if (issue.pull_request) return 'это PR, не issue';
  if (force) return null;
  const hit = labels.find(l => SKIP_LABELS.includes(l));
  return hit ? `лейбл ${hit}` : null;
}

function renderVerdictComment(a, verdict, { model, execute }) {
  const lines = [
    ASSESS_MARKER,
    `🤖 **Фиксер: оценка** — ${verdict.auto ? '✅ беру в работу, готовлю PR' : '👤 нужен человек'}`,
    '',
    `| скоуп | сценарий | размер | неоднозначность |`,
    `|---|---|---|---|`,
    `| ${a.scope} | ${a.scenario ? `\`${a.scenario}\`` : '—'} | ${a.size} | ${a.ambiguity} |`,
    '',
    a.summary ? `**Суть:** ${a.summary}` : '',
    a.reason ? `**Почему:** ${a.reason}` : '',
    verdict.auto ? '' : `**Не автоматом, потому что:** ${verdict.why.join('; ')}.`,
    a.plan.length ? `\n**План:**\n${a.plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    '',
    `_Модель: ${model}. Перезапуск — лейбл \`fixer:retry\`._${verdict.auto && !execute ? ' _(исполнение выключено — только оценка)_' : ''}`,
  ];
  return lines.filter(l => l !== '').join('\n');
}

function renderPrBody({ issue, a, attempts, draft }) {
  return [
    PR_MARKER(issue.number),
    `Closes #${issue.number}`,
    '',
    `Автоматический фикс от [bugs-and-features-pipeline](https://github.com/trained-assist/trained-assist-bugs-and-features-pipeline) (стадия «Фиксер»).`,
    '',
    a.summary ? `**Суть:** ${a.summary}` : '',
    a.scenario ? `**Сценарий:** \`${a.scenario}\`` : '',
    a.plan.length ? `\n**План:**\n${a.plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    '',
    `Проверено локально в раннере (попыток: ${attempts}).`,
    draft ? '\n**Draft**: проверь дифф и нажми «Ready for review» — после этого CI смёржит PR сам.' : '',
    '',
    '🤖 Generated with [trained-assist-bugs-and-features-pipeline](https://github.com/trained-assist/trained-assist-bugs-and-features-pipeline)',
  ].filter(l => l !== '').join('\n');
}

module.exports = {
  SIZES, AMBIGUITY, ASSESS_MARKER, PR_MARKER, SKIP_LABELS,
  validateAssessment, decide, labelsFor, staleLabels, shouldSkip,
  renderVerdictComment, renderPrBody,
};
