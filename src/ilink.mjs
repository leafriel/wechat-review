import { randomBytes, randomUUID } from 'node:crypto';

export const API_BASE = 'https://ilinkai.weixin.qq.com';

export function validateBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('微信 API 返回了不可信的服务器地址。');
  return url.origin;
}

export class ILink {
  constructor({ baseUrl = API_BASE, token, fetchImpl = fetch } = {}) {
    this.baseUrl = validateBaseUrl(baseUrl);
    this.token = token;
    this.fetch = fetchImpl;
  }
  async request(endpoint, { body, signal, timeoutMs = 40000 } = {}) {
    const headers = {
      'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132106',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) throw new Error('微信网络请求超时。');
      throw new Error('无法连接微信服务，请检查网络。');
    }
    if (!response.ok) throw new Error(`微信服务返回 HTTP ${response.status}。`);
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('微信响应过大。');
    let result;
    try { result = raw ? JSON.parse(raw) : {}; } catch { throw new Error('微信响应不是有效 JSON。'); }
    if ((result.ret ?? 0) !== 0 || (result.errcode ?? 0) !== 0) {
      const apiCode = (result.ret ?? 0) !== 0 ? result.ret : result.errcode;
      const expired = apiCode === -14;
      const needsContext = endpoint === 'ilink/bot/sendmessage' && apiCode === -2 && String(result.errmsg ?? '').trim().toLowerCase() === 'prepare failed';
      const error = new Error(expired ? '微信登录已过期，请重新扫码。' : needsContext
        ? '微信会话上下文已失效，请在机器人聊天发送“绑定”以恢复；未替你选择任何选项。'
        : `微信 API 请求失败（${apiCode}）。`);
      error.code = expired ? 'LOGIN_EXPIRED' : needsContext ? 'CONTEXT_REQUIRED' : 'ILINK_ERROR';
      throw error;
    }
    return result;
  }
  getQr(signal) {
    return this.request('ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, signal });
  }
  qrStatus(qrcode, verifyCode, signal) {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    return this.request(endpoint, { signal });
  }
  updates(cursor = '', signal, timeoutMs = 40000) {
    return this.request('ilink/bot/getupdates', {
      body: { get_updates_buf: cursor, base_info: { channel_version: '2.4.10', bot_agent: 'WeChatQuestionSkill/0.1.0' } }, signal, timeoutMs,
    });
  }
  send(account, text, signal) {
    if (!account.ownerId || !account.contextToken) throw new Error('请先在微信给机器人发送“绑定”，完成首次连接。');
    return this.request('ilink/bot/sendmessage', {
      body: {
        base_info: { channel_version: '2.4.10', bot_agent: 'WeChatQuestionSkill/0.1.0' },
        msg: {
          from_user_id: '', to_user_id: account.ownerId, client_id: randomUUID(),
          message_type: 2, message_state: 2,
          item_list: [{ type: 1, text_item: { text } }], context_token: account.contextToken,
        },
      }, signal, timeoutMs: 15000,
    });
  }
}

export function ownerMessages(batch, account) {
  return (batch.msgs ?? []).filter(msg => msg.from_user_id === account.ownerId && !msg.group_id && msg.message_type === 1);
}

export function messageText(msg) {
  return (msg.item_list ?? []).filter(item => item.type === 1).map(item => item.text_item?.text ?? '').join('\n').trim();
}

export function updateAccount(batch, account) {
  for (const msg of ownerMessages(batch, account)) {
    if (msg.context_token) account.contextToken = msg.context_token;
  }
  if (typeof batch.get_updates_buf === 'string') account.cursor = batch.get_updates_buf;
}
