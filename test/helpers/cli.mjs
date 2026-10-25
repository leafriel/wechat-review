import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function startCli(directory, question, { cwd } = {}) {
  const env = { ...process.env, WECHAT_QUESTION_STATE_DIR: directory };
  // No host-provided conversation variables are required by the CLI.
  delete env.CODEX_THREAD_ID;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url)), 'ask'], {
    cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not finish')); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal || code === null) return resolve({ status: 'disconnected' });
      try { assert.equal(code, 0, stderr || stdout); resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
  });
  child.stdin.write(JSON.stringify(question) + '\n');
  return { child, done };
}
