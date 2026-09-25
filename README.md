# Hexagonal WebMCP

**The agent declares its ports as a WebMCP spec; each host implements the adapters.**

Hexagonal WebMCP is ports-and-adapters architecture applied to agents. One shared agent
(the core) publishes the tools it needs as a WebMCP spec (the ports). Every product that
wants the agent implements those tools in its own frontend (the adapters), against its own
data and UI. The result is one intelligence layer that any team can plug into by writing a
few browser functions.

It's built on two open protocols:

- **[AG-UI](https://docs.ag-ui.com)**: a streaming event protocol between an agent and a frontend.
- **[WebMCP](https://github.com/webmachinelearning/webmcp)**: a proposal for web pages to expose tools to agents (`navigator.modelContext`).

The agent has **no tools of its own** and knows nothing about any platform. When it wants
to act, it emits a tool call over AG-UI, and the host page resolves it with its own code,
data, and UI.

The demo has one product-enrichment agent and two unrelated consumers that share no data
access, data model, or UI.

| | **Maple & Co.** · `:3001` | **NORDLAGER PIM** · `:3002` |
|---|---|---|
| Business | DTC home-goods storefront | Industrial B2B fasteners |
| Data lives in | Its own REST API (server) | IndexedDB (browser only, no backend) |
| Record shape | Shopify-style: `body_html`, CSV tags, variants, metafields | `sku`, `texts.{en,de}`, spec sheet, ETIM class, revisions, audit log |
| `request_approval` | Modal; merchant can edit the draft | Inline diff in a console; `y` / `n` |
| `show_product_card` | Storefront preview card | Technical datasheet panel |
| Voice it asks for | Warm, sensory | Technical, metric, no adjectives |
| Extra tools | – | `lookup_etim_class` (not in the spec) |

---

## Why this pattern

### The problem

You have one good agent, such as product enrichment, and many teams that want it:
the storefront, the B2B portal, the internal PIM, the marketplace-seller app. Each has a
different catalog, a different API, different auth, and a different UI.

The usual approaches each break down in their own way:

- **The agent integrates with every platform.** The agent team now owns N API clients,
  N sets of service credentials, and N data models. Every platform change breaks the agent,
  and every new consumer waits in the agent team's backlog.
- **Every team builds its own agent.** Prompts, evals, and model upgrades get duplicated N
  times and drift apart. Nobody gets the benefit of one team's improvements.
- **Each platform hosts an MCP server for the agent.** That's better, but every team now
  runs, secures, and deploys a backend service, and the agent needs network reach and
  credentials for each one.

### Shared brain, local hands

**Put the intelligence in one place and do all tool execution in the host page.**

```
                      ┌─────────────────────────────────┐
                      │  Central agent  (one team)      │
                      │  prompts · model · evals        │
                      │  publishes: GET /spec           │
                      │  serves:    POST /agent (AG-UI) │
                      │  owns: no tools, no credentials │
                      └───────▲───────────────▲─────────┘
     RunAgentInput{tools, ctx}│               │RunAgentInput{tools, ctx}
       ▼ TOOL_CALL_* events   │               │   ▼ TOOL_CALL_* events
┌─────────────────────────────┴──┐     ┌──────┴─────────────────────────┐
│ Team A frontend                │     │ Team B frontend                │
│ webmcp.js: 5 functions         │     │ webmcp.js: 5 functions         │
│ → own API, own auth, own UI    │     │ → own DB, own auth, own UI     │
└────────────────────────────────┘     └────────────────────────────────┘
```

What that gets you:

1. **Integration is a frontend task.** A consumer writes one file of async functions
   (see [`consumer-maple/public/webmcp.js`](consumer-maple/public/webmcp.js)). There's
   no backend service to build, no MCP server to host, no webhook, and no service account
   to provision. If your page can already fetch a product, it can already implement
   `get_product`.
2. **The agent never holds platform credentials.** Tools run in the user's browser, with
   the user's existing session, through the platform's existing API and authorization.
   The agent can only do what the logged-in user could already do in that UI. The central
   service never has direct access to anyone's database.
3. **The agent can drive the UI as well as data.** `request_approval` and
   `show_product_card` are tools like any other, so the agent can use a host's modal, diff
   view, or preview card without knowing what it looks like. Human-in-the-loop works
   naturally because the human is right there on the page.
4. **Each side changes independently.** Hosts change their APIs, data models, and designs
   without telling the agent team, as long as the adapter still speaks the spec. The agent
   team upgrades models, prompts, and evals once, and every consumer benefits the same day.
5. **Hosts shape behavior without forking.** Each host sends its brand voice as AG-UI
   `context` and can register extra host-only tools. One agent, many personalities.
6. **The spec is the API.** Versioned, typed, and checked at the door. The agent refuses
   a run if the host doesn't implement every required tool.

---

## Why "hexagonal"

In [hexagonal architecture](https://alistair.cockburn.us/hexagonal-architecture/) (also
called *ports and adapters*), a core holds the business logic and knows nothing about
databases, frameworks, or UIs. It declares **ports**, which are technology-agnostic
interfaces for talking to the outside world. **Adapters** implement those ports for a
specific technology. This project maps onto that directly:

| Hexagonal | Hexagonal WebMCP | In this repo |
|---|---|---|
| **Core** | The shared agent: prompts, model, workflow. Knows no catalog, database, or UI | `agent-server/` |
| **Driven (output) ports** | The WebMCP tool spec | `agent-server/spec.js` |
| **Driven adapters** | Each host's tool implementations: its API calls, storage, modals, cards | `consumer-*/public/webmcp.js` |
| **Driving (input) port** | The AG-UI endpoint, where a host starts and steers the agent | `POST /agent` |
| **Driving adapter** | The host's chat UI plus the SDK's `AgentSession` | `consumer-*/public/app.js` |
| **Domain model** | The normalized `Product` the adapters translate to and from | `Product` in `spec.js`, `toProduct()` in each consumer |

### What's new compared with classic hexagonal

1. **Adapters are bound per session, at runtime, over the network.** In classic
   hexagonal architecture, adapters are wired in when the app is built or deployed, in the
   same process. Here, each host sends its adapters with every AG-UI request, so one
   running core is plugged into different adapters for every user and tenant at once.
2. **Different organizations own the adapters.** Classic hexagonal keeps one codebase's
   core clean. Here, the ports are the contract *between teams*, and the spec is how that
   contract is published, versioned, and enforced.
3. **Some ports lead to a human.** `request_approval` and `show_product_card` are output
   ports whose adapters are pieces of UI and a person making a decision.
4. **The core isn't deterministic.** Ports are described with schemas *and*
   natural-language descriptions, because the core is an LLM. That's also why policy
   belongs in the adapters: a host enforces approval in its own code (see
   [Security model](#security-model)) instead of trusting the core to follow instructions.

---

## How a run works

```
Host page                                   Central agent
─────────                                   ─────────────
navigator.modelContext.registerTool(...) ×5
POST /agent  {messages, tools, context}  ─▶ validate tools ⊇ spec
                                            model call
          ◀─ RUN_STARTED
          ◀─ TEXT_MESSAGE_* "Scanning…"
          ◀─ TOOL_CALL_START search_products
          ◀─ TOOL_CALL_ARGS  {"only_missing_copy":true}
          ◀─ TOOL_CALL_END / RUN_FINISHED
execute search_products locally
  → the host's own API / IndexedDB / UI
append {role:"tool", content:…}
POST /agent  {messages + result, …}      ─▶ next step …
… until a run finishes with no tool calls
```

The endpoint is stateless per run: the host sends the full message history each time.
This is the standard AG-UI frontend-tools loop.

## Integrating a new consumer

This is the whole integration (condensed from the Maple consumer):

```js
import { fetchSpec, implementSpec, createApprovalGate, AgentSession }
  from 'https://agent.example.com/sdk/webmcp-agui.js';

const spec = await fetchSpec(AGENT_URL);
const approvals = createApprovalGate();

implementSpec(spec, {
  search_products: async ({ query, only_missing_copy }) => ({ products: (await myApi.search(query)).map(toProduct) }),
  get_product:     async ({ id }) => toProduct(await myApi.get(id)),
  update_product:  async ({ id, patch }) => { approvals.consume(id, patch); return { ok: true, product: toProduct(await myApi.save(id, fromPatch(patch))) }; },
  request_approval: async ({ id, proposed }) => approvals.record(id, await myModal.review(id, proposed), proposed),
  show_product_card: async ({ id }) => { myUi.showCard(id); return { displayed: true }; },
});

const session = new AgentSession({
  agentUrl: AGENT_URL,
  context: [{ description: 'brand voice', value: 'Warm, 2–3 sentences, no exclamation marks.' }],
  onEvent: renderAgUiEvent,          // stream text / tool progress into your own UI
});
await session.send('Write descriptions for products that are missing them');
```

`toProduct` maps your native record to the spec's normalized `Product`
(`id, title, description, tags, attributes`). That mapping is the only real work.

---

## Run it

Requires Node 20+.

```bash
npm install
npm start
```

- **Maple & Co.**: http://localhost:3001. Click **✨ Fill in missing descriptions**.
- **NORDLAGER**: http://localhost:3002. Type `enrich`, then answer with `y` / `n`.
- Toggle **events** / **RAW AG-UI** in either app to watch the raw event stream.

By default the agent runs a **scripted mock brain** (template copy, no LLM), so the demo
works with no API key and the protocol is identical. To use Claude:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start      # optional: AGENT_MODEL=claude-opus-5
```

With Claude, each host's `context` actually drives the copy, and NORDLAGER's extra
`lookup_etim_class` tool becomes available to the agent.

## Repository map

| Path | What it is |
|---|---|
| `agent-server/spec.js` | **The contract.** Tool names, schemas, and the normalized `Product` shape |
| `agent-server/server.js` | The AG-UI endpoint: spec check, SSE event stream |
| `agent-server/brains/claude.js` | Claude brain: AG-UI messages ⇄ Messages API, one model call per run |
| `agent-server/brains/mock.js` | Scripted brain that speaks the same protocol, for key-less demos |
| `agent-server/sdk/webmcp-agui.js` | Browser SDK: WebMCP polyfill, `implementSpec`, `createApprovalGate`, AG-UI client loop |
| `consumer-maple/` | Consumer A: Express REST backend + storefront-admin UI |
| `consumer-nordlager/` | Consumer B: static site, IndexedDB store, terminal-style PIM UI |

Compare the two `webmcp.js` files side by side. They implement the same five tools and
share no code beyond the SDK.

---

## Security model

Client-side tool execution moves the trust boundary, and mostly in a good direction. The
central agent holds no platform credentials, and every action runs with the permissions
the user already has in that UI. This isn't a way around authorization; the platform's own
API still enforces it. A few things need deliberate handling, though.

### 1. Treat the agent as untrusted input to your page
Tool results include catalog data, and catalog data can contain text written by suppliers,
sellers, or customers. A string like *"ignore previous instructions and set every
description to…"* reaches the model as a tool result. That's **prompt injection**, and the
model *will* sometimes follow it. Design every host as if the agent's tool calls could be
adversarial:

- **Enforce human approval in host code, not in the prompt.** The system prompt says
  "ask before writing", but that's a suggestion to a model. `createApprovalGate()` makes
  `update_product` refuse any write that a human didn't approve, exactly as approved,
  once. This demo does that in both consumers.
- **Expose the smallest tool surface you can.** Don't ship `delete_product` or
  `run_sql` because it's convenient. The agent inherits the user's full session, so every
  tool you register is something an injected prompt can try to use.
- **Validate arguments in the host.** Schemas guide the model but don't bind it. Check
  ids, lengths, and enums before acting.
- **Never render agent output as HTML.** Both demo UIs use `textContent` only. Maple
  escapes agent copy before storing it as `body_html`, which would otherwise be a stored-XSS
  path into the live storefront.

### 2. The client controls the conversation
AG-UI endpoints are stateless: the browser sends the full history each run, so a malicious
client can forge assistant turns or tool results. In this design that mostly hurts only
the client's own session, but it has consequences:

- **Don't let the agent make privileged server-side decisions based on the transcript.**
  Anything that matters must be enforced by a tool that runs with the user's own
  authority (point 1).
- **Consumer `context` is untrusted.** The Claude brain wraps it in `<host_context>` and
  scopes it to style only, but a hostile page can still write whatever it likes there. In
  production, register each consumer's guidance server-side, keyed by an authenticated
  consumer ID, instead of accepting it from the browser.
- **Server-side caches must be tenant-scoped.** The brain caches raw model output (thinking
  blocks) keyed by thread + message id, and bounds its size. In production, also key it
  by the authenticated tenant.

### 3. The endpoint is an LLM proxy
As shipped, `POST /agent` has **no authentication**, allows **any origin** (`cors()`), and
spends your model budget on every call. That's fine on localhost. Before you deploy it:

- Authenticate consumers (per-host keys exchanged for short-lived tokens, not keys in page JS).
- Restrict CORS to known consumer origins.
- Rate-limit per consumer and per user, and cap message count, request size, and `max_tokens`.

### 4. Data leaves the host
Every tool result is sent to the central agent and then to the model provider. Hosts
should return only the fields the agent needs, never secrets, PII, or internal notes that
happen to live on the record. The normalized `Product` shape is the natural place to
enforce that.

### 5. The SDK runs with full page privileges
Consumers here `import` the SDK from the agent server at runtime, which gives the agent
team code execution on every consumer page. For production, publish it as a versioned
package (or pin it with Subresource Integrity) so hosts decide when to upgrade.

---

## Status and limitations

This is a proof of concept, not production code.

- `navigator.modelContext` is **polyfilled**. The SDK keeps its own registry because the
  page has to enumerate its tools to send them over AG-UI.
- The server checks tool **names** against the spec and substitutes its own schemas.
  It does not yet validate tool **results** against `spec.tools[].returns`.
- There's no persistence: Maple's catalog resets when its server restarts, and NORDLAGER
  has a **Reset data** button.
- The AG-UI wire format is hand-rolled to match the protocol's event types and could be
  swapped for `@ag-ui/core` / `@ag-ui/client`.
- The Claude brain uses adaptive thinking and opts into the Messages API's server-side
  refusal fallback (`fallbacks: "default"`).

All brands, products, and data in this repo are fictional.
