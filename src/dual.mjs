import { randomUUID } from 'node:crypto';
import { createPanel } from './panel.mjs';
import { askQuestion } from './broker-client.mjs';
import { questionSchema } from './schema.mjs';

export class DualQuestions {
  constructor({ ask = askQuestion, panel = createPanel, retentionMs = 300000 } = {}) {
    this.ask = ask;
    this.panel = panel;
    this.retentionMs = retentionMs;
    this.questions = new Map();
    this.closed = false;
  }

  async start(input) {
    if (this.closed) throw new Error('双渠道问答服务已关闭。');
    const question = questionSchema.parse(input);
    const panel = await this.panel(question, { timeoutMs: question.timeout_seconds * 1000 });
    if (this.closed) {
      panel.settle({ status: 'cancelled' });
      await panel.close();
      throw new Error('双渠道问答服务已关闭。');
    }
    const handle = randomUUID();
    const controller = new AbortController();
    const entry = { panel, controller };
    this.questions.set(handle, entry);
    entry.done = panel.done.then(result => {
      controller.abort(); // Disconnect only this question's broker socket.
      entry.cleanup = setTimeout(() => {
        this.questions.delete(handle);
        panel.close();
      }, this.retentionMs);
      entry.cleanup.unref();
      return { ...result, question_handle: handle };
    });
    Promise.resolve().then(() => this.ask(question, { signal: controller.signal })).then(result => {
      if (controller.signal.aborted) return;
      if (result.status === 'answered' || result.status === 'cancelled') panel.settle({ ...result, channel: 'wechat' });
      else panel.wechatFailed(result.status);
    }).catch(() => { if (!controller.signal.aborted) panel.wechatFailed('error'); });
    return { status: 'pending', question_handle: handle, desktop_url: panel.url, expires_at: new Date(Date.now() + question.timeout_seconds * 1000).toISOString() };
  }

  async wait(handle, { signal, cancel = false } = {}) {
    const entry = this.questions.get(handle);
    if (!entry) return { status: 'error', message: '本题不存在、已过期或不属于当前 MCP 连接；未选择任何选项。' };
    const onAbort = () => entry.panel.settle({ status: 'cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (cancel || signal?.aborted) onAbort();
    try { return await entry.done; }
    finally { signal?.removeEventListener('abort', onAbort); }
  }

  async close() {
    this.closed = true;
    const entries = [...this.questions.values()];
    for (const entry of entries) {
      entry.panel.settle({ status: 'cancelled' });
      await entry.done;
      clearTimeout(entry.cleanup);
      await entry.panel.close();
    }
    this.questions.clear();
  }
}
