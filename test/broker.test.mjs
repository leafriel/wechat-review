import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StateStore, acquireLock } from '../src/state.mjs';
import { startBroker } from '../src/broker.mjs';
import { requestBroker, stopBroker } from '../src/broker-client.mjs';
import { fakeWeChat, ownerMessage } from './helpers/fake-wechat.mjs';

test('choice-only broker starts no receiver while idle and shuts down after the idle interval', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-mcp-idle-'));
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

test('two independent MCP processes share one receiver and route out-of-order answers; restart preserves numbering', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-mcp-concurrent-'));
  const store = new StateStore(directory);
  store.write({ token: 'fake-token', ownerId: 'owner', contextToken: 'context', cursor: '' });
  const channel = fakeWeChat();
  let broker = await startBroker({ store, makeClient: () => channel.client });
  const clients = [];
  try {
    for (const name of ['session-A', 'session-B']) {
      const client = new Client({ name, version: '1.0.0' });
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
        env: { ...process.env, WECHAT_QUESTION_STATE_DIR: directory }, stderr: 'pipe',
      }));
      clients.push(client);
    }
    const ask = (index, question, options) => clients[index].callTool({ name: 'ask_wechat', arguments: { question, options } }, undefined, { timeout: 20000 });
    let firstFinished = false;
    const first = ask(0, '会话 A 的问题', ['A1', 'A2']).then(result => { firstFinished = true; return result; });
    const second = ask(1, '会话 B 的问题', ['B1', 'B2']);
    await channel.waitForSends(2);
    const a = channel.sends.find(send => send.text.includes('会话 A 的问题')).id;
    const b = channel.sends.find(send => send.text.includes('会话 B 的问题')).id;
    assert.notEqual(a, b);
    assert.deepEqual(channel.sends.map(send => send.id).sort(), ['1', '2']);
    assert.equal((await stopBroker(directory)).status, 'busy');
    channel.deliver([ownerMessage(`${b} 2`)]);
    const answerB = (await second).structuredContent;
    assert.equal(answerB.question_id, b);
    assert.equal(answerB.selected_option, 'B2');
    assert.equal(firstFinished, false);
    channel.deliver([ownerMessage(`${b} 1`), ownerMessage(`${a} 1`)]);
    const answerA = (await first).structuredContent;
    assert.equal(answerA.question_id, a);
    assert.equal(answerA.selected_option, 'A1');
    assert.equal(channel.maxActivePolls, 1);
    await broker.close();
    broker = await startBroker({ store: new StateStore(directory), makeClient: () => channel.client });
    const third = ask(0, '重启后的问题', ['继续', '取消']);
    await channel.waitForSends(3);
    assert.equal(channel.sends[2].id, '3');
    channel.deliver([ownerMessage('1 2'), ownerMessage('3 1')]);
    assert.equal((await third).structuredContent.selected_option, '继续');
    const disconnected = ask(0, '即将断开的会话', ['是', '否']).then(() => ({ failed: false }), () => ({ failed: true }));
    const surviving = ask(1, '继续等待的会话', ['继续', '停止']);
    await channel.waitForSends(5);
    const disconnectedId = channel.sends.find(send => send.text.includes('即将断开的会话')).id;
    const survivingId = channel.sends.find(send => send.text.includes('继续等待的会话')).id;
    await clients[0].close();
    assert.equal((await disconnected).failed, true);
    channel.deliver([ownerMessage(`${disconnectedId} 1`), ownerMessage(`${survivingId} 1`)]);
    assert.equal((await surviving).structuredContent.selected_option, '继续');
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('simultaneous cold clients start one broker and idle shutdown releases the login lock', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-mcp-cold-start-'));
  const question = { question: '未绑定测试', options: ['一', '二'] };
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
  const directory = mkdtempSync(join(tmpdir(), 'wechat-mcp-auth-'));
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
