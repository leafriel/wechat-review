import test from 'node:test';
import assert from 'node:assert/strict';
import { DualQuestions } from '../src/dual.mjs';
import { createPanel } from '../src/panel.mjs';

const question = { question: '执行确认？', context: '测试', options: ['同意执行', '暂不执行', '修改方案'], allow_text: false, timeout_seconds: 15 };
function fakeAsk() {
  const calls = [];
  return { calls, ask: (input, { signal }) => new Promise(resolve => { calls.push({ input, signal, resolve }); }) };
}
const post = (url, body) => fetch(url + 'answer', { method: 'POST', headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('双渠道各题独立，微信乱序回答收起对应桌面题目', async t => {
  const channel = fakeAsk();
  const dual = new DualQuestions(channel); t.after(() => dual.close());
  const a = await dual.start(question), b = await dual.start(question);
  assert.notEqual(a.question_handle, b.question_handle);
  channel.calls[1].resolve({ status: 'answered', selected_index: 2, selected_option: '暂不执行' });
  assert.equal((await dual.wait(b.question_handle)).channel, 'wechat');
  assert.equal((await (await fetch(b.desktop_url + 'state')).json()).status, 'answered');
  assert.equal((await (await fetch(a.desktop_url + 'state')).json()).status, 'pending');
  assert.equal(channel.calls[0].signal.aborted, false);
  assert.equal((await post(a.desktop_url, { selected_index: 1 })).status, 200);
  const result = await dual.wait(a.question_handle);
  assert.equal(result.channel, 'desktop');
  assert.equal(result.selected_option, '同意执行');
  assert.equal(channel.calls[0].signal.aborted, true);
  channel.calls[0].resolve({ status: 'answered', selected_index: 3, selected_option: '修改方案' });
  assert.deepEqual(await dual.wait(a.question_handle), result);
});

test('各项最终确认均原样返回，取消和超时不形成同意', async t => {
  const channel = fakeAsk();
  const dual = new DualQuestions(channel); t.after(() => dual.close());
  for (let index = 1; index <= 3; index++) {
    const item = await dual.start(question);
    await post(item.desktop_url, { selected_index: index });
    assert.equal((await dual.wait(item.question_handle)).selected_option, question.options[index - 1]);
  }
  const cancelled = await dual.start(question);
  assert.equal((await dual.wait(cancelled.question_handle, { cancel: true })).status, 'cancelled');
  const timedOut = await dual.start(question);
  dual.questions.get(timedOut.question_handle).panel.settle({ status: 'timeout' });
  assert.equal((await dual.wait(timedOut.question_handle)).selected_index, undefined);
});

test('微信不可用仍等待桌面，禁止自由文本的确认不能用文字通过', async t => {
  const dual = new DualQuestions({ ask: async () => ({ status: 'not_connected' }) }); t.after(() => dual.close());
  const item = await dual.start(question);
  const state = await (await fetch(item.desktop_url + 'state')).json();
  assert.equal(state.status, 'pending');
  assert.equal(state.wechat_error, true);
  assert.equal((await post(item.desktop_url, { answer: '同意执行' })).status, 400);
  await post(item.desktop_url, { cancel: true });
  assert.equal((await dual.wait(item.question_handle)).status, 'cancelled');
});

test('允许文字时校验长度；中止等待只取消当前题', async t => {
  const channel = fakeAsk();
  const dual = new DualQuestions(channel); t.after(() => dual.close());
  const a = await dual.start({ ...question, allow_text: true }), b = await dual.start(question);
  assert.equal((await post(a.desktop_url, { answer: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post(a.desktop_url, { answer: '  补充说明  ' })).status, 200);
  assert.equal((await dual.wait(a.question_handle)).answer, '补充说明');
  const controller = new AbortController();
  const wait = dual.wait(b.question_handle, { signal: controller.signal });
  controller.abort();
  assert.equal((await wait).status, 'cancelled');
  assert.equal(channel.calls[1].signal.aborted, true);
  assert.equal((await dual.wait('missing')).status, 'error');
});

test('连接关闭时取消待答题并关闭面板；创建期间断开不会留下接收器', async () => {
  const channel = fakeAsk();
  const dual = new DualQuestions(channel);
  const item = await dual.start(question);
  await dual.close();
  assert.equal(channel.calls[0].signal.aborted, true);
  await assert.rejects(fetch(item.desktop_url));
  await assert.rejects(dual.start(question), /已关闭/);
  let release;
  const opening = new Promise(resolve => { release = resolve; });
  const race = new DualQuestions({ ...channel, panel: async (...args) => { await opening; return createPanel(...args); } });
  const starting = race.start(question);
  await race.close();
  release();
  await assert.rejects(starting, /已关闭/);
  assert.equal(race.questions.size, 0);
});
