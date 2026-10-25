import { setTimeout as delay } from 'node:timers/promises';
import { ILink, ownerMessages, messageText, updateAccount } from './ilink.mjs';
import { nextQuestionId, markQuestionsIdle } from './state.mjs';
import { conversationSchema } from './schema.mjs';

export function parseAnswer(text, questionId, options, allowText = true) {
  const match = text.trim().match(/^([1-9]\d*)\s+([\s\S]+)$/);
  if (!match || match[1] !== String(questionId)) return null;
  const answer = match[2].trim();
  if (answer === '取消' || answer.toLowerCase() === 'cancel') return { status: 'cancelled' };
  if (/^\d+$/.test(answer)) {
    const index = Number(answer) - 1;
    if (index < 0 || index >= options.length) return { status: 'invalid' };
    return { status: 'answered', selected_index: index + 1, selected_option: options[index], answer: options[index] };
  }
  const index = options.indexOf(answer);
  if (index !== -1) return { status: 'answered', selected_index: index + 1, selected_option: options[index], answer };
  if (allowText && answer.length <= 2000) return { status: 'answered', answer };
  return { status: 'invalid' };
}

export class QuestionRouter {
  constructor({ store, makeClient = account => new ILink(account), now = Date.now, onChange = () => {} }) {
    this.store = store;
    this.makeClient = makeClient;
    this.now = now;
    this.onChange = onChange;
    this.pending = new Map();
    this.pollPromise = null;
    this.closed = false;
  }

  async ask(input, { signal } = {}) {
    if (this.closed) throw new Error('微信接收进程已停止，请重试。');
    if (signal?.aborted) return { status: 'cancelled', sent: false };
    const source = conversationSchema.safeParse(input);
    if (!source.success) return { status: 'error', sent: false, message: source.error.issues[0].message };
    const conversation = source.data.conversation_title || source.data.conversation_id;
    if (!this.account) {
      const account = this.store.read();
      if (!account?.token || !account.ownerId || !account.contextToken) return { status: 'not_connected', message: '请完成 npm run login，并在微信发送“绑定”。' };
      this.account = account;
      this.client = this.makeClient(account);
    }
    const questionId = nextQuestionId(this.store, { now: this.now(), hasPending: this.pending.size > 0 });
    const text = [
      `Codex 等你选择【${questionId}】`,
      `对话：${conversation}`,
      input.context ? `任务：${input.context}` : '', input.question,
      ...input.options.map((option, index) => `${index + 1}. ${option}`),
      `回复：${questionId} 选项编号，例如“${questionId} 1”`,
      input.allow_text ? `也可回复“${questionId} 你的文字答案”` : '',
      `取消：${questionId} 取消`, `等待 ${input.timeout_seconds} 秒；超时不会替你选择。`,
    ].filter(Boolean).join('\n');
    return new Promise(resolve => {
      const controller = new AbortController();
      const entry = { input, text, questionId, resolve, controller, sent: false, sentAt: this.now(), expiresAt: this.now() + input.timeout_seconds * 1000 };
      entry.onAbort = () => this.finish(questionId, { status: 'cancelled' });
      entry.signal = signal;
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      entry.timer = setTimeout(() => this.finish(questionId, { status: 'timeout', message: entry.waitingForContext
        ? '微信会话上下文失效，题目未送达。请在机器人聊天发送“绑定”后重试；未选择任何选项。'
        : '等待微信回复超时；未选择任何选项。' }), input.timeout_seconds * 1000);
      this.pending.set(questionId, entry);
      this.onChange();
      this.sendQuestion(entry);
    });
  }

