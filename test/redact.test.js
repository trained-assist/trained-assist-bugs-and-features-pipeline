'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redact } = require('../src/redact');

test('masks e-mails, phones and tokens but keeps ordinary text and issue refs', () => {
  const s = redact('пиши ivan.petrov@mail.ru или +7 (999) 123-45-67, токен ghp_abcdefghijklmnopqrstuvwxyz0123 и 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawE; см #1195, 2026-09-27, вакансия 12345');
  assert.ok(!s.includes('ivan.petrov@mail.ru'));
  assert.ok(!s.includes('123-45-67'));
  assert.ok(!s.includes('ghp_'));
  assert.ok(!s.includes('AAHdqTcv'));
  assert.ok(s.includes('#1195'));
  assert.ok(s.includes('2026-09-27'));
  assert.ok(s.includes('вакансия 12345'));
});
