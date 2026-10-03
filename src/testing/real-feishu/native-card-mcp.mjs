import readline from 'node:readline';

// 独立的原生 MCP 服务端 fixture：仅通过 stdio 请求问答，不浏览 URL、不访问用户数据。
const runId = process.argv[2] || 'fixture';
const pending = new Map();
let sequence = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'codelark-cards', version: '1' } });
  if (message.method === 'tools/list') return reply({ tools: ['form', 'url'].map((name) => ({
    name, description: `Isolated lifecycle ${name} card; no network access.`, inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  })) });
  if (message.method === 'tools/call') {
    const id = `elicitation-${++sequence}`;
    pending.set(id, message.id);
    send({ id, method: 'elicitation/create', params: message.params.name === 'url' ? {
      mode: 'url', elicitationId: id,
      message: `LIFECYCLE_MCP_URL_${runId}：这是本地测试链接，请直接点击取消，无需打开。`,
      url: `http://127.0.0.1:9/codelark-fixture?run=${encodeURIComponent(runId)}&note=%3Ctest%3E`,
    } : {
      mode: 'form', message: `LIFECYCLE_MCP_FORM_${runId}`,
      requestedSchema: { type: 'object', required: ['count', 'enabled'], properties: {
        count: { type: 'integer', minimum: 1, maximum: 3, description: '输入 1 到 3；验收先试越界 0，再输入上界 3。' },
        enabled: { type: 'boolean', description: '本次验收填 false。' },
      } },
    } });
  } else if (pending.has(message.id)) {
    send({ id: pending.get(message.id), result: { content: [{ type: 'text', text: JSON.stringify(message.result) }] } });
    pending.delete(message.id);
  } else if (message.method === 'ping') reply({});
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } });
});
