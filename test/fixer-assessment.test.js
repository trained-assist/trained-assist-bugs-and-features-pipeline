'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/fixer-assessment');

const OK = { scope: 'in', scenario: 'recruiter/04-cold-search.md', size: 'S', ambiguity: 'low', fixable: true, summary: 's', plan: ['a'], reason: 'r' };

test('auto only when in scope, XS/S, low ambiguity and fixable', () => {
  assert.strictEqual(A.decide(A.validateAssessment(OK)).auto, true);
  for (const bad of [{ scope: 'out' }, { size: 'M' }, { ambiguity: 'medium' }, { fixable: false }]) {
    const v = A.decide(A.validateAssessment({ ...OK, ...bad }));
    assert.strictEqual(v.auto, false, JSON.stringify(bad));
    assert.ok(v.why.length === 1);
  }
});

test('labels: size/ambiguity/scope/verdict, needs-architect on high ambiguity; stale owned labels replaced', () => {
  const a = A.validateAssessment({ ...OK, size: 'L', ambiguity: 'high' });
  const next = A.labelsFor(a, A.decide(a));
  assert.deepStrictEqual(next, ['size:L', 'ambiguity:high', 'scope:in', 'fixer:needs-human', 'needs-architect']);
  assert.deepStrictEqual(A.staleLabels(['bug', 'size:S', 'fixer:auto', 'fixer:retry', 'ambiguity:high'], next), ['size:S', 'fixer:auto', 'fixer:retry']);
});

test('invalid assessments throw', () => {
  assert.throws(() => A.validateAssessment({ ...OK, size: 'huge' }), /size/);
  assert.throws(() => A.validateAssessment({ ...OK, fixable: 'yes' }), /fixable/);
  assert.throws(() => A.validateAssessment('nope'));
});

test('skip rules: closed, PR, skip labels unless forced', () => {
  const issue = { state: 'open' };
  assert.strictEqual(A.shouldSkip({ issue: { state: 'closed' }, labels: [] }), 'issue закрыт');
  assert.match(A.shouldSkip({ issue, labels: ['needs-architect'] }), /needs-architect/);
  assert.strictEqual(A.shouldSkip({ issue, labels: ['needs-architect'], force: true }), null);
  assert.strictEqual(A.shouldSkip({ issue, labels: ['bug'] }), null);
});

test('PR body closes the issue and carries the idempotency marker', () => {
  const body = A.renderPrBody({ issue: { number: 12 }, a: A.validateAssessment(OK), attempts: 1, draft: true });
  assert.ok(body.includes('Closes #12'));
  assert.ok(body.includes(A.PR_MARKER(12)));
  assert.ok(body.includes('Ready for review'));
});
