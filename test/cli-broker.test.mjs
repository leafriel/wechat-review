import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../src/state.mjs';
import { startBroker } from '../src/broker.mjs';
import { startCli } from './helpers/cli.mjs';
import { fakeWeChat, ownerMessage } from './helpers/fake-wechat.mjs';

test('CLI 从任意项目运行，无宿主环境变量，并发乱序回答与单题取消互不影响', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-cli-agents-'));
  const store = new StateStore(directory);
  store.write({ token: 'fake-token', ownerId: 'owner', contextToken: 'context', cursor: '' });
  const channel = fakeWeChat();
  const broker = await startBroker({ store, makeClient: () => channel.client });
  const calls = [];
  const cli = source => {
    const call = startCli(directory, { ...source, question: '选择？', options: ['a', 'b', 'c'] }, { cwd: tmpdir() });
    calls.push(call);
    return call;
  };
  try {
    const first = cli({ conversation_title: 'Agent 对话 A' });
    await channel.waitForSends(1); // stdin remains open; no EOF was needed.
    first.child.stdin.end();
    const second = cli({ conversation_id: 'agent-thread-b' });
    await channel.waitForSends(2);
    assert.match(channel.sends[0].text, /对话：Agent 对话 A/);
    assert.match(channel.sends[1].text, /对话：agent-thread-b/);
    channel.deliver([ownerMessage('2 2'), ownerMessage('1 3')]);
    assert.equal((await second.done).selected_option, 'b');
    assert.equal((await first.done).selected_option, 'c');
    const cancelled = cli({ conversation_title: 'Agent 对话 C' });
    await channel.waitForSends(3);
    const surviving = cli({ conversation_title: 'Agent 对话 D' });
    await channel.waitForSends(4);
    cancelled.child.stdin.write('cancel\n');
    assert.equal((await cancelled.done).status, 'cancelled');
    const deadline = Date.now() + 2000;
    while (broker.router.pending.has('3') && Date.now() < deadline) await delay(5);
    assert.equal(broker.router.pending.has('3'), false);
    assert.equal(broker.router.pending.has('4'), true);
    channel.deliver([ownerMessage('3 1'), ownerMessage('4 2')]);
    assert.equal((await surviving.done).selected_option, 'b');
    assert.equal(channel.maxActivePolls, 1);
  } finally {
    for (const call of calls) call.child.kill();
    await Promise.allSettled(calls.map(call => call.done));
    await broker.close();
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  }
});
