'use strict';
// Issues land in a PUBLIC repo. The triage agent is told not to carry personal data over;
// this is the belt-and-braces pass in code: e-mails, phone numbers, token-looking strings.

const RULES = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email скрыт]'],
  // +7 999 123-45-67, 8(999)1234567, +44 20 7946 0958 … — 10+ digits with separators.
  [/(?<![\w/])\+?\d[\d\s().-]{8,}\d(?![\w/])/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[телефон скрыт]' : m)],
  // Well-known token shapes + long opaque secrets.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|\d{8,10}:[A-Za-z0-9_-]{30,})\b/g, '[токен скрыт]'],
  [/\b(?=[A-Za-z0-9_-]{40,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]+\b/g, '[токен скрыт]'],
];

function redact(text) {
  let s = String(text || '');
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

module.exports = { redact };
