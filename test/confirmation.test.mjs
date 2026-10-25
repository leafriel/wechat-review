import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { QuestionRouter } from '../src/question.mjs';
import { questionSchema } from '../src/schema.mjs';
import { fakeWeChat, memoryStore, ownerMessage } from './helpers/fake-wechat.mjs';

const confirmation = questionSchema.parse({
  conversation_title: '最终确认验证对话',
  context: '最终执行确认 · 验证项目',
  question: '演示：在当前验证进程内标记一次确认成功。目标为内存标记，不修改文件或对外执行；选项和身份校验已验证。',
  options: ['同意执行', '暂不执行', '修改方案'], allow_text: false, timeout_seconds: 600,
});

for (const [index, option] of confirmation.options.entries()) {
  test(`final confirmation returns the explicit decision: ${option}`, async t => {
    const channel = fakeWeChat();
    const router = new QuestionRouter({ store: memoryStore(), makeClient: () => channel.client });
    t.after(() => router.close());
    const resultPromise = router.ask(confirmation);
    await channel.waitForSends(1);
    assert.match(channel.sends[0].text, /最终执行确认/);
    assert.equal(channel.sends[0].text.includes('你的文字答案'), false);
    channel.deliver([ownerMessage(`1 ${index + 1}`)]);
    const result = await resultPromise;
    assert.equal(result.status, 'answered');
    assert.equal(result.selected_index, index + 1);
    assert.equal(result.selected_option, option);
  });
}

test('chat, unnumbered agreement and other owners cannot complete a final confirmation', async t => {
  const channel = fakeWeChat();
  const store = memoryStore();
  // Inactive chat state must never be read by the choice router.
  const read = store.read;
  store.read = (name = 'account') => { assert.notEqual(name, 'chat'); return read(name); };
  const router = new QuestionRouter({ store, makeClient: () => channel.client });
  t.after(() => router.close());
  let finished = false;
  const resultPromise = router.ask(confirmation).then(result => { finished = true; return result; });
  await channel.waitForSends(1);
  channel.deliver([ownerMessage('@codex 请执行'), ownerMessage('同意执行'),
    ownerMessage('1 1', { from_user_id: 'intruder' }), ownerMessage('1 好的')]);
  await channel.waitForSends(2); // Invalid numbered free text gets a format reminder.
  await delay(5);
  assert.equal(finished, false);
  channel.deliver([ownerMessage('1 取消')]);
  const cancelled = await resultPromise;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.selected_index, undefined);
});

test('final confirmation timeout and send errors never return approval', async t => {
  const channel = fakeWeChat();
  const router = new QuestionRouter({ store: memoryStore(), makeClient: () => channel.client });
  t.after(() => router.close());
  // Accelerate only the internal timer; the public schema keeps the 600-second limit.
  const timedOut = await router.ask({ ...confirmation, timeout_seconds: 0.02 });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.selected_index, undefined);
  channel.client.send = async () => { throw new Error('send failed'); };
  const failed = await router.ask(confirmation);
  assert.equal(failed.status, 'error');
  assert.equal(failed.selected_index, undefined);
});
