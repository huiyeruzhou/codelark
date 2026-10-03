import readline from 'node:readline';

// 本地 MCP fixture；只返回输入内容，不联网、不执行命令、不访问用户数据。
const pending = new Map();
let sequence = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'codelark-fixture', version: '1' } });
  if (message.method === 'tools/list') return reply({ tools: [{ name: 'ask', description: 'Read user input in this isolated test.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] });
  if (message.method === 'tools/call') {
    const id = `elicitation-${++sequence}`;
    pending.set(id, message.id);
    send({ id, method: 'elicitation/create', params: {
      mode: 'form', message: 'NATIVE_MCP_FORM', requestedSchema: {
        type: 'object', required: ['count', 'enabled'], properties: { count: { type: 'integer', minimum: 1, maximum: 3 }, enabled: { type: 'boolean' } },
      },
    } });
    return;
  }
  if (pending.has(message.id)) {
    send({ id: pending.get(message.id), result: { content: [{ type: 'text', text: JSON.stringify(message.result) }] } });
    pending.delete(message.id);
  } else if (message.method === 'ping') reply({});
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } });
});
