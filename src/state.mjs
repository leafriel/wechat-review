import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const stateDir = process.env.WECHAT_QUESTION_STATE_DIR || join(process.env.LOCALAPPDATA || homedir(), 'CodexWeChatQuestion');

function protect(text, mode) {
  if (process.platform !== 'win32') throw new Error('This credential store requires Windows DPAPI.');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./protect.ps1', import.meta.url)), mode], {
    input: text, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (result.error || result.status !== 0) throw new Error('Windows credential encryption failed.');
  return result.stdout.trim();
}

export class StateStore {
  constructor(directory = stateDir) { this.directory = directory; }
  read(name = 'account') {
    let data;
    try { data = readFileSync(join(this.directory, `${name}.dpapi`), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return JSON.parse(protect(data, 'decrypt'));
  }
  write(data, name = 'account') {
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${name}.dpapi`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, protect(JSON.stringify(data), 'encrypt'), { mode: 0o600 });
    try { renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  remove(name) {
    try { unlinkSync(join(this.directory, `${name}.dpapi`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export const QUESTION_IDLE_RESET_MS = 24 * 60 * 60 * 1000;

function readQuestionCounter(store) {
  const counter = store.read('question-counter') ?? { last: 0, idleSince: null };
  if (!Number.isSafeInteger(counter.last) || counter.last < 0 ||
      (counter.idleSince != null && (!Number.isSafeInteger(counter.idleSince) || counter.idleSince < 0))) {
    throw new Error('微信题号计数器无效，已停止发送以避免重复题号。');
  }
  return counter;
}

// Call while holding the receiver lock; active questions always keep their unique numbers.
export function nextQuestionId(store, { now = Date.now(), hasPending = false } = {}) {
  const counter = readQuestionCounter(store);
  const reset = !hasPending && counter.idleSince != null && now - counter.idleSince >= QUESTION_IDLE_RESET_MS;
  const last = reset ? 0 : counter.last;
  if (last === Number.MAX_SAFE_INTEGER) throw new Error('微信题号计数器无效，已停止发送以避免重复题号。');
  store.write({ last: last + 1, idleSince: null }, 'question-counter');
  return String(last + 1);
}

export function markQuestionsIdle(store, now = Date.now()) {
  const counter = readQuestionCounter(store);
  if (counter.idleSince == null) store.write({ ...counter, idleSince: now }, 'question-counter');
}

export function acquireLock(directory = stateDir) {
  const path = join(directory, 'poll.lock');
  mkdirSync(dirname(path), { recursive: true });
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      closeSync(fd);
      return () => {
        try { if (JSON.parse(readFileSync(path, 'utf8')).nonce === nonce) unlinkSync(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(path, 'utf8')); }
      catch { throw new Error('微信问答锁文件尚未写完或已损坏，请稍后重试。'); }
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') { unlinkSync(path); continue; }
      }
      throw new Error('已有微信提问或扫码登录正在进行，请等它结束后再试。');
    }
  }
  throw new Error('未能获得微信接收锁。');
}
