import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanel } from '../src/panel.mjs';
const question = { question: '测试', context: '测试', options: ['a', 'b'] };
const answer = (panel, index, origin = new URL(panel.url).origin) => fetch(panel.url + 'answer', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ selected_index: index }) });
test('微信先答后隐藏题目且拒绝桌面迟到答案', async t => {
  const panel = await createPanel(question); t.after(panel.close);
  assert.equal(panel.settle({ status: 'answered', channel: 'wechat', selected_index: 2, selected_option: 'b' }), true);
  assert.deepEqual(await (await fetch(panel.url + 'state')).json(), { status: 'answered', channel: 'wechat' });
  assert.equal((await answer(panel, 1)).status, 409);
  assert.equal((await panel.done).selected_index, 2);
});
test('桌面先答后拒绝微信迟到答案', async t => {
  const panel = await createPanel(question); t.after(panel.close);
  assert.equal((await answer(panel, 1)).status, 200);
  assert.equal(panel.settle({ status: 'answered', channel: 'wechat', selected_index: 2 }), false);
  assert.equal((await panel.done).channel, 'desktop');
});
test('不可信来源和无效选项不能作答；微信故障不替用户选择', async t => {
  const panel = await createPanel(question); t.after(panel.close);
  assert.equal((await answer(panel, 1, 'http://example.com')).status, 403);
  assert.equal((await answer(panel, 3)).status, 400);
  panel.wechatFailed('unavailable');
  assert.deepEqual(await (await fetch(panel.url + 'state')).json(), { status: 'pending', wechat_error: true });
  const missing = new URL('/state', panel.url);
  assert.equal((await fetch(missing)).status, 404);
});
test('超时结束而不产生选项', async t => {
  const panel = await createPanel(question, { timeoutMs: 20 }); t.after(panel.close);
  assert.deepEqual(await panel.done, { status: 'timeout' });
  assert.equal((await answer(panel, 1)).status, 409);
});
