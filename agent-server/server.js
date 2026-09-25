// The single, shared AG-UI endpoint.
//
//   GET  /spec   -> the WebMCP tool contract consumers must implement
//   POST /agent  -> AG-UI run (RunAgentInput in, SSE stream of AG-UI events out)
//   GET  /sdk/*  -> tiny browser SDK (WebMCP polyfill + AG-UI client)
//
// The agent has NO tools of its own and knows nothing about any platform.
// Every tool call it makes is streamed back to the caller and resolved in the
// caller's browser; the result comes back as a `tool` message on the next run.

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SPEC, REQUIRED_TOOL_NAMES } from './spec.js';
import { mockBrain } from './brains/mock.js';

const PORT = Number(process.env.AGENT_PORT ?? 4000);
const USE_CLAUDE = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && process.env.AGENT_BRAIN !== 'mock';
const brain = USE_CLAUDE ? (await import('./brains/claude.js')).claudeBrain : mockBrain;
const brainInfo = USE_CLAUDE
  ? { brain: 'claude', model: process.env.AGENT_MODEL ?? 'claude-opus-5' }
  : { brain: 'mock', model: 'scripted planner, no LLM' };

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/sdk', express.static(fileURLToPath(new URL('./sdk', import.meta.url))));

app.get('/spec', (_req, res) => res.json(SPEC));

app.post('/agent', async (req, res) => {
  const input = req.body ?? {};
  const threadId = input.threadId ?? randomUUID();
  const runId = input.runId ?? randomUUID();
  const messageId = `msg_${randomUUID()}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const ui = createEmitter(res, messageId);

  ui.send({ type: 'RUN_STARTED', threadId, runId });
  ui.send({ type: 'CUSTOM', name: 'agent_info', value: brainInfo });

  const provided = new Map((input.tools ?? []).map((t) => [t.name, t]));
  const missing = REQUIRED_TOOL_NAMES.filter((n) => !provided.has(n));
  if (missing.length) {
    ui.send({ type: 'RUN_ERROR', message: `Consumer does not implement required tools: ${missing.join(', ')}`, code: 'SPEC_NOT_SATISFIED' });
    return res.end();
  }

  // Spec tools use the agent's canonical schema (the consumer can't change the
  // contract). Extra, consumer-specific tools are passed through as-is.
  const tools = [
    ...SPEC.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ...[...provided.values()].filter((t) => !REQUIRED_TOOL_NAMES.includes(t.name)),
  ];

  const host = (input.context ?? []).find((c) => c.description === 'host')?.value ?? 'unknown host';
  console.log(`[agent] run ${runId.slice(0, 8)} from ${host} — ${input.messages?.length ?? 0} messages, ${tools.length} tools`);

  try {
    await brain({ messages: input.messages ?? [], tools, context: input.context ?? [], ui, messageId, threadId });
    ui.endText();
    ui.send({ type: 'RUN_FINISHED', threadId, runId });
  } catch (err) {
    console.error('[agent] run failed:', err);
    ui.endText();
    ui.send({ type: 'RUN_ERROR', message: err?.message ?? String(err) });
  }
  res.end();
});

// Translates brain callbacks into AG-UI events. One assistant message per run;
// text and tool calls both hang off `messageId`.
function createEmitter(res, messageId) {
  let textOpen = false;
  const send = (event) => res.write(`data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`);
  return {
    send,
    textDelta(delta) {
      if (!delta) return;
      if (!textOpen) {
        send({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
        textOpen = true;
      }
      send({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
    },
    endText() {
      if (textOpen) send({ type: 'TEXT_MESSAGE_END', messageId });
      textOpen = false;
    },
    toolStart(toolCallId, toolCallName) {
      this.endText();
      send({ type: 'TOOL_CALL_START', toolCallId, toolCallName, parentMessageId: messageId });
    },
    toolArgs(toolCallId, delta) {
      send({ type: 'TOOL_CALL_ARGS', toolCallId, delta });
    },
    toolEnd(toolCallId) {
      send({ type: 'TOOL_CALL_END', toolCallId });
    },
  };
}

app.listen(PORT, () => {
  console.log(`[agent] AG-UI endpoint on http://localhost:${PORT}/agent  (brain: ${brainInfo.brain}, ${brainInfo.model})`);
});