  sendQuestion(entry) {
    if (!this.pending.has(entry.questionId) || entry.sending) return;
    entry.sending = true;
    Promise.resolve().then(() => {
      if (!this.pending.has(entry.questionId) || entry.controller.signal.aborted) return;
      entry.waitingForContext = false;
      entry.contextUsed = this.account.contextToken;
      entry.sentAt = this.now();
      return this.client.send(this.account, entry.text, entry.controller.signal);
    }).then(() => {
      if (!this.pending.has(entry.questionId)) return;
      entry.sent = true;
      this.ensurePolling();
    }).catch(error => {
      if (!this.pending.has(entry.questionId)) return;
      if (error.code === 'CONTEXT_REQUIRED') {
        // This explicit rejection was not delivered. Poll for fresh owner context before retrying the same ID.
        entry.waitingForContext = true;
        this.ensurePolling();
      } else this.finish(entry.questionId, { status: 'error', message: error.message });
    }).finally(() => {
      entry.sending = false;
      if (entry.waitingForContext && entry.contextUsed !== this.account.contextToken) this.sendQuestion(entry);
    });
  }

  finish(questionId, result) {
    const entry = this.pending.get(questionId);
    if (!entry) return;
    this.pending.delete(questionId);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.controller.abort();
    if (!this.pending.size) {
      try { markQuestionsIdle(this.store, this.now()); }
      catch (error) { result = { ...result, warning: `未能保存空闲开始时间，题号重置可能延后：${error.message}` }; }
      this.pollController?.abort();
    }
    entry.resolve({ ...result, question_id: questionId, question: entry.input.question, sent: entry.sent,
      ...(result.status === 'answered' ? { answered_at: new Date(this.now()).toISOString() } : {}),
    });
    this.onChange();
  }

  ensurePolling() {
    if (this.pollPromise || !this.pending.size || this.closed) return;
    this.pollController = new AbortController();
    this.pollPromise = this.poll(this.pollController.signal).catch(error => {
      for (const id of [...this.pending.keys()]) this.finish(id, { status: 'error', message: error.message });
    }).finally(() => {
      this.pollPromise = null;
      this.ensurePolling();
    });
  }

  async poll(signal) {
    let consecutiveErrors = 0;
    while (this.pending.size && !signal.aborted) {
      let batch;
      try { batch = await this.client.updates(this.account.cursor, signal); consecutiveErrors = 0; }
      catch (error) {
        if (signal.aborted) return;
        if (error.code === 'LOGIN_EXPIRED' || ++consecutiveErrors >= 3) throw error;
        try { await delay(1000, undefined, { signal }); } catch { return; }
        continue;
      }
      if (signal.aborted) return;
      const previous = [this.account.cursor, this.account.contextToken];
      updateAccount(batch, this.account);
      if (previous[0] !== this.account.cursor || previous[1] !== this.account.contextToken) this.store.write(this.account);
      for (const entry of this.pending.values()) {
        if (entry.waitingForContext && entry.contextUsed !== this.account.contextToken) this.sendQuestion(entry);
      }
      for (const msg of ownerMessages(batch, this.account)) {
        const text = messageText(msg);
        const entry = this.pending.get(text.match(/^([1-9]\d*)\s+/)?.[1]);
        if (!entry) continue;
        if (entry.waitingForContext) continue;
        if (this.now() >= entry.expiresAt) { this.finish(entry.questionId, { status: 'timeout' }); continue; }
        if (msg.create_time_ms && msg.create_time_ms < entry.sentAt - 5000) continue;
        const answer = parseAnswer(text, entry.questionId, entry.input.options, entry.input.allow_text);
        if (!answer) continue;
        if (answer.status === 'invalid') {
          this.client.send(this.account, `对话：${entry.input.conversation_title || entry.input.conversation_id}\n【${entry.questionId}】答案未识别，请回复“${entry.questionId} 1”至“${entry.questionId} ${entry.input.options.length}”。`, entry.controller.signal).catch(() => {});
          continue;
        }
        this.finish(entry.questionId, answer);
      }
      if (!batch.msgs?.length && !signal.aborted) {
        try { await delay(100, undefined, { signal }); } catch { return; }
      }
    }
  }

  async close() {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.finish(id, { status: 'cancelled', message: '微信接收进程已停止。' });
    this.pollController?.abort();
    await this.pollPromise;
  }
}
