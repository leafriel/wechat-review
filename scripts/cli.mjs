import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askQuestion } from '../src/broker-client.mjs';
import { StateStore } from '../src/state.mjs';
import { questionSchema } from '../src/schema.mjs';

const failure = error => ({ status: 'error', sent: false,
  message: error.issues ? error.issues.map(issue => issue.message).join('；') : error.message });

// First JSON line starts immediately; subsequent "cancel" affects only this call.
export function askFromStream(input, { ask = askQuestion, signal } = {}) {
  const controller = new AbortController();
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  return new Promise(resolve => {
    let started = false;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      input.removeListener('error', onError);
      lines.close();
      resolve(result);
    };
    const cancel = () => { controller.abort(); finish({ status: 'cancelled', ...(!started ? { sent: false } : {}) }); };
    const onError = error => { controller.abort(); finish(failure(error)); };
    input.on('error', onError);
    lines.on('error', onError);
    lines.on('close', () => { if (!started) finish(failure(new Error('stdin 首行必须包含问题 JSON。'))); });
    lines.on('line', line => {
      if (settled) return;
      if (started) { if (line.trim() === 'cancel') cancel(); return; }
      started = true;
      let question;
      try {
        if (Buffer.byteLength(line) > 65536) throw new Error('问题 JSON 超过 64 KiB。');
        question = questionSchema.parse({ allow_text: false, ...JSON.parse(line) });
      } catch (error) { finish(failure(error)); return; }
      Promise.resolve().then(() => ask(question, { signal: controller.signal })).then(finish, error => finish(failure(error)));
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function main() {
  const mode = process.argv[2] ?? 'status';
  if (!['ask', 'status', 'login'].includes(mode)) throw new Error('用法：node scripts/cli.mjs ask|status|login [--force]');
  if (process.platform !== 'win32') throw new Error('此微信审核 Skill 需要 Windows DPAPI；当前仅支持 Windows。');
  if (mode === 'login') { await import('../src/login.mjs'); return; }
  let result;
  if (mode === 'status') {
    const account = new StateStore().read();
    result = { connected: !!(account?.token && account.ownerId && account.contextToken), logged_in: !!account?.token,
      owner_bound: !!account?.ownerId, context_ready: !!account?.contextToken };
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try { result = await askFromStream(process.stdin, { signal: controller.signal }); }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    process.stdin.destroy();
  }
  console.log(JSON.stringify(result));
  if (result.status === 'error') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.log(JSON.stringify(failure(error))); process.exitCode = 1; });
}
