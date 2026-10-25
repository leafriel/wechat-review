import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { askFromStream } from '../scripts/cli.mjs';

const question = { conversation_title: '脚本来源对话', question: '选哪一个？', options: ['a', 'b', 'c'] };
const line = JSON.stringify(question) + '\n';

test('首行 JSON 不等待 EOF 即开始；stdin 关闭不取消；默认禁止文字', async () => {
  const input = new PassThrough();
  let complete;
  let seen;
  const result = askFromStream(input, { ask: (value, { signal }) => { seen = { value, signal }; return new Promise(resolve => { complete = resolve; }); } });
  input.write(line);
  await delay(0);
  assert.equal(seen.value.conversation_title, question.conversation_title);
  assert.equal(seen.value.allow_text, false);
  input.end();
  await delay(0);
  assert.equal(seen.signal.aborted, false);
  complete({ status: 'answered', selected_index: 2 });
  assert.equal((await result).selected_index, 2);
});

test('cancel 只中止自己的调用，迟到答案不覆盖结果', async () => {
  const a = new PassThrough(), b = new PassThrough();
  const calls = [];
  const ask = (_, { signal }) => new Promise(resolve => { calls.push({ signal, resolve }); });
  const first = askFromStream(a, { ask }), second = askFromStream(b, { ask });
  a.write(line); b.write(line);
  await delay(0);
  a.write('cancel\n');
  const cancelled = await first;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.selected_index, undefined);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, false);
  calls[0].resolve({ status: 'answered', selected_index: 1 });
  calls[1].resolve({ status: 'answered', selected_index: 3 });
  assert.equal((await second).selected_index, 3);
  a.end(); b.end();
});

test('缺少来源或 JSON 无效时不调用接收器，取消前未输入也不发送', async () => {
  for (const body of ['', '{invalid}\n', JSON.stringify({ question: '匿名？', options: ['a', 'b'], context: '项目名' }) + '\n']) {
    const input = new PassThrough();
    const pending = askFromStream(input, { ask: () => assert.fail('invalid input reached receiver') });
    input.end(body);
    assert.equal((await pending).status, 'error');
  }
  const controller = new AbortController();
  const input = new PassThrough();
  const pending = askFromStream(input, { signal: controller.signal, ask: () => assert.fail('cancelled input reached receiver') });
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  input.end();
});

test('输入错误和进程取消信号不会产生默认答案', async () => {
  const input = new PassThrough();
  const pending = askFromStream(input);
  input.destroy(new Error('input failed'));
  assert.equal((await pending).status, 'error');
  const controller = new AbortController();
  const stream = new PassThrough();
  const running = askFromStream(stream, { signal: controller.signal, ask: (_, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ status: 'answered', selected_index: 1 }), { once: true });
  }) });
  stream.write(line);
  await delay(0);
  controller.abort();
  assert.equal((await running).status, 'cancelled');
  stream.end();
});
