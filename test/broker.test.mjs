import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, acquireLock } from '../src/state.mjs';
import { startBroker } from '../src/broker.mjs';
import { requestBroker, stopBroker } from '../src/broker-client.mjs';
import { fakeWeChat, ownerMessage } from './helpers/fake-wechat.mjs';
import { startCli } from './helpers/cli.mjs';

test('closing with pending questions exits promptly without a leftover idle timer', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-review-close-'));
  const moduleUrl = name => JSON.stringify(new URL(name, import.meta.url).href);
  const code = `
    import assert from 'node:assert/strict';
    import { startBroker } from ${moduleUrl('../src/broker.mjs')};
    import { memoryStore, fakeWeChat } from ${moduleUrl('./helpers/fake-wechat.mjs')};
    const store = memoryStore(); store.directory = ${JSON.stringify(directory)};
    const channel = fakeWeChat();
    const broker = await startBroker({ store, makeClient: () => channel.client });
    const answer = broker.router.ask({ conversation_id: 'closing-test', question: '待答题', options: ['是','否'], timeout_seconds: 15 });
    await channel.waitForSends(1);
    await broker.close();
    assert.equal((await answer).status, 'cancelled');
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(join(directory, 'poll.lock')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('choice-only broker starts no receiver while idle and shuts down after the idle interval', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-review-idle-'));
  const broker = await startBroker({ store: new StateStore(directory), idleMs: 30,
    makeClient: () => assert.fail('idle broker must not start a WeChat client') });
  try {
    assert.equal(broker.router.pollPromise, null);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('idle shutdown did not run')), 3000);
      broker.server.once('close', () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(broker.server.listening, false);
    assert.equal(existsSync(join(directory, 'poll.lock')), false);
  } finally {
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('independent agent CLI processes share one receiver, route replies and preserve numbering after restart', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-review-concurrent-'));
  const store = new StateStore(directory);
  store.write({ token: 'fake-token', ownerId: 'owner', contextToken: 'context', cursor: '' });
  const channel = fakeWeChat();
  let broker = await startBroker({ store, makeClient: () => channel.client });
  const calls = [];
  const ask = (index, question, options) => {
    const call = startCli(directory, { conversation_title: `来源会话 ${index}`, question, options });
    calls.push(call);
    return call;
  };
  try {
    let firstFinished = false;
    const first = ask(0, '会话 A 的问题', ['A1', 'A2']).done.then(result => { firstFinished = true; return result; });
    const second = ask(1, '会话 B 的问题', ['B1', 'B2']).done;
    await channel.waitForSends(2);
    const a = channel.sends.find(send => send.text.includes('会话 A 的问题')).id;
    const b = channel.sends.find(send => send.text.includes('会话 B 的问题')).id;
    assert.notEqual(a, b);
    assert.deepEqual(channel.sends.map(send => send.id).sort(), ['1', '2']);
    assert.equal((await stopBroker(directory)).status, 'busy');
    channel.deliver([ownerMessage(`${b} 2`)]);
    const answerB = await second;
    assert.equal(answerB.question_id, b);
    assert.equal(answerB.selected_option, 'B2');
    assert.equal(firstFinished, false);
    channel.deliver([ownerMessage(`${b} 1`), ownerMessage(`${a} 1`)]);
    const answerA = await first;
    assert.equal(answerA.question_id, a);
    assert.equal(answerA.selected_option, 'A1');
    assert.equal(channel.maxActivePolls, 1);
    await broker.close();
    broker = await startBroker({ store: new StateStore(directory), makeClient: () => channel.client });
    const third = ask(0, '重启后的问题', ['继续', '取消']).done;
    await channel.waitForSends(3);
    assert.equal(channel.sends[2].id, '3');
    channel.deliver([ownerMessage('1 2'), ownerMessage('3 1')]);
    assert.equal((await third).selected_option, '继续');
    const disconnected = ask(0, '即将断开的会话', ['是', '否']);
    const surviving = ask(1, '继续等待的会话', ['继续', '停止']);
    await channel.waitForSends(5);
    const disconnectedId = channel.sends.find(send => send.text.includes('即将断开的会话')).id;
    const survivingId = channel.sends.find(send => send.text.includes('继续等待的会话')).id;
    disconnected.child.kill();
    assert.notEqual((await disconnected.done).status, 'answered');
    channel.deliver([ownerMessage(`${disconnectedId} 1`), ownerMessage(`${survivingId} 1`)]);
    assert.equal((await surviving.done).selected_option, '继续');
  } finally {
    for (const call of calls) call.child.kill();
    await Promise.allSettled(calls.map(call => call.done));
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('simultaneous cold clients start one broker and idle shutdown releases the login lock', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-review-cold-start-'));
  const question = { conversation_id: 'cold-start-test', question: '未绑定测试', options: ['一', '二'] };
  try {
    const results = await Promise.all([
      requestBroker('ask', question, { directory }), requestBroker('ask', question, { directory }),
    ]);
    assert.deepEqual(results.map(result => result.status), ['not_connected', 'not_connected']);
    const invalid = await requestBroker('ask', { question: '缺少选项' }, { directory });
    assert.equal(invalid.status, 'error');
    assert.equal((await stopBroker(directory)).status, 'stopped');
    const release = acquireLock(directory);
    release();
  } finally {
    await stopBroker(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('local broker rejects malformed and unauthenticated requests before sending anything', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-review-auth-'));
  const channel = fakeWeChat();
  const broker = await startBroker({ store: new StateStore(directory), makeClient: () => channel.client });
  async function raw(request) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(broker.address);
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('test timeout')); });
      let response = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
      socket.on('data', chunk => { response += chunk; });
      socket.on('end', () => resolve(JSON.parse(response)));
    });
  }
  try {
    assert.equal((await raw(null)).status, 'error');
    assert.equal((await raw({ action: 'ask', token: 'wrong-token', input: {} })).status, 'error');
    assert.equal(channel.sends.length, 0);
  } finally {
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
