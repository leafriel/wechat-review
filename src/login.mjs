import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { StateStore, acquireLock } from './state.mjs';
import { ILink, API_BASE, validateBaseUrl, updateAccount, ownerMessages } from './ilink.mjs';
import { stopBroker } from './broker-client.mjs';

const store = new StateStore();
let release = () => {};
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
let readline;
try {
  const stopped = await stopBroker(store.directory);
  if (stopped.status === 'busy') throw new Error(stopped.message);
  release = acquireLock(store.directory);
  let api = new ILink();
  let account = store.read();
  if (!account?.token || process.argv.includes('--force')) {
    let qr = await api.getQr(deadline);
    let verifyCode;
    let refreshes = 0;
    let previousStatus;
    const showQr = async () => {
      if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('微信没有返回二维码。');
      const path = join(store.directory, 'login-qr.png');
      await QRCode.toFile(path, qr.qrcode_img_content, { width: 480, margin: 3 });
      console.log(JSON.stringify({ event: 'qr_ready', image: path }));
    };
    await showQr();
    while (!deadline.aborted) {
      let status;
      try { status = await api.qrStatus(qr.qrcode, verifyCode, deadline); }
      catch (error) { if (deadline.aborted) throw error; await delay(1000); continue; }
      if (status.status !== previousStatus) console.log(JSON.stringify({ event: 'login_status', status: status.status }));
      previousStatus = status.status;
      if (status.status === 'confirmed') {
        if (!status.bot_token || !status.ilink_user_id || !status.ilink_bot_id) throw new Error('微信未返回完整的账号与本人身份信息，未保存。');
        account = { token: status.bot_token, ownerId: status.ilink_user_id, botId: status.ilink_bot_id, baseUrl: validateBaseUrl(status.baseurl || api.baseUrl), cursor: '' };
        store.write(account);
        break;
      }
      if (status.status === 'scaned_but_redirect') {
        api = new ILink({ baseUrl: validateBaseUrl(`https://${status.redirect_host}`) });
      } else if (status.status === 'need_verifycode') {
        readline ??= createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        console.log(JSON.stringify({ event: 'verify_code_required' }));
        verifyCode = (await readline.question('输入微信上显示的配对数字：', { signal: deadline })).trim();
        if (!/^\d{4,12}$/.test(verifyCode)) throw new Error('配对数字格式不正确。');
      } else if (status.status === 'expired' || status.status === 'verify_code_blocked') {
        if (++refreshes > 3) throw new Error('二维码多次过期，请重新运行 npm run login。');
        api = new ILink({ baseUrl: API_BASE });
        qr = await api.getQr(deadline);
        verifyCode = undefined;
        await showQr();
      } else if (status.status === 'binded_redirect') {
        throw new Error('此机器人已绑定其他登录。请在微信选择新增机器人后重试。');
      }
      await delay(750, undefined, { signal: deadline });
    }
  }
  if (!account?.token) throw new Error('扫码登录未完成。');
  api = new ILink(account);
  if (!account.contextToken) {
    console.log(JSON.stringify({ event: 'send_binding_message', message: '请在微信给刚绑定的机器人发送：绑定' }));
    while (!deadline.aborted && !account.contextToken) {
      let batch;
      try { batch = await api.updates(account.cursor, deadline); }
      catch (error) { if (deadline.aborted || error.code === 'LOGIN_EXPIRED') throw error; await delay(1000); continue; }
      updateAccount(batch, account);
      store.write(account);
      console.log(JSON.stringify({ event: 'binding_poll', received: batch.msgs?.length ?? 0, owner_messages: ownerMessages(batch, account).length, context_ready: !!account.contextToken }));
    }
  }
  if (!account.contextToken) throw new Error('等待微信绑定消息超时。');
  await api.send(account, 'Codex 微信问答已连接。之后收到问题时，请按提示回复“题号 选项编号”。', deadline);
  console.log(JSON.stringify({ event: 'connected', owner_bound: true, context_ready: true }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  readline?.close();
  release();
}
