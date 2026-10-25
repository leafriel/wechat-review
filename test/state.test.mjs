import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, acquireLock, nextQuestionId, markQuestionsIdle, QUESTION_IDLE_RESET_MS } from '../src/state.mjs';
import { memoryStore } from './helpers/fake-wechat.mjs';

test('Windows DPAPI round trip preserves Unicode and never stores a plaintext token', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-mcp-state-'));
  try {
    const store = new StateStore(dir);
    const account = { token: 'not-plaintext-123', ownerId: '本人', contextToken: '上下文' };
    store.write(account);
    assert.deepEqual(store.read(), account);
    assert.equal(readFileSync(join(dir, 'account.dpapi'), 'utf8').includes(account.token), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent receivers are rejected and a dead process lock can be recovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-mcp-lock-'));
  try {
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), /已有微信提问/);
    release();
    writeFileSync(join(dir, 'poll.lock'), JSON.stringify({ pid: 2147483646, nonce: 'dead' }));
    const recovered = acquireLock(dir);
    recovered();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('question numbers start at one and survive a new store and account re-login', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-mcp-counter-'));
  try {
    assert.equal(nextQuestionId(new StateStore(dir)), '1');
    const reopened = new StateStore(dir);
    reopened.write({ token: 'replacement-account' });
    assert.equal(nextQuestionId(reopened), '2');
    assert.equal(nextQuestionId(new StateStore(dir)), '3');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt counters fail closed instead of reusing question one', () => {
  for (const last of [-1, '1', undefined, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => nextQuestionId({ read: () => ({ last }), write: () => assert.fail('must not overwrite corrupt counter') }), /计数器无效/);
  }
});

test('question numbers reset exactly at 24 idle hours, not before, and only once', () => {
  const store = memoryStore();
  const idleAt = 100000;
  store.write({ last: 7 }, 'question-counter');
  markQuestionsIdle(store, idleAt);
  markQuestionsIdle(store, idleAt + 1000);
  assert.equal(store.read('question-counter').idleSince, idleAt);
  assert.equal(nextQuestionId(store, { now: idleAt + QUESTION_IDLE_RESET_MS - 1 }), '8');
  assert.equal(store.read('question-counter').idleSince, null);
  markQuestionsIdle(store, idleAt + QUESTION_IDLE_RESET_MS);
  assert.equal(nextQuestionId(store, { now: idleAt + 2 * QUESTION_IDLE_RESET_MS }), '1');
  assert.equal(nextQuestionId(store, { now: idleAt + 2 * QUESTION_IDLE_RESET_MS + 1, hasPending: true }), '2');
});

test('active questions prevent reset even if persisted idle metadata is old', () => {
  const store = memoryStore();
  store.write({ last: 9, idleSince: 1 }, 'question-counter');
  assert.equal(nextQuestionId(store, { now: QUESTION_IDLE_RESET_MS + 1, hasPending: true }), '10');
});

test('idle timestamp survives a reopened encrypted store', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-mcp-idle-'));
  try {
    const store = new StateStore(dir);
    assert.equal(nextQuestionId(store, { now: 1000 }), '1');
    markQuestionsIdle(store, 2000);
    const reopened = new StateStore(dir);
    markQuestionsIdle(reopened, 3000);
    assert.equal(reopened.read('question-counter').idleSince, 2000);
    assert.equal(nextQuestionId(reopened, { now: 2000 + QUESTION_IDLE_RESET_MS }), '1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
