'use strict';
// One place that spawns the agent. Today: local `opencode run` against the llm-ladder
// provider (opencode/ladder.json). Tomorrow: a serverless agent — swap this module only.
//
// Gotcha verified on the VM (2026-09-27): `opencode run` blocks forever on an open stdin,
// so stdin is always 'ignore'.

const { spawn } = require('child_process');
const path = require('path');

const MODEL = process.env.PIPELINE_OPENCODE_MODEL || 'ladder/deepseek';
const CONFIG = process.env.PIPELINE_OPENCODE_CONFIG || path.join(__dirname, '..', 'opencode', 'ladder.json');
const TIMEOUT_MS = Number(process.env.PIPELINE_AGENT_TIMEOUT_MS || 15 * 60 * 1000);

// Resolves { code, output } — never rejects on a non-zero exit (caller validates the
// file the agent was asked to write, which is the real success signal).
function runAgent({ cwd, prompt, model = MODEL, timeoutMs = TIMEOUT_MS, env = {}, bin = 'opencode' }) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['run', '-m', model, '--dir', cwd, prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_CONFIG: CONFIG, ...env },
    });
    let output = '';
    const keep = (b) => { output = (output + b.toString()).slice(-20_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { keep(`\n[pipeline] agent timed out after ${timeoutMs} ms\n`); child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: `${output}\n[pipeline] spawn failed: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

module.exports = { runAgent, MODEL, CONFIG };
