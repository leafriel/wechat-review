import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StateStore } from '../src/state.mjs';
import { startBroker } from '../src/broker.mjs';
import { fakeWeChat, ownerMessage } from './helpers/fake-wechat.mjs';

test('直接 CLI 不加载 MCP；与旧 MCP 共享接收器、乱序答题及独立取消', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-cli-mixed-'));
  const store = new StateStore(directory);
  store.write({ token: 'fake-token', ownerId: 'owner', contextToken: 'context', cursor: '' });
  const channel = fakeWeChat();
  const broker = await startBroker({ store, makeClient: () => channel.client });
  const client = new Client({ name: 'legacy-mcp', version: '1.0.0' });
  const children = [];
  const env = { ...process.env, WECHAT_QUESTION_STATE_DIR: directory };
  const hook = 'data:text/javascript,' + encodeURIComponent("import{registerHooks}from'node:module';registerHooks({resolve(s,c,next){if(s.includes('@modelcontextprotocol'))throw Error('MCP dependency forbidden');return next(s,c)}})");
  function cli(conversation) {
    const child = spawn(process.execPath, ['--import', hook, fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url)), 'ask'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not exit after completion')); }, 15000);
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
    });
    child.stdin.write(JSON.stringify({ conversation_title: conversation, question: '选择？', options: ['a', 'b', 'c'] }) + '\n');
    return { child, done };
  }
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env, stderr: 'pipe' }));
    const first = cli('CLI 对话 A');
    await channel.waitForSends(1); // stdin is still open; no EOF was needed.
    first.child.stdin.end();
    const second = client.callTool({ name: 'ask_wechat', arguments: { conversation_id: 'legacy-thread-b', question: '兼容题？', options: ['x', 'y'] } });
    await channel.waitForSends(2);
    assert.match(channel.sends[0].text, /对话：CLI 对话 A/);
    assert.match(channel.sends[1].text, /对话：legacy-thread-b/);
    channel.deliver([ownerMessage('2 2'), ownerMessage('1 3')]);
    assert.equal((await second).structuredContent.selected_option, 'y');
    assert.equal((await first.done).selected_option, 'c');
    const cancelled = cli('CLI 对话 C');
    await channel.waitForSends(3);
    const surviving = client.callTool({ name: 'ask_wechat', arguments: { conversation_title: 'MCP 对话 D', question: '继续？', options: ['是', '否'] } });
    await channel.waitForSends(4);
    cancelled.child.stdin.write('cancel\n');
    assert.equal((await cancelled.done).status, 'cancelled');
    const deadline = Date.now() + 2000;
    while (broker.router.pending.has('3') && Date.now() < deadline) await delay(5);
    assert.equal(broker.router.pending.has('3'), false);
    assert.equal(broker.router.pending.has('4'), true);
    channel.deliver([ownerMessage('3 1'), ownerMessage('4 2')]);
    assert.equal((await surviving).structuredContent.selected_option, '否');
    assert.equal(channel.maxActivePolls, 1);
  } finally {
    for (const child of children) child.kill();
    await client.close();
    await broker.close();
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  }
});
