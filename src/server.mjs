import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StateStore } from './state.mjs';
import { askQuestion } from './broker-client.mjs';
import { questionSchema } from './schema.mjs';

const store = new StateStore();
const server = new McpServer({ name: 'wechat-question', version: '0.1.0' });
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

await server.connect(new StdioServerTransport());
