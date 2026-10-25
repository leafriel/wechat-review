import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, acquireLock, markQuestionsIdle } from './state.mjs';
import { QuestionRouter } from './question.mjs';
import { brokerAddress } from './broker-client.mjs';
import { questionSchema } from './schema.mjs';

export async function startBroker({ store = new StateStore(), makeClient, idleMs = 60000, now = Date.now } = {}) {
  const sockets = new Set();
  let idleTimer;
  let release;
  let closing;
  let token;
  const router = new QuestionRouter({ store, makeClient, now, onChange: armIdle });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    const controller = new AbortController();
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); controller.abort(); });
    let buffer = '';
    let handled = false;
    const respond = result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n'); };
    socket.on('data', chunk => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) return socket.destroy();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      socket.setTimeout(650000);
      let request;
      try { request = JSON.parse(buffer.slice(0, end)); }
      catch { return respond({ status: 'error', message: '无效的微信问答请求。' }); }
      if (!request || typeof request !== 'object' || Array.isArray(request)) return respond({ status: 'error', message: '无效的微信问答请求。' });
      const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
      const expected = Buffer.from(token ?? '');
      if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return respond({ status: 'error', message: '微信问答本机连接认证失败。' });
      }
      if (request.action === 'stop') {
        if (router.pending.size) return respond({ status: 'busy', message: '仍有会话等待微信回复，请先完成或取消这些问题再重新登录。' });
        void router.close().then(() => {
          release?.();
          release = null;
          respond({ status: 'stopped' });
          setImmediate(() => { void close(); });
        });
        return;
      }
      if (request.action !== 'ask') return respond({ status: 'error', message: '不支持的微信问答操作。' });
      const input = questionSchema.safeParse(request.input);
      if (!input.success) return respond({ status: 'error', message: `微信问题参数无效：${input.error.issues[0].message}` });
      armIdle();
      router.ask(input.data, { signal: controller.signal }).then(respond).catch(error => respond({ status: 'error', message: error.message }));
    });
  });

  function armIdle() {
    clearTimeout(idleTimer);
    if (!router.pending.size && !router.closed && !closing) idleTimer = setTimeout(() => { void close(); }, idleMs);
  }
  function close() {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(idleTimer);
      await router.close();
      release?.();
      release = null;
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    })();
    return closing;
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(brokerAddress(store.directory), resolve);
    });
    release = acquireLock(store.directory);
    markQuestionsIdle(store, now());
    const auth = store.read('broker-auth');
    token = auth?.token;
    if (!token) { token = randomBytes(32).toString('hex'); store.write({ token }, 'broker-auth'); }
    armIdle();
    return { router, server, close, address: brokerAddress(store.directory) };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const broker = await startBroker();
    process.once('SIGINT', () => { void broker.close(); });
    process.once('SIGTERM', () => { void broker.close(); });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
