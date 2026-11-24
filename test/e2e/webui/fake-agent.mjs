// Minimal ACP agent over stdio for Web UI e2e tests.
// Behavior per request is read from $FAKE_MODE: ok | rich | slow | prompt-error | refuse | hang.
import fs from 'node:fs';
import readline from 'node:readline';

const agentId = process.env.FAKE_AGENT || 'alpha';
const modeFile = process.env.FAKE_MODE || '';
const logFile = process.env.FAKE_LOG || '';

function readMode() {
  if (!modeFile) return 'ok';
  try {
    return fs.readFileSync(modeFile, 'utf8').trim() || 'ok';
  } catch {
    return 'ok';
  }
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, message, data) {
  const error = data ? { code: -32603, message, data } : { code: -32603, message };
  send({ jsonrpc: '2.0', id, error });
}

function emitUpdate(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

function extractPromptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function handlePrompt(msg, mode) {
  const sessionId = String(msg.params?.sessionId ?? '');
  const prompt = extractPromptText(msg.params);
  if (logFile) {
    fs.appendFileSync(logFile, `${JSON.stringify({ agent: agentId, sessionId, prompt })}\n`);
  }
  if (mode === 'prompt-error') {
    fail(msg.id, 'synthetic prompt failure');
    return;
  }
  if (mode === 'rich' || mode === 'slow') {
    emitUpdate(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read src/sample.ts',
      kind: 'read',
      status: 'completed',
    });
    emitUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: `Rich reply (${agentId}) for: ${prompt}\n\n- item one\n- item two\n\n\`\`\`ts\nexport const ok = true;\n\`\`\``,
      },
    });
    if (mode === 'slow') return;
    reply(msg.id, { stopReason: 'end_turn' });
    return;
  }
  // Stream in two chunks so e2e tests exercise live update + final settle.
  emitUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `echo(${agentId}): ` },
  });
  setTimeout(() => {
    emitUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: prompt },
    });
    reply(msg.id, { stopReason: 'end_turn' });
  }, 40);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const mode = readMode();
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    return;
  }
  if (msg.method === 'session/new') {
    if (mode === 'refuse') {
      fail(msg.id, 'session refused', 'synthetic session/new refusal');
      return;
    }
    if (mode === 'hang') return;
    reply(msg.id, { sessionId: `${agentId}-${process.pid}-${Date.now()}` });
    return;
  }
  if (msg.method === 'session/prompt') {
    handlePrompt(msg, mode);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    reply(msg.id, {});
  }
});
