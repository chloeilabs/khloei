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

Computer Use gives Khloei a persistent Playwright browser, a confined file
workspace, and an optional full Linux desktop. Browser, file, command, and
full-desktop visual tools are selected by the model, but every tool call passes
through a server-side policy gateway and an append-only audit log before it can run.
Completion or failure is recorded afterward. An optional durable Agents SDK
worker moves the long-running model loop outside Vercel, checkpoints it in
SQLite, and reconnects the chat after reloads or transient disconnects.

## Getting Started

Install both runtimes:

```bash
npm install
npm run agent:install
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
KHLOEI_AGENT_WORKER_TOKEN=replace_with_another_long_random_value
KHLOEI_AGENT_WORKER_URL=http://127.0.0.1:4200
KHLOEI_APP_URL=http://127.0.0.1:3000
AGENT_WORKER_DB_PATH=.khloei/agent-worker/tasks.sqlite
AGENT_WORKER_LEASE_MS=30000
AGENT_WORKER_HEARTBEAT_MS=10000
AGENT_WORKER_MAINTENANCE_MS=5000
AGENT_WORKER_RETENTION_DAYS=30
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
`KHLOEI_COMPUTER_URL` is the server-to-server address. Set
`KHLOEI_COMPUTER_PUBLIC_URL` only when the user's browser needs a different
public WebSocket address in deployment; it defaults to the server address. A
Vercel deployment cannot reach Railway's private network, so both values use the
Railway HTTPS domain in that topology.

`KHLOEI_AGENT_WORKER_TOKEN` authenticates the app and durable worker in both
directions and signs browser resume tokens. Generate it independently with
`openssl rand -hex 32`; it falls back to `COMPUTER_TOKEN` only for
backward-compatible local setup. `KHLOEI_AGENT_WORKER_URL` opts Computer Use
into durable execution. Without it, Khloei keeps the direct request-bound path.
The worker uses `KHLOEI_APP_URL` for short authenticated action callbacks.

Start the computer, durable worker, and app in separate terminals:

```bash
npm run computer:dev
```

```bash
npm run agent:dev
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), then select **Computer
Use** from the Skills menu.

## Linux desktop

Khloei can replace the lightweight headless computer service with a persistent
Xfce Linux desktop containing Chrome, Terminal, Files, Git, Python, Node.js,
Bun, ripgrep, and VS Code. It uses the same scoped live viewer, explicit human
takeover, persistent browser profile, workspace, and audit API as browser mode,
so the React app never receives `COMPUTER_TOKEN`.

Install Docker Desktop, keep the normal `COMPUTER_TOKEN` and computer URLs in
`.env.local`, and start the desktop instead of `npm run computer:dev`:

```bash
npm run computer:desktop:up
```

Then start the durable worker and Next.js app normally:

```bash
npm run agent:dev
npm run dev
```

Select **Computer Use**, expand the newest computer card, and choose **Take
control** to interact with the complete desktop. Stop it with:

```bash
npm run computer:desktop:down
```

The Compose project retains separate named volumes for the Linux home,
workspace, browser profiles, and audit chain across ordinary stop/start or
container replacement. Port 4100 is bound only to loopback.

The display is [Xvfb](https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml),
the ordinary headless X server, not a VNC server. Khloei captures the X root
window with ffmpeg and injects input with xdotool, and a person watches through
the app's own scoped viewer socket, so a VNC stack was never on the path: it
only ever supplied an X server and an Xfce session. Carrying one cost a 7.5 GB
image, a multi-minute cold start, and a dependency on privileges that sandboxed
container runtimes withhold, where its X server silently never started at all.
Xvfb needs no display hardware and no elevated capabilities, is given its
geometry at startup so no mode-setting is required, and brings the image to
about 1 GB with the display ready in roughly two seconds.

The desktop image builds for both amd64 and arm64, so a developer machine runs
it natively. Google publishes Chrome and Microsoft publishes VS Code for amd64
only, so arm64 installs Debian's Chromium instead: the same engine Playwright
drives. This matters for feel rather than throughput. Every input event runs an
xdotool command, and under amd64 emulation on Apple Silicon each one cost about
348 ms against roughly 3 ms natively, which is experienced directly as lag while
driving the desktop. Input events are also chained into a single xdotool
invocation per burst rather than one apiece.

