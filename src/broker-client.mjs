import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore, stateDir } from './state.mjs';

export function brokerAddress(directory = stateDir) {
  const absolute = resolve(directory);
  const hash = createHash('sha256').update(process.platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? ['', '', '.', 'pipe', `codex-wechat-question-${hash}`].join('\\') : join(absolute, 'broker.sock');
}

function connect(address, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('微信接收进程连接超时。')); }, 2000);
    const onAbort = () => { socket.destroy(); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
    socket.once('connect', () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(socket); });
  });
}

export async function requestBroker(action, input = {}, { directory = stateDir, signal, autoStart = true } = {}) {
  if (signal?.aborted) return { status: 'cancelled', sent: false };
  const deadline = Date.now() + 15000;
  let started = false;
  let socket;
  let token;
  while (Date.now() < deadline) {
    try {
      socket = await connect(brokerAddress(directory), signal);
      token = new StateStore(directory).read('broker-auth')?.token;
      if (token) break;
      socket.destroy();
    } catch (error) {
      socket?.destroy();
      if (signal?.aborted) return { status: 'cancelled', sent: false };
      if (!['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) throw error;
      if (!autoStart) return { status: 'not_running' };
      if (!started) {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./broker.mjs', import.meta.url))], {
          env: { ...process.env, WECHAT_QUESTION_STATE_DIR: directory }, detached: true, windowsHide: true, stdio: 'ignore',
        });
        child.on('error', () => {});
        child.unref();
        started = true;
      }
    }
    await delay(100, undefined, { signal });
  }
  if (!socket || socket.destroyed || !token) throw new Error('微信接收进程未能启动，可能正在扫码登录，请稍后重试。');
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    socket.setEncoding('utf8');
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => finish(null, { status: 'cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(650000, () => finish(new Error('微信接收进程响应超时。')));
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('微信接收进程连接已关闭；未替你选择任何选项。')));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) return finish(new Error('微信接收进程响应过大。'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { finish(null, JSON.parse(buffer.slice(0, end))); }
      catch { finish(new Error('微信接收进程返回了无效数据。')); }
    });
    if (signal?.aborted) return onAbort();
    socket.write(JSON.stringify({ action, input, token }) + '\n');
  });
}

export async function askQuestion(input, { store, signal } = {}) {
  try { return await requestBroker('ask', input, { directory: store?.directory, signal }); }
  catch (error) {
    if (signal?.aborted) return { status: 'cancelled' };
    throw error;
  }
}

export function stopBroker(directory = stateDir) {
  return requestBroker('stop', {}, { directory, autoStart: false });
}
