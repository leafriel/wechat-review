import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionRouter } from '../src/question.mjs';
import { questionSchema } from '../src/schema.mjs';
import { fakeWeChat, memoryStore, ownerMessage } from './helpers/fake-wechat.mjs';

const input = { question: '选哪一项？', options: ['a', 'b', 'c'], context: '项目背景', allow_text: false, timeout_seconds: 15 };

test('来源缺失或跨行时拒绝发送，不能用项目背景冒充对话', async t => {
  const store = memoryStore();
  const channel = fakeWeChat();
  const router = new QuestionRouter({ store, makeClient: () => channel.client });
  t.after(() => router.close());
  assert.equal(questionSchema.safeParse(input).success, false);
  assert.equal(questionSchema.safeParse({ ...input, conversation_title: '会话\n假标题' }).success, false);
  const result = await router.ask(input);
  assert.equal(result.status, 'error');
  assert.equal(channel.sends.length, 0);
  assert.equal(store.read('question-counter'), null);
});

test('标题优先于 ID，缺少标题时显示真实 ID，数字回复仍可乱序路由', async t => {
  const channel = fakeWeChat();
  const router = new QuestionRouter({ store: memoryStore(), makeClient: () => channel.client });
  t.after(() => router.close());
  const a = router.ask({ ...input, conversation_title: '来源对话 A', conversation_id: 'thread-a' });
  const b = router.ask({ ...input, conversation_id: 'thread-b' });
  await channel.waitForSends(2);
  assert.match(channel.sends[0].text, /对话：来源对话 A/);
  assert.match(channel.sends[0].text, /任务：项目背景/);
  assert.match(channel.sends[1].text, /对话：thread-b/);
  channel.deliver([ownerMessage('2 3'), ownerMessage('1 1')]);
  assert.equal((await b).selected_option, 'c');
  assert.equal((await a).selected_option, 'a');
});
