import { describe, expect, it } from 'vitest';
import { answerMcpMessage, type McpServer, type McpTool } from './mcp-rpc.js';

/** The JSON-RPC half on its own: what a server lists is what reaches the client, field for field. */

const server = (tools: McpTool[]): McpServer => ({
  version: '1.0.0',
  listTools: () => Promise.resolve(tools),
  callTool: () => Promise.resolve(undefined),
});

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

describe('tools/list', () => {
  it('carries a tool\'s _meta through to the client unchanged', async () => {
    const tool: McpTool = {
      name: 'a',
      description: 'd',
      inputSchema: { type: 'object' },
      _meta: { 'anthropic/alwaysLoad': true, 'vendor/other': { n: 1 } },
    };
    const r = await answerMcpMessage(list, server([tool]));
    const wire = JSON.parse(JSON.stringify(r)) as { result: { tools: McpTool[] } };
    expect(wire.result.tools[0]!._meta).toEqual({ 'anthropic/alwaysLoad': true, 'vendor/other': { n: 1 } });
  });

  it('adds no _meta to a tool that has none', async () => {
    const r = await answerMcpMessage(list, server([{ name: 'a', description: 'd', inputSchema: {} }]));
    const wire = JSON.parse(JSON.stringify(r)) as { result: { tools: Record<string, unknown>[] } };
    expect(wire.result.tools[0]).not.toHaveProperty('_meta');
  });
});