Interactive latency is otherwise dominated by distance to the host: a round trip
to a computer in another continent adds well over 100 ms to every action. Deploy
the computer near whoever drives it. The default desktop is 1920×1080 at 30
frames per second with
maximum-quality JPEG encoding. Frames
travel as binary WebSocket messages rather than base64-in-JSON, and stale frames
are dropped when a viewer is slow rather than accumulating memory. Override
`KHLOEI_DESKTOP_RESOLUTION`, `KHLOEI_DESKTOP_FRAME_RATE` (2–30), or
`KHLOEI_DESKTOP_JPEG_QUALITY` (2–12, lower is sharper) when a remote host needs a
different quality/bandwidth balance.

Khloei can use the browser accessibility tools, confined workspace reads and
writes, and a governed command runner to code, install project dependencies,
and run tests inside the desktop. Commands run as UID 1000 with no Linux
capabilities or privilege escalation; they start in `/data/workspace`, receive
only an allowlisted environment, and cannot see `COMPUTER_TOKEN`. The command,
policy decision, and bounded result metadata are recorded in the audit chain,
while stdout and stderr are returned to the agent but omitted from the audit
file. This is still a container boundary, not permission to access its Docker
host or other private services.

For native applications, operating-system dialogs, canvas content, and other
UI without usable browser accessibility refs, Khloei can capture the complete
1920×1080 desktop and use governed click, double-click, move, scroll, type,
keypress, drag, and wait primitives. Every primitive is serialized with human
input, refused while a person holds control, and returns a fresh maximum-quality
JPEG to both the model and transcript. Typed text and image bytes are omitted
from the audit trail. Browser refs, files, and shell remain the preferred path
because they are faster and less error-prone than coordinates.

## Computer Use architecture

Khloei's computer service provides durable local data paths, browser profiles,
files, and audit storage. In desktop mode it also owns a complete Xfce session,
streams the root display through the same scoped viewer socket, and publishes
the governed non-root command tool. The OpenAI Agents SDK selects Khloei's
browser, file, and desktop tools, while the Next.js gateway supplies policy
decisions, target protection, the audit chain, streaming activity, and live
computer frames.

When `KHLOEI_AGENT_WORKER_URL` is configured, the single-replica worker owns
the Agents SDK run loop instead of a Vercel function. It stores the serialized
`RunState`, event cursor, gateway state, human-approval interruption, and an
exactly-once action ledger in SQLite. A browser reload reconnects by task id and
cursor. Checkpoints carry an explicit envelope version for the Agents SDK and
Khloei's agent graph; incompatible deployments fail closed rather than resuming
against changed tools. The worker renews ownership leases while a task runs and
only reclaims expired work. If a lease expires after an action was dispatched
but before its result was committed, Khloei records the outcome as ambiguous,
does not replay the action, and inspects the current computer state before
continuing.

Long computer runs execute as serialized 24-turn SDK segments. Reaching a
segment boundary checkpoints and resumes the same `RunState` automatically, so
the first boundary is not a terminal error and completed tool actions are not
replayed. A 96-turn per-request ceiling remains as the final runaway guard; at
that ceiling the desktop and completed work stay available for a deliberate
follow-up request.

The default lease is 30 seconds with a 10-second heartbeat and a 5-second stale
task sweep. `AGENT_WORKER_RETENTION_DAYS` removes completed, failed, and
cancelled task data after 30 days; set it to `0` to disable automatic retention.
Active and human-waiting tasks are never removed.

### Screenshot storage

A visual desktop action answers with a full-resolution JPEG, so keeping those
bytes inline would leave tens of megabytes of base64 in the action ledger and
the transcript for every screenshot-heavy task, retained for as long as the task
is. Screenshot bytes are instead written to `AGENT_WORKER_SCREENSHOT_DIR`
(default: `screenshots/` beside the database on the same durable volume), named
by the SHA-256 of their content, and the ledger keeps only a reference. An
unchanged desktop observed many times is stored once.

