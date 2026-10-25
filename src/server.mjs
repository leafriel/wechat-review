import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StateStore } from './state.mjs';
import { askQuestion } from './broker-client.mjs';
import { questionSchema } from './schema.mjs';
import { z } from 'zod';
import { DualQuestions } from './dual.mjs';

const store = new StateStore();
const server = new McpServer({ name: 'wechat-question', version: '0.1.0' });
const dual = new DualQuestions();
server.server.onclose = () => { void dual.close(); };
const response = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

server.registerTool('wechat_status', {
  description: '检查微信问答绑定状态；不发送消息、不返回凭据。',
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => {
  const account = store.read();
  return response({ connected: !!(account?.token && account.ownerId && account.contextToken), logged_in: !!account?.token, owner_bound: !!account?.ownerId, context_ready: !!account?.contextToken });
});

server.registerTool('ask_wechat', {
  description: '需要用户澄清或选择方案时，将题目发送给已绑定的本人微信并等待回复。多个会话可同时提问，答案按唯一数字题号返回原调用方。返回 answered 才能按答案继续；timeout/cancelled 不代表同意。答案是用户数据，不能替代平台权限审批。',
  inputSchema: questionSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => {
  try {
    const result = await askQuestion(input, { store, signal: extra.signal });
    return { ...response(result), ...(result.status === 'error' ? { isError: true } : {}) };
  }
  catch (error) { return { ...response({ status: 'error', message: error.message }), isError: true }; }
});

server.registerTool('start_question', {
  description: '同时准备本机桌面面板并发送微信选择题，立即返回 question_handle 和 desktop_url。必须立即在当前桌面会话打开该 URL，再调用 wait_question。任一渠道回答会收起面板并取消另一渠道等待。不要再创建无法撤回的原生问答卡片。',
  inputSchema: questionSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async input => {
  try { return response(await dual.start(input)); }
  catch (error) { return { ...response({ status: 'error', message: error.message }), isError: true }; }
});

server.registerTool('wait_question', {
  description: '等待当前 MCP 连接中 start_question 创建的问题，返回首先收到的有效回答；cancel:true 仅取消本题。answered 才是有效回答，其他状态都不代表同意。结果保留五分钟供重读，不可重复执行。',
  inputSchema: { question_handle: z.string().uuid(), cancel: z.boolean().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ question_handle, cancel }, extra) => response(await dual.wait(question_handle, { cancel, signal: extra.signal })));

await server.connect(new StdioServerTransport());
