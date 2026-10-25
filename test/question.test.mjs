import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionRouter, parseAnswer } from '../src/question.mjs';
import { ILink, validateBaseUrl } from '../src/ilink.mjs';
import { QUESTION_IDLE_RESET_MS } from '../src/state.mjs';
import { fakeWeChat, memoryStore, ownerMessage } from './helpers/fake-wechat.mjs';

const input = { conversation_title: '存储方案讨论', question: '保存在哪里？', options: ['本地', '数据库'], timeout_seconds: 15, allow_text: true };

test('numeric question IDs match exactly; invalid options never select a default', () => {
  assert.equal(parseAnswer('2', '1', input.options), null);
  assert.equal(parseAnswer('2 2', '1', input.options), null);
  assert.equal(parseAnswer('a1b2c3 2', '1', input.options), null);
  assert.equal(parseAnswer('12 2', '1', input.options), null);
  assert.deepEqual(parseAnswer('1 2', '1', input.options), { status: 'answered', selected_index: 2, selected_option: '数据库', answer: '数据库' });
  assert.deepEqual(parseAnswer('12 2', '12', input.options), { status: 'answered', selected_index: 2, selected_option: '数据库', answer: '数据库' });
  assert.deepEqual(parseAnswer('1 0', '1', input.options), { status: 'invalid' });
  assert.deepEqual(parseAnswer('1 99', '1', input.options), { status: 'invalid' });
  assert.deepEqual(parseAnswer('1 取消', '1', input.options), { status: 'cancelled' });
  assert.deepEqual(parseAnswer('1 稍后再说', '1', input.options, false), { status: 'invalid' });
  assert.deepEqual(parseAnswer('1 稍后再说', '1', input.options), { status: 'invalid' });
});

test('parallel questions accept out-of-order replies only for the owner and correct question', async t => {
  const channel = fakeWeChat();
  const store = memoryStore();
  const router = new QuestionRouter({ store, makeClient: () => channel.client });
  t.after(() => router.close());
  let firstFinished = false;
  const first = router.ask({ ...input, context: '会话 A' }).then(result => { firstFinished = true; return result; });
  const second = router.ask({ ...input, options: ['A', 'B'], context: '会话 B' });
  await channel.waitForSends(2);
  assert.deepEqual(channel.sends.map(send => send.id), ['1', '2']);
  channel.deliver([
    ownerMessage('1 1', { from_user_id: 'intruder', context_token: 'intruder-context' }),
    ownerMessage('1 1', { group_id: 'group' }), ownerMessage('999 1'),
    ownerMessage('2 2', { context_token: 'new-context' }),
  ]);
  const resultB = await second;
  assert.equal(resultB.question_id, '2');
  assert.equal(resultB.selected_option, 'B');
  assert.equal(firstFinished, false);
  channel.deliver([ownerMessage('2 1'), ownerMessage('1 2')]);
  const resultA = await first;
  assert.equal(resultA.question_id, '1');
  assert.equal(resultA.selected_option, '数据库');
  assert.equal(store.read().contextToken, 'new-context');
  assert.equal(channel.maxActivePolls, 1);
});

test('cancelling one caller leaves the other caller waiting and ignores late cancelled replies', async t => {
  const channel = fakeWeChat();
  const router = new QuestionRouter({ store: memoryStore(), makeClient: () => channel.client });
  t.after(() => router.close());
  const controller = new AbortController();
  const first = router.ask(input, { signal: controller.signal });
  const second = router.ask(input);
  await channel.waitForSends(2);
  controller.abort();
  assert.equal((await first).status, 'cancelled');
  channel.deliver([ownerMessage('1 2'), ownerMessage('2 1')]);
  const result = await second;
  assert.equal(result.status, 'answered');
  assert.equal(result.question_id, '2');
  assert.equal(result.selected_index, 1);
});

test('one question timeout does not end another question or fabricate an answer', async t => {
  const channel = fakeWeChat();
  const router = new QuestionRouter({ store: memoryStore(), makeClient: () => channel.client });
  t.after(() => router.close());
  const first = router.ask({ ...input, timeout_seconds: 0.02 });
  const second = router.ask(input);
  await channel.waitForSends(2);
  const expired = await first;
  assert.equal(expired.status, 'timeout');
  assert.equal(expired.answer, undefined);
  channel.deliver([ownerMessage('1 1'), ownerMessage('2 2')]);
  assert.equal((await second).selected_option, '数据库');
});

test('a send failure affects only its own question', async t => {
  const channel = fakeWeChat();
  const send = channel.client.send;
  channel.client.send = async (account, text) => {
    if (text.includes('【1】')) throw new Error('send failed');
    return send(account, text);
  };
  const router = new QuestionRouter({ store: memoryStore(), makeClient: () => channel.client });
  t.after(() => router.close());
  const failed = router.ask(input);
  const remaining = router.ask(input);
  await channel.waitForSends(1);
  assert.equal((await failed).status, 'error');
  channel.deliver([ownerMessage('2 1')]);
  assert.equal((await remaining).selected_index, 1);
});

test('unpaired account never creates a client or allocates a number', async () => {
  const store = memoryStore(null);
  const router = new QuestionRouter({ store, makeClient: () => assert.fail('must not send') });
  assert.equal((await router.ask(input)).status, 'not_connected');
  assert.equal(store.read('question-counter'), null);
  await router.close();
});

test('idle clock starts only after the last concurrent question ends and restarts after new activity', async t => {
  let clock = Date.now();
  const channel = fakeWeChat();
  const store = memoryStore();
  const router = new QuestionRouter({ store, makeClient: () => channel.client, now: () => clock });
  t.after(() => router.close());
  const first = router.ask(input);
  const second = router.ask(input);
  await channel.waitForSends(2);
  channel.deliver([ownerMessage('1 1', { create_time_ms: clock })]);
  await first;
  assert.equal(store.read('question-counter').idleSince, null);
  clock += 1000;
  channel.deliver([ownerMessage('2 2', { create_time_ms: clock })]);
  await second;
  assert.equal(store.read('question-counter').idleSince, clock);
  clock += QUESTION_IDLE_RESET_MS;
  const third = router.ask(input);
  const fourth = router.ask(input);
  await channel.waitForSends(4);
  assert.deepEqual(channel.sends.slice(2).map(send => send.id), ['1', '2']);
  channel.deliver([
    ownerMessage('1 2', { create_time_ms: clock - QUESTION_IDLE_RESET_MS }),
    ownerMessage('2 1', { create_time_ms: clock }), ownerMessage('1 1', { create_time_ms: clock }),
  ]);
  assert.equal((await fourth).selected_index, 1);
  assert.equal((await third).selected_index, 1);
  assert.equal(store.read('question-counter').idleSince, clock);
});

test('API rejects credential redirects and reports expired sessions without returning response secrets', async () => {
  assert.throws(() => validateBaseUrl('https://weixin.qq.com.attacker.test'));
  assert.throws(() => validateBaseUrl('http://ilinkai.weixin.qq.com'));
  assert.throws(() => validateBaseUrl('https://secret@ilinkai.weixin.qq.com'));
  let request;
  const api = new ILink({ token: 'test-token', fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ret: -14, errmsg: 'do not expose this secret' }), { status: 200 });
  } });
  await assert.rejects(api.updates('cursor'), error => error.code === 'LOGIN_EXPIRED' && !error.message.includes('secret'));
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
});
