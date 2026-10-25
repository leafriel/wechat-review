import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stopBroker } from '../src/broker-client.mjs';

test('real MCP stdio handshake lists tools and returns structured unpaired status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-mcp-protocol-'));
  const client = new Client({ name: 'wechat-question-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...process.env, WECHAT_QUESTION_STATE_DIR: dir }, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['ask_wechat', 'wechat_status']);
    const status = await client.callTool({ name: 'wechat_status', arguments: {} });
    assert.equal(status.structuredContent.connected, false);
    const answer = await client.callTool({ name: 'ask_wechat', arguments: { question: '测试？', options: ['选项一', '选项二'] } });
    assert.equal(answer.structuredContent.status, 'not_connected');
    const invalid = await client.callTool({ name: 'ask_wechat', arguments: { question: '测试？', options: ['重复', '重复'] } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await stopBroker(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
