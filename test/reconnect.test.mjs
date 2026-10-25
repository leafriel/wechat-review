import test from 'node:test';
import assert from 'node:assert/strict';
import { ILink } from '../src/ilink.mjs';
import { QuestionRouter } from '../src/question.mjs';
import { fakeWeChat, memoryStore, ownerMessage } from './helpers/fake-wechat.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const input = { question: '继续执行吗？', options: ['继续', '调整'], allow_text: false, timeout_seconds: 15 };

function staleContextChannel(onSend) {
  const channel = fakeWeChat();
  const attempts = [];
  const api = new ILink({ token: 'test-token', fetchImpl: async (_, options) => {
    const msg = JSON.parse(options.body).msg;
    attempts.push(msg.context_token);
    if (msg.context_token !== 'fresh-context') return new Response(JSON.stringify({ ret: -2, errmsg: 'prepare failed' }));
    await channel.client.send({ ownerId: 'owner' }, msg.item_list[0].text_item.text);
    onSend?.(channel, msg.item_list[0].text_item.text);
    return new Response('{"ret":0}');
  } });
  const client = { send: api.send.bind(api), updates: channel.client.updates };
  return { ...channel, get maxActivePolls() { return channel.maxActivePolls; }, client, attempts };
}

test('expired context refreshes from a new owner message and delivers the same question instead of returning send error', async t => {
  const channel = staleContextChannel(channel => setImmediate(() => channel.deliver([ownerMessage('1 2')])));
  const store = memoryStore();
  const router = new QuestionRouter({ store, makeClient: () => channel.client });
  t.after(() => router.close());
  const pending = router.ask(input);
  channel.deliver([ownerMessage('绑定', { context_token: 'fresh-context' })]);
  const result = await pending;
  assert.equal(result.status, 'answered');
  assert.equal(result.selected_option, '调整');
  assert.equal(result.question_id, '1');
  assert.equal(result.sent, true);
  assert.deepEqual(channel.attempts, ['context', 'fresh-context']);
  assert.equal(channel.sends.length, 1);
  assert.equal(store.read('question-counter').last, 1);
  assert.equal(store.read().contextToken, 'fresh-context');
});

test('context recovery preserves parallel question identity and does not resend a cancelled caller', async t => {
  const channel = staleContextChannel();
  const router = new QuestionRouter({ store: memoryStore(), makeClient: () => channel.client });
  t.after(() => router.close());
  const controller = new AbortController();
  const a = router.ask(input, { signal: controller.signal });
  const b = router.ask(input);
  for (let i = 0; i < 100 && channel.attempts.length < 2; i++) await delay(1);
  assert.equal(channel.attempts.length, 2);
  controller.abort();
  assert.equal((await a).status, 'cancelled');
  channel.deliver([
    ownerMessage('绑定', { from_user_id: 'intruder', context_token: 'wrong-context' }),
    ownerMessage('绑定', { group_id: 'group', context_token: 'wrong-context' }),
    ownerMessage('绑定', { context_token: 'fresh-context' }),
  ]);
  await channel.waitForSends(1);
  assert.equal(channel.sends[0].id, '2');
  channel.deliver([ownerMessage('2 1')]);
  assert.equal((await b).selected_option, '继续');
  assert.equal(channel.maxActivePolls, 1);
  assert.deepEqual(channel.attempts, ['context', 'context', 'fresh-context']);
});

test('unchanged or foreign context never causes a retry loop; original deadline returns actionable timeout', async t => {
  const channel = staleContextChannel();
  const router = new QuestionRouter({ store: memoryStore(), makeClient: () => channel.client });
  t.after(() => router.close());
  const pending = router.ask({ ...input, timeout_seconds: 0.05 });
  channel.deliver([ownerMessage('绑定', { context_token: 'context' }),
    ownerMessage('绑定', { from_user_id: 'intruder', context_token: 'fresh-context' })]);
  const result = await pending;
  assert.equal(result.status, 'timeout');
  assert.equal(result.sent, false);
  assert.match(result.message, /绑定/);
  assert.equal(result.selected_index, undefined);
  assert.equal(channel.attempts.length, 1);
});

test('ambiguous network failure is never automatically retried or treated as a context failure', async () => {
  let attempts = 0;
  const api = new ILink({ fetchImpl: async () => { attempts++; throw new Error('network failure'); } });
  const router = new QuestionRouter({ store: memoryStore(), makeClient: () => ({
    send: api.send.bind(api), updates: () => assert.fail('must not poll/retry an ambiguous send'),
  }) });
  const result = await router.ask(input);
  assert.equal(result.status, 'error');
  assert.equal(attempts, 1);
  await router.close();
});

test('only the explicit send prepare failure requests context; other API failures stay distinct and sanitized', async () => {
  const account = memoryStore().read();
  for (const [body, method, code] of [
    [{ ret: -2, errmsg: 'prepare failed' }, 'send', 'CONTEXT_REQUIRED'],
    [{ ret: 0, errcode: -2, errmsg: 'prepare failed' }, 'send', 'CONTEXT_REQUIRED'],
    [{ ret: -2, errmsg: 'prepare failed' }, 'updates', 'ILINK_ERROR'],
    [{ ret: -2, errmsg: 'secret other failure' }, 'send', 'ILINK_ERROR'],
    [{ ret: -14, errmsg: 'secret expired token' }, 'send', 'LOGIN_EXPIRED'],
  ]) {
    const api = new ILink({ fetchImpl: async () => new Response(JSON.stringify(body)) });
    await assert.rejects(method === 'send' ? api.send(account, 'test') : api.updates(),
      error => error.code === code && !error.message.includes('secret'));
  }
});

test('a context arriving while a send is in flight is used after that stale send is rejected', async t => {
  const channel = fakeWeChat(); const store = memoryStore();
  let rejectStale;
  let attemptsB = 0;
  const client = { updates: channel.client.updates, send: async (account, text) => {
    if (text.includes('问题B') && ++attemptsB === 1) return new Promise((_, reject) => { rejectStale = reject; });
    return channel.client.send(account, text);
  } };
  const router = new QuestionRouter({ store, makeClient: () => client });
  t.after(() => router.close());
  const a = router.ask(input);
  await channel.waitForSends(1);
  const b = router.ask({ ...input, question: '问题B' });
  for (let i = 0; i < 100 && !rejectStale; i++) await delay(1);
  assert.ok(rejectStale);
  channel.deliver([ownerMessage('绑定', { context_token: 'fresh-context' })]);
  for (let i = 0; i < 100 && store.read().contextToken !== 'fresh-context'; i++) await delay(1);
  assert.equal(store.read().contextToken, 'fresh-context');
  rejectStale(Object.assign(new Error('stale context'), { code: 'CONTEXT_REQUIRED' }));
  await channel.waitForSends(2);
  channel.deliver([ownerMessage('2 2'), ownerMessage('1 1')]);
  assert.equal((await b).selected_option, '调整');
  assert.equal((await a).selected_option, '继续');
  assert.equal(attemptsB, 2);
});