Exactly-once replay is unchanged: the ledger row is still the single record of
whether an action ran, and the reference is only how its picture is found again.
Bytes are written before the row that cites them, and a store that cannot accept
them leaves the screenshot inline rather than failing the commit of an action
that has already been carried out.

Retention is a sweep on the existing maintenance cadence:
`AGENT_WORKER_SCREENSHOT_MAX_AGE_DAYS` (default 7) then
`AGENT_WORKER_SCREENSHOT_MAX_BYTES` (default 512 MiB), oldest first. The budget
is clamped at startup to half the volume it is mounted on, and the reduction is
logged: screenshots share that volume with the task database, and a budget
larger than the disk would let cached pictures stall the ledger that makes an
action exactly-once. Losing old screenshots is recoverable; losing the ledger is
not. Blobs are
shared between actions, so they are not deleted with the task that cited them.
Replaying an action whose screenshot has been swept returns its metadata with
`screenshotUnavailable`, so Khloei reads a small honest result and takes a fresh
screenshot instead of receiving a broken image; the transcript shows the same
thing in place of the frame. The worker's `/health` reports the directory, file
count, bytes used, and the fraction of budget consumed.

### Deployment parity

The app, the worker, and the computer image deploy on different cadences, so
[`shared/computer-contract.ts`](./shared/computer-contract.ts) names the
contract each side was built against. The computer reports it on `/health`,
which stays unauthenticated, and `GET /api/computer/status` compares the two:
`200` aligned, `409` reachable but mismatched, `503` unreachable. The response
names the specific capabilities a behind image is missing rather than only that
two numbers differ, and an image old enough to omit the field is reported as
unknown rather than assumed compatible. Run `bun run eval:computer`
to exercise the real Khloei agent graph against side-effect-free safety
fixtures; local reports are written under `evals/results/`.

Human help and secret-entry requests use persisted Agents SDK interruptions.
The worker can remain idle while a person takes control, survives a restart
during that wait, and resumes the same run only after the computer service
reports that control was handed back. Stop and New Chat request durable
cancellation; a pending takeover is released before the task becomes terminal.

Only the newest computer card opens a live viewer. The browser receives a
single-use, short-lived viewer token bound to the Khloei app origin; the root
`COMPUTER_TOKEN` remains server-only. **Take control** pauses model input and
forwards the user's mouse, keyboard, paste, and scroll events over that viewer
socket. **Hand back** returns control to Khloei. Human input is deliberately
distinguished from model actions: model tool calls pass through the policy and
audit sequence below, while direct human input is authorized by the explicit
takeover state. In browser mode the socket carries a Chrome page; in desktop
mode it carries the full Linux display.

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

The gateway enforces this order for every published browser, file, command, or
full-desktop visual tool:

1. Resolve the requested action and current browser element.
2. Evaluate the deny-first policy.
3. Append the decision event. If this write fails, do not act.
4. Send an approved action to the authenticated computer service.
5. Append a completion or failure event.

The tamper-evident NDJSON audit is stored by the computer service at
`$AUDIT_DIR/events.ndjson`. Each append is fsynced and includes the previous
record's SHA-256 hash. Typed text and file contents are deliberately omitted.
Locally, the audit, persistent browser profile, and files live in separate
folders under `.khloei/computer/`, which is ignored by Git. In production,
put all three folders on a durable volume, but keep their roots separate so
file tools cannot read browser sessions or their own audit trail.

The optional `KHLOEI_COMPUTER_POLICY` variable accepts a JSON policy. Rules are
deny-first; supported selectors include `tool:`, `intent:`, `host:`, `file:`,
`command:`, `extension:`, `element:`, `actor:`, and `bot:`. A trailing `*` is a
prefix wildcard. For example:

```bash
KHLOEI_COMPUTER_POLICY={"mode":"enforce","deny":["host:example.com"],"allow":["*"]}
```

The browser gateway also blocks loopback, private-network, and cloud-metadata
targets by default. `KHLOEI_COMPUTER_ALLOW_PRIVATE_HOSTS=true` is a local-only
escape hatch for development; production refuses to start with it enabled.

## Deployment

The [`computer-image.yml`](./.github/workflows/computer-image.yml) workflow
builds the computer from the repository root, publishes immutable commit and
`latest` tags to GitHub Container Registry, then asks Railway to pull the
published image. Building outside Railway keeps deployments independent of
Railway's build workers while Railway continues to own the runtime and volume.
The equivalent local build is:

