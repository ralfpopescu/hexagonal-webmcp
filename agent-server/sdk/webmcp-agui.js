// Browser SDK served by the agent platform. A consumer page imports this, registers
// its WebMCP tool implementations, and chats. That's the whole integration.
//
//   import { modelContext, implementSpec, AgentSession } from '<agent>/sdk/webmcp-agui.js'
//
// 1. WebMCP: a minimal `document.modelContext` polyfill (registerTool / provideContext).
//    If the browser has native WebMCP, tools are also registered there, so browser
//    agents can use the same tools the shared agent does.
// 2. AG-UI client: POSTs RunAgentInput, parses the SSE event stream, executes any
//    tool calls against the registered WebMCP tools *in this page*, appends the
//    results as `tool` messages, and starts the next run until the agent stops.

// ---------------------------------------------------------------- WebMCP ----

// The SDK keeps its own registry because it has to enumerate tools to send them
// over AG-UI, and the native API doesn't expose a page's tools back to the page.
const registry = new Map();

// Native WebMCP, if present. `navigator.modelContext` is the deprecated name.
const native = globalThis.document?.modelContext ?? globalThis.navigator?.modelContext ?? null;
const mirror = (fn) => {
  try {
    fn();
  } catch {
    /* native registration is a bonus; the shared agent works without it */
  }
};

export const modelContext = {
  registerTool(tool) {
    if (!tool?.name || typeof tool.execute !== 'function') {
      throw new TypeError('registerTool: `name` and `execute()` are required');
    }
    registry.set(tool.name, tool);
    if (native) mirror(() => native.registerTool(tool));
    return { unregister: () => this.unregisterTool(tool.name) };
  },
  unregisterTool(name) {
    registry.delete(name);
    if (native) mirror(() => native.unregisterTool(name));
  },
  provideContext({ tools = [] } = {}) {
    [...registry.keys()].forEach((name) => this.unregisterTool(name));
    tools.forEach((t) => this.registerTool(t));
  },
  listTools() {
    return [...registry.values()];
  },
};

if (!native) {
  for (const host of [globalThis.document, globalThis.navigator]) {
    if (!host) continue;
    try {
      Object.defineProperty(host, 'modelContext', { value: modelContext, configurable: true });
    } catch {
      /* read-only host object: fine, use the export */
    }
  }
}

// Register one WebMCP tool per spec entry, using the spec's schema, with the
// consumer's own implementation. `handlers[name]` is either an async function
// or { description, execute } to add host-specific wording.
export function implementSpec(spec, handlers) {
  for (const def of spec.tools) {
    const h = handlers[def.name];
    if (!h) continue;
    const execute = typeof h === 'function' ? h : h.execute;
    modelContext.registerTool({
      name: def.name,
      description: h.description ?? def.description,
      inputSchema: def.parameters,
      execute,
    });
  }
  return checkConformance(spec);
}

// Human-in-the-loop enforced by the host, not by the model. The agent is told
// to ask before acting, but a prompt-injected model might not; this makes the
// write tool refuse anything the user didn't confirm, exactly as confirmed, once.
//
//   confirm tool: return gate.record(`${id}:${action}`, confirmed, params)
//   write tool:   gate.consume(`${id}:${action}`, params)
export function createApprovalGate() {
  const approved = new Map();
  return {
    record(key, confirmed, value) {
      if (confirmed) approved.set(key, stableJson(value));
      else approved.delete(key);
    },
    consume(key, value) {
      if (approved.get(key) !== stableJson(value)) {
        throw new Error(`Refused: the customer has not confirmed "${key}" with these exact parameters. Call confirm_action first and pass exactly the params it returned.`);
      }
      approved.delete(key);
    },
  };
}

const stableJson = (v) =>
  JSON.stringify(v ?? {}, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );

export function checkConformance(spec) {
  const have = new Set(registry.keys());
  const required = spec.tools.map((t) => t.name);
  const missing = required.filter((n) => !have.has(n));
  return { ok: missing.length === 0, missing, extra: [...have].filter((n) => !required.includes(n)) };
}

export async function fetchSpec(agentUrl) {
  const res = await fetch(`${agentUrl}/spec`);
  if (!res.ok) throw new Error(`Could not load agent spec (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------- AG-UI -----

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

export class AgentSession {
  constructor({ agentUrl, context = [], onEvent = () => {}, maxSteps = 30 }) {
    this.agentUrl = agentUrl;
    this.context = context;
    this.onEvent = onEvent;
    this.maxSteps = maxSteps;
    this.threadId = uid('thread');
    this.messages = [];
  }

  async send(text) {
    this.messages.push({ id: uid('msg'), role: 'user', content: text });
    for (let step = 0; step < this.maxSteps; step++) {
      const assistant = await this.#run();
      if (!assistant?.toolCalls?.length) return;
      for (const tc of assistant.toolCalls) await this.#resolveToolCall(tc);
    }
    throw new Error(`Agent did not finish within ${this.maxSteps} steps`);
  }

  async #resolveToolCall(tc) {
    const name = tc.function.name;
    const tool = registry.get(name);
    let args = null;
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      /* handled below */
    }
    this.onEvent({ type: 'LOCAL_TOOL_EXECUTE', toolCallId: tc.id, toolCallName: name, args });

    let content;
    let error;
    try {
      if (!tool) throw new Error(`Tool "${name}" is not implemented by this host`);
      if (args === null) throw new Error('Tool arguments were not valid JSON');
      const result = await tool.execute(args, { toolCallId: tc.id });
      content = typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true });
    } catch (e) {
      error = e?.message ?? String(e);
      content = JSON.stringify({ error });
    }
    this.messages.push({ id: uid('msg'), role: 'tool', toolCallId: tc.id, content, ...(error && { error }) });
    this.onEvent({ type: 'LOCAL_TOOL_RESULT', toolCallId: tc.id, toolCallName: name, result: content, error });
  }

  async #run() {
    const input = {
      threadId: this.threadId,
      runId: uid('run'),
      messages: this.messages,
      tools: [...registry.values()].map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema })),
      context: this.context,
      state: {},
      forwardedProps: {},
    };
    const res = await fetch(`${this.agentUrl}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(input),
    });
    if (!res.ok || !res.body) throw new Error(`Agent endpoint returned ${res.status}`);

    let assistant = null;
    const calls = new Map();
    const ensure = (id) => (assistant ??= { id, role: 'assistant', content: '', toolCalls: [] });

    for await (const ev of readSSE(res.body)) {
      this.onEvent(ev);
      switch (ev.type) {
        case 'TEXT_MESSAGE_START':
          ensure(ev.messageId);
          break;
        case 'TEXT_MESSAGE_CONTENT':
          ensure(ev.messageId).content += ev.delta;
          break;
        case 'TOOL_CALL_START': {
          const tc = { id: ev.toolCallId, type: 'function', function: { name: ev.toolCallName, arguments: '' } };
          calls.set(ev.toolCallId, tc);
          ensure(ev.parentMessageId ?? uid('msg')).toolCalls.push(tc);
          break;
        }
        case 'TOOL_CALL_ARGS':
          calls.get(ev.toolCallId).function.arguments += ev.delta;
          break;
        case 'RUN_ERROR':
          throw new Error(ev.message);
      }
    }

    if (assistant) {
      if (!assistant.toolCalls.length) delete assistant.toolCalls;
      this.messages.push(assistant);
    }
    return assistant;
  }
}

async function* readSSE(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}
