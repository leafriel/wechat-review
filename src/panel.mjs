import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// Native Codex question cards have no supported withdrawal API; own the panel lifecycle instead.
export async function createPanel(question, { timeoutMs = 600000 } = {}) {
  const token = randomBytes(24).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  let result;
  let resolveResult;
  let wechatError;
  const done = new Promise(resolve => { resolveResult = resolve; });
  const settle = value => {
    if (result) return false;
    result = value;
    clearTimeout(timer);
    resolveResult(value);
    return true;
  };
  const timer = setTimeout(() => settle({ status: 'timeout' }), timeoutMs);
  const serialized = JSON.stringify(question).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>桌面与微信同步问答</title>
  <style>body{font:16px/1.65 system-ui;max-width:680px;margin:48px auto;padding:0 24px;color:#222;background:#f8fafc}section{background:white;border:1px solid #dce2e8;border-radius:16px;padding:28px}h1{font-size:22px}button{display:block;width:100%;text-align:left;margin:12px 0;padding:14px;font:inherit;border:1px solid #9daab8;background:white;border-radius:8px;cursor:pointer}button:hover{background:#eaf3ff}small{color:#596675}[hidden]{display:none!important}</style>
  <main><small>桌面与微信同步问答 · 首先回答的渠道生效</small><section id="form"><p id="context"></p><h1 id="question"></h1><div id="options"></div><div id="text-answer" hidden><label for="answer">文字回答（最多 2000 字符）</label><textarea id="answer" maxlength="2000" rows="3"></textarea><button id="submit">提交文字回答</button></div><button id="cancel">取消本题</button><small>任一渠道回答后题目收起。微信原消息保留为聊天记录，不再接受重复回答。</small></section><p id="state" role="status" aria-live="polite"></p></main>
  <script nonce="${nonce}">
  const q=${serialized};
  const form=document.querySelector('#form'),state=document.querySelector('#state');
  document.querySelector('#context').textContent=q.context||'';
  document.querySelector('#question').textContent=q.question;
  function update(data){if(data.status!=='pending'){form.hidden=true;state.textContent=data.status==='answered'?'已处理，题目已收起。回答渠道：'+(data.channel==='wechat'?'微信':'桌面'):'本题已结束，未执行任何操作。';return false}if(data.wechat_error)state.textContent='微信暂不可用，仍可在此回答。';return true}
  async function submit(body){try{const r=await fetch(location.pathname+'answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(r.status===400){state.textContent='请输入有效答案。';return}update(await r.json())}catch{state.textContent='连接中断，请等待恢复；未自动选择答案。'}}
  q.options.forEach((option,i)=>{const button=document.createElement('button');button.textContent=(i+1)+'. '+option;button.onclick=()=>submit({selected_index:i+1});document.querySelector('#options').append(button)});
  document.querySelector('#text-answer').hidden=!q.allow_text;
  document.querySelector('#submit').onclick=()=>submit({answer:document.querySelector('#answer').value});
  document.querySelector('#cancel').onclick=()=>submit({cancel:true});
  async function poll(){try{const r=await fetch(location.pathname+'state');if(update(await r.json()))setTimeout(poll,350)}catch{state.textContent='面板服务不可用，未自动选择答案。'}}poll();
  </script></html>`;
  let origin;
  const publicState = () => result ? { status: result.status, channel: result.channel } : { status: 'pending', wechat_error: !!wechatError };
  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, 'Referrer-Policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (req.headers.host !== new URL(origin).host || !req.url?.startsWith('/' + token + '/')) return send(404, { error: 'not_found' });
    if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'origin' });
    const route = req.url.slice(token.length + 2);
    if (req.method === 'GET' && route === '') return send(200, html, 'text/html');
    if (req.method === 'GET' && route === 'state') return send(200, publicState());
    if (req.method !== 'POST' || route !== 'answer') return send(404, { error: 'not_found' });
    if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return send(403, { error: 'origin' });
    let body = '';
    req.setEncoding('utf8');
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 16384) return send(413, { error: 'size' }); }
      const input = JSON.parse(body);
      let value;
      if (input.cancel === true) value = { status: 'cancelled', channel: 'desktop' };
      else if (Number.isInteger(input.selected_index) && input.selected_index >= 1 && input.selected_index <= question.options.length) {
        value = { status: 'answered', channel: 'desktop', selected_index: input.selected_index, selected_option: question.options[input.selected_index - 1], answer: question.options[input.selected_index - 1] };
      } else if (question.allow_text && typeof input.answer === 'string' && input.answer.trim().length > 0 && input.answer.trim().length <= 2000) {
        value = { status: 'answered', channel: 'desktop', answer: input.answer.trim() };
      } else return send(400, { error: 'answer' });
      const accepted = settle({ ...value, question: question.question, answered_at: new Date().toISOString() });
      return send(accepted ? 200 : 409, publicState());
    } catch { return send(400, { error: 'invalid_json' }); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { clearTimeout(timer); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/${token}/`, done, settle,
    wechatFailed(error) { wechatError = error; },
    close: () => { clearTimeout(timer); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}