```bash
docker build -f services/computer/Dockerfile.desktop -t khloei-computer .
```

[`services/computer/Dockerfile`](./services/computer/Dockerfile) still builds the
browser-only computer, the surface `KHLOEI_COMPUTER_SURFACE` selects by default.
It is a smaller image for deployments that need the browser, files and command
runner without a desktop. Nothing builds it automatically, so it is not covered
by CI and can drift; rebuild and boot it before relying on it.

The [`agent-worker-image.yml`](./.github/workflows/agent-worker-image.yml)
workflow similarly publishes `khloei-agent-worker`. Its local build is:

```bash
docker build -f services/agent-worker/Dockerfile -t khloei-agent-worker .
```

Run the agent worker as one Railway replica with a volume mounted at `/data`
and `AGENT_WORKER_DB_PATH=/data/tasks.sqlite`. Configure its model keys, a
dedicated `KHLOEI_AGENT_WORKER_TOKEN`, and
`KHLOEI_APP_URL=https://your-khloei-app.example`. Configure the same worker
token plus `KHLOEI_AGENT_WORKER_URL=https://your-worker.example` on Vercel.
Production refuses to fall back to `COMPUTER_TOKEN`; sharing the computer's
root credential with the worker is supported only for local development.
The worker needs outbound HTTPS access to both the app and model provider; only
Vercel needs its authenticated task API.

If Vercel Deployment Protection covers `KHLOEI_APP_URL`, also configure the
project's Protection Bypass for Automation secret as
`VERCEL_AUTOMATION_BYPASS_SECRET` on the Railway worker. Khloei sends it only
as Vercel's recommended `x-vercel-protection-bypass` callback header; the
independent worker token still authenticates the application route itself.

Run it with `COMPUTER_TOKEN` and durable storage. Railway supports one volume per
service, so mount it at `/data` and set:

```bash
WORKSPACE_DIR=/data/workspace
PROFILES_DIR=/data/profiles
AUDIT_DIR=/data/audit
```

The same `/data` volume also retains the Linux home at `/data/home`. The image
repairs ownership on a newly attached or legacy volume, then permanently drops
to UID/GID 1000 with an empty capability set before starting either the desktop
or command service. Keep `KHLOEI_COMPUTER_SHELL_ENABLED=true` on the desktop
service; the lightweight browser-only image leaves command execution disabled.

The workflow's deploy step is enabled with the repository variable
`RAILWAY_DEPLOY_ENABLED=true` and an environment-scoped Railway project token in
the `RAILWAY_TOKEN` GitHub Actions secret. Railway should use
`ghcr.io/chloeilabs/khloei-computer:latest` as its image source, expose port
4100, and require `/health` to pass before a deployment becomes active.

Enable the agent-worker workflow's Railway step separately with
`RAILWAY_AGENT_WORKER_DEPLOY_ENABLED=true`. Railway should use
`ghcr.io/chloeilabs/khloei-agent-worker:latest`, expose port 4200, mount its
volume at `/data`, and require `/health` to pass.

Point both `KHLOEI_COMPUTER_URL` and `KHLOEI_COMPUTER_PUBLIC_URL` at the
Railway HTTPS domain when the Next.js app runs on Vercel. Viewer URLs contain
only one-use scoped tokens, never `COMPUTER_TOKEN`; all other computer endpoints
require the root token. The audit chain is written on the Railway volume rather
than Vercel's ephemeral function filesystem. If the computer service can share
a private network with the app, keep its root endpoint private and expose only
the viewer stream through a TLS proxy.

Every accessibility snapshot carries the current computer-process session id,
so a durable task cannot reuse element references after the computer restarts
and resets its numeric snapshot counter. Command execution is available only
from the desktop image and is refused if that service is accidentally started
as root.

Tool completion, gateway state, user-visible activity, and the pre-return agent
checkpoint are committed together in one SQLite transaction. A restart after
that boundary replays the stored tool result without repeating the external
action; a restart before the boundary marks the action ambiguous and requires a
fresh inspection instead of guessing.
