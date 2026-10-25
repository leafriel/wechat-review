import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'status';
if (!['status', 'ask', 'dual'].includes(mode)) throw new Error('Usage: node src/call.mjs status|ask|dual (ask/dual read JSON from stdin)');
let input = {};
if (mode === 'ask' || mode === 'dual') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const client = new Client({ name: 'codex-current-chat-wechat', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], stderr: 'inherit' }));
  let result = await client.callTool({ name: mode === 'dual' ? 'start_question' : mode === 'ask' ? 'ask_wechat' : 'wechat_status', arguments: input }, undefined, { timeout: 660000 });
  if (mode === 'dual' && result.structuredContent?.status === 'pending') {
    console.log(JSON.stringify(result.structuredContent));
    result = await client.callTool({ name: 'wait_question', arguments: { question_handle: result.structuredContent.question_handle } }, undefined, { timeout: 660000 });
    // Let an open panel observe the settled result before closing this stdio connection.
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  console.log(JSON.stringify(result.structuredContent ?? result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
