# Khloei

Khloei is a [Next.js](https://nextjs.org) application.

Normal chat, follow-up suggestions, and Computer Use can run through OpenRouter
with `stealth/ox-alpha` or `x-ai/grok-4.6`. Khloei uses OpenRouter's Responses
API compatibility, streamed output, model-controlled web search, multimodal
image inputs, Markdown rendering, and a bounded stateless conversation history.
Select `gpt-5.6-terra` to run normal chat through OpenAI instead.

Deep Research always runs with `gpt-5.6-sol` in OpenAI background mode, so a
long response can resume after a transient disconnect, a serverless timeout, or
a browser reload. Stop and New Chat also cancel the active background response
at OpenAI.

Computer Use gives Khloei a persistent Playwright browser and a confined file
workspace. Browser and file tools are selected by the model, but every tool call
passes through a server-side policy gateway and an append-only audit log before
it can run. Completion or failure is recorded afterward.

## Getting Started

Install both runtimes:

```bash
npm install
npm run computer:install
```

Add the server-only variables to `.env.local`:

```bash
OPENAI_API_KEY=your_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
COMPUTER_TOKEN=replace_with_a_long_random_value
KHLOEI_COMPUTER_URL=http://127.0.0.1:4100
KHLOEI_COMPUTER_PUBLIC_URL=http://127.0.0.1:4100
KHLOEI_COMPUTER_BOT_ID=khloei
```

The model selector determines the provider for normal chat, follow-up
suggestions, and Computer Use. `OPENROUTER_API_KEY` is required for Ox Alpha or
Grok 4.6, while `OPENAI_API_KEY` is required for GPT-5.6 Terra and Deep
Research. `OPENROUTER_SITE_URL=https://your-domain.example` is optional and is
sent as OpenRouter's `HTTP-Referer` attribution header.

Keep `OPENAI_API_KEY` configured for Deep Research. OpenRouter models currently
accept text and image attachments in Khloei; select OpenAI explicitly when
sending PDF, office-document, or other file attachments.

`COMPUTER_TOKEN` authenticates the app to the computer service. Generate one,
for example, with `openssl rand -hex 32`. Never prefix it with `NEXT_PUBLIC_`.
`KHLOEI_COMPUTER_URL` is the private server-to-server address. Set
`KHLOEI_COMPUTER_PUBLIC_URL` only when the user's browser needs a different
public WebSocket address in deployment; it defaults to the private address.

Start the computer and app in separate terminals:

```bash
npm run computer:dev
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), then select **Computer
Use** from the Skills menu.

## Computer Use architecture

Khloei vendors the OpenBot agent-computer service at the commit documented in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). A small Khloei wrapper
provides local data paths. The OpenAI Agents SDK selects Khloei's published
browser and file tools, while the Next.js gateway supplies policy decisions,
target protection, the audit chain, streaming activity, and live browser
frames.

Only the newest computer card opens a live viewer. The browser receives a
single-use, short-lived viewer token bound to the Khloei app origin; the root
`COMPUTER_TOKEN` remains server-only. **Take control** pauses model input and
forwards the user's mouse, keyboard, paste, and scroll events over that viewer
socket. **Hand back** returns control to Khloei. Human input is deliberately
distinguished from model actions: model tool calls pass through the policy and
audit sequence below, while direct human input is authorized by the explicit
takeover state.

When Khloei reaches a CAPTCHA or multi-step sign-in, the help tool publishes the
live frame immediately and waits up to ten minutes for the user to take and hand
back control. For a single password or one-time code, the secret tool opens a
masked prompt and waits for the value to be entered directly into the selected
page field. The value never enters model context, tool output, or the audit
file; the audit records only the request and the supplied character count.

The expanded viewer includes a liquid-glass tab strip and address bar. Khloei
and a human in takeover mode can open, switch, navigate, and close tabs; links
that create a new window are registered as tabs automatically. The active tab
drives the live screencast, and its browser profile persists between requests.
Set `COMPUTER_MAX_TABS` on the computer service to change the default limit of
12 concurrent tabs.

The gateway enforces this order for every published browser or file tool:

1. Resolve the requested action and current browser element.
2. Evaluate the deny-first policy.
3. Append the decision event. If this write fails, do not act.
4. Send an approved action to the authenticated computer service.
5. Append a completion or failure event.

The tamper-evident NDJSON audit is stored at
`.khloei/computer/audit/events.ndjson`. Each record includes the previous
record's SHA-256 hash. Typed text and file contents are deliberately omitted.
The persistent browser profile and files live under `.khloei/computer/` too,
which is ignored by Git.

The optional `KHLOEI_COMPUTER_POLICY` variable accepts a JSON policy. Rules are
deny-first; supported selectors include `tool:`, `intent:`, `host:`, `file:`,
`extension:`, `element:`, `actor:`, and `bot:`. A trailing `*` is a prefix
wildcard. For example:

```bash
KHLOEI_COMPUTER_POLICY={"mode":"enforce","deny":["host:example.com"],"allow":["*"]}
```

The browser gateway also blocks loopback, private-network, and cloud-metadata
targets by default. Set `KHLOEI_COMPUTER_ALLOW_PRIVATE_HOSTS=true` only inside a
network boundary you control.

## Deployment

Build the computer service from the repository root:

```bash
docker build -f services/computer/Dockerfile -t khloei-computer .
```

Run it as a private service with `COMPUTER_TOKEN`, attach separate persistent
volumes at `/workspace` and `/profiles`, and point `KHLOEI_COMPUTER_URL` at it.
If that private address is not reachable from a user's browser, expose only the
stream endpoint through a TLS reverse proxy and set
`KHLOEI_COMPUTER_PUBLIC_URL` to its HTTPS address. Viewer URLs contain only
one-use scoped tokens, never `COMPUTER_TOKEN`.
The separation keeps file tools away from browser session storage. For the
audit promise to remain durable, the Next.js process also needs persistent
storage at `KHLOEI_COMPUTER_DATA_DIR`; an ephemeral serverless filesystem is not
a durable audit sink. Keep the computer service off the public internet, or
protect it with a private network in addition to its token.

The vendored service contains a shell endpoint for its container use case.
Khloei does not publish a shell tool to the model, and its default policy denies
the `run_command` intent. Do not expose the service directly to browsers.
