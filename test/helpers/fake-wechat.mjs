import assert from 'node:assert/strict';

export function memoryStore(account = { token: 'test-token', ownerId: 'owner', contextToken: 'context', cursor: 'old' }) {
  const values = new Map([['account', structuredClone(account)]]);
  return {
    read: (name = 'account') => structuredClone(values.get(name) ?? null),
    write: (value, name = 'account') => values.set(name, structuredClone(value)),
  };
}

export function ownerMessage(text, extra = {}) {
  return { from_user_id: 'owner', message_type: 1, create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }], ...extra };
}

export function fakeWeChat() {
  const sends = [];
  const batches = [];
  const sentWaiters = new Set();
  let wake;
  let activePolls = 0;
  let maxActivePolls = 0;
  let cursor = 0;
  return {
    sends,
    get maxActivePolls() { return maxActivePolls; },
    deliver(msgs) { batches.push({ msgs, get_updates_buf: `cursor-${++cursor}` }); wake?.(); },
    waitForSends(count) {
      if (sends.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { sentWaiters.delete(check); reject(new Error(`Only ${sends.length}/${count} questions sent`)); }, 15000);
        const check = () => { if (sends.length >= count) { clearTimeout(timer); sentWaiters.delete(check); resolve(); } };
        sentWaiters.add(check);
      });
    },
    client: {
      async send(account, text) {
        assert.equal(account.ownerId, 'owner');
        sends.push({ text, id: text.match(/【([1-9]\d*)】/)?.[1] });
        for (const check of sentWaiters) check();
      },
      async updates(_, signal) {
        activePolls++;
        maxActivePolls = Math.max(maxActivePolls, activePolls);
        try {
          while (!batches.length) {
            signal.throwIfAborted();
            await new Promise((resolve, reject) => {
              const cleanup = () => { signal.removeEventListener('abort', onAbort); wake = null; };
              const onAbort = () => { cleanup(); reject(signal.reason); };
              wake = () => { cleanup(); resolve(); };
              signal.addEventListener('abort', onAbort, { once: true });
            });
          }
          signal.throwIfAborted();
          return batches.shift();
        } finally { activePolls--; }
      },
    },
  };
}
