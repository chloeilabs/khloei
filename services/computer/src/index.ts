import { serve } from "bun";
import type { Page } from "playwright";
import { parseAriaSnapshot, type SnapshotElement } from "./aria-snapshot";
import {
  ComputerAuditInputError,
  createComputerAuditLog,
  parseComputerAuditInput,
} from "./audit";
import {
  COMPUTER_CONTRACT_FEATURES,
  COMPUTER_CONTRACT_VERSION,
} from "../../../shared/computer-contract";
import { isOpenPath, matchesToken, offeredToken } from "./authorisation";
import { isPlainBotId } from "./bot-id";
import { prepareComputerDataDirectories } from "./data-directories";
import {
  captureDesktopScreenshot,
  type DesktopFrameMessage,
  type DesktopModelAction,
  desktopReady,
  performDesktopAction,
  startDesktopScreencast,
  synchronizeDesktopOperation,
} from "./desktop-screencast";
import {
  type Control,
  ControlError,
  ControlRequestError,
  createControl,
  NO_SECRET_PENDING,
  TAKE_CONTROL_FIRST,
} from "./control";
import { identity } from "./identity";
import {
  BrowserTabError,
  type BrowserTabsState,
  createProfiles,
  VIEWPORT,
} from "./profiles";
import {
  type InputMessage,
  type Screencast,
  startScreencast,
} from "./screencast";
import {
  assertComputerSession,
  createComputerSessionId,
  StaleSnapshotError,
} from "./snapshot-session";
import { createShell } from "./shell";
import {
  COMPUTER_SURFACE,
  DESKTOP_RESOLUTION,
} from "./surface";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspacePathError,
} from "./workspace";
import { isCurrentViewer } from "./viewer";
import {
  createViewerSessions,
  normaliseViewerOrigin,
} from "./viewer-sessions";

/**
 * The Bot's computer: a persistent browser by default, or that browser inside a complete Linux
 * desktop when the desktop image selects `KHLOEI_COMPUTER_SURFACE=desktop`.
 *
 * Acting on a page lives in this process because only this process holds the browser. In the
 * intended deployment path, the server gateway decides whether an action may run and asks this
 * process to durably append the audit row before calling the action endpoint. Keeping that
 * tamper-evident chain beside the browser on the persistent volume lets a serverless gateway remain
 * fail-closed without pretending its temporary filesystem is durable. The policy engine remains in
 * the gateway; the direct-port boundary is the computer token.
 *
 * `/files/read` and `/files/write` reach the durable workspace volume, confined to
 * it by workspace.ts. Reading and writing are the two operations a Bot needs to keep notes between
 * turns.
 *
 * Elements are addressed by reference, not by pixel. `/snapshot` stamps every interactive element
 * with a ref and hands back a compact list; `/click` and `/type` take one of those refs. That is the
 * accessibility-tree-first driver this is built on, and it is why filling in a form needs no
 * vision model at all: the Bot reads a list of fields rather than squinting at a picture and guessing
 * coordinates. Pixels remain the eventual fallback for canvas-style pages that expose no elements.
 *
 * One browser stays open so state survives between
 * turns: a session it signed into an hour ago is still signed in now. Launching per request would
 * make every task start from a cold, logged-out browser, which is the behaviour we are specifically
 * trying not to have.
 *
 * It authenticates its caller: every request must present the secret below, and the process refuses
 * to start without one. That is a lock on the door rather than a reason to put the door somewhere
 * public. It still belongs on the deployment network, behind the server that decides who is asking.
 */

/**
 * The secret every caller must present.
 *
 * This process drives a browser that holds real logins. Policy and actor identity live in the
 * server; the durable audit writer and browser live here, behind the same token.
 *
 * Refusing to start without a token makes missing authentication a deployment failure, never an open
 * computer.
 */
const COMPUTER_TOKEN = process.env.COMPUTER_TOKEN?.trim();
if (!COMPUTER_TOKEN) {
  console.error(
    "COMPUTER_TOKEN is not set. This process drives a browser holding real logins and will not start without the secret its caller must present.",
  );
  process.exit(1);
}

const PORT = Number.parseInt(process.env.PORT ?? "4100", 10);
const NAVIGATION_TIMEOUT_MS = Number.parseInt(
  process.env.NAVIGATION_TIMEOUT_MS ?? "30000",
  10,
);

/**
 * How long one action waits for its element.
 *
 * Much shorter than a navigation. Playwright waits for a control to become clickable, which is the
 * behaviour we want, but a ref that no longer resolves would otherwise hang for the full navigation
 * timeout before saying so, and the person is sitting watching a screen that is not changing.
 */
const ACTION_TIMEOUT_MS = Number.parseInt(
  process.env.ACTION_TIMEOUT_MS ?? "10000",
  10,
);
const COMPUTER_SESSION_ID = createComputerSessionId();

/**
 * How much page text a navigation hands back.
 *
 * Bounded because a page can be megabytes and the text goes into a model's context, where a single
 * unbounded page can push the rest of the conversation out. Generous enough that the visible part of
 * an ordinary page arrives whole, which is what the answer is usually made of.
 */
const TEXT_EXTRACT_LIMIT = 6000;

/**
 * Which snapshot the caller's refs came from.
 *
 * Kept as a caller-facing guard even though Playwright enforces the real thing underneath. The
 * published tool contract says an action carries the `snapshotId` it got, and a mismatch is answered
 * with "take a new snapshot", which is a clearer message for a model than an element that merely fails
 * to resolve. Playwright's `aria-ref` engine is the runtime enforcement: it resolves a ref only against
 * the most recent snapshot, only while the element is still connected to the document, and it mints a
 * new ref if an element's role or accessible name changed, so a recycled node cannot inherit an old one.
 */
/** Per-Bot browser-control state. Profiles are isolated, but this process is not a security boundary. */
type BotSession = {
  control: Control;
  /** This Bot's snapshot generation. See the note above on staleness. */
  snapshotId: number;
  /** Claims the viewer slot before its asynchronous screencast has finished starting. */
  viewerSocket?: unknown;
  /** The one live screen viewer for this Bot, if a person is watching. */
  viewer?: {
    socket: { send(data: string): unknown };
    cast: Screencast;
    /** Repoint the cast and publish the latest tab strip immediately. */
    refresh: () => Promise<void>;
    /** Stops the loop that keeps the cast pointed at whatever page the Bot is actually on. */
    follow?: ReturnType<typeof setInterval>;
  };
};

const sessions = new Map<string, BotSession>();
const viewerSessions = createViewerSessions();

/**
 * Forget the sessions of Bots whose browsers are no longer running.
 *
 * The map gained an entry per Bot id this process had ever seen and lost none, so a deployment where
 * every employee has a Bot accumulated one small object per employee for the life of the container.
 * Small, but unbounded, which is the same shape as the browsers themselves.
 *
 * Only entries with no live browser and nobody watching are dropped: the state is the generation
 * counter and the control handover, and both belong to a running browser. A Bot whose browser has
 * been closed starts a fresh session next time, which is what starting a fresh browser means.
 */
function forgetIdleSessions(): void {
  for (const [botId, session] of [...sessions.entries()]) {
    if (session.viewer || session.viewerSocket) continue;
    if (profiles.isLive(botId)) continue;
    sessions.delete(botId);
  }
}

function sessionFor(botId: string): BotSession {
  const existing = sessions.get(botId);
  if (existing) return existing;
  const created: BotSession = { control: createControl(), snapshotId: 0 };
  sessions.set(botId, created);
  // Cheap, and only ever on the path that adds one, so the map cannot grow without this running.
  if (sessions.size > 32) forgetIdleSessions();
  return created;
}

/**
 * Sent by the server as a header on every call. Absent means the caller does not know or does not
 * care, such as a health check, and that gets the default computer rather than an error, because
 * refusing it would make the container undemonstrable on its own.
 */
function botIdOf(request: Request, fallback?: string | null): string {
  return (
    request.headers.get("x-khloei-bot-id")?.trim() ||
    fallback?.trim() ||
    DEFAULT_BOT_ID
  );
}

/**
 * The Bot's durable files.
 *
 * Rooted at WORKSPACE_DIR, which the image creates and docker-compose mounts as a volume, so what a
 * Bot saves outlives the container. Built once at boot: the root is fixed, and resolving it per request
 * would only add a syscall to every call. Everything about why confinement is harder than it looks
 * lives in workspace.ts.
 */
const dataDirectories = await prepareComputerDataDirectories();
const workspace = createWorkspace(dataDirectories.workspace);
const shell = createShell(dataDirectories.workspace);
const SHELL_ENABLED =
  process.env.KHLOEI_COMPUTER_SHELL_ENABLED?.trim() === "true";

function shellAvailable(): boolean {
  return SHELL_ENABLED && process.getuid?.() !== 0;
}

/**
 * Who has the wheel, as a state machine in its own module.
 *
 * The state machine lives in `control.ts` so it can be tested without importing Playwright.
 */

/**
 * The Bot's browser and the profile that outlives it. See profiles.ts.
 *
 * `chromium.launch()` gives a fresh anonymous profile every time. Persistent profiles live on a
 * mounted volume so sign-in state survives the container.
 */
const profiles = createProfiles(dataDirectories.profiles);
// Audit data is deliberately outside the file-tool workspace and browser profile. The model cannot
// read or alter the chain, and a Railway volume can persist all three roots under separate folders.
const auditLog = createComputerAuditLog(dataDirectories.audit);
await auditLog.ready();
// Rooted in the same workspace the file tools use, so a command and a written file see one
// directory rather than two.

/**
 * The id normally arrives as a header on every request. This is the fallback for a caller that has no
 * Bot to name, such as a health check, so the container stays demonstrable on its own rather than
 * refusing everything that is not the server.
 */
const DEFAULT_BOT_ID = (() => {
  const configured = process.env.COMPUTER_BOT_ID ?? "shared";
  // At boot rather than per request. This is the id every unheadered call falls back to, so a value
  // the path rules refuse would answer 400 to everything and read as a broken computer.
  if (!isPlainBotId(configured)) {
    throw new Error(
      "COMPUTER_BOT_ID may contain only letters, digits, hyphen and underscore, and must start with a letter or digit.",
    );
  }
  return configured;
})();

async function currentPage(botId: string): Promise<Page> {
  return profiles.page(botId);
}

/**
 * The page as text, the way a reader sees it.
 *
 * Script and style bodies are dropped rather than included: they are the bulk of a modern page and
 * none of it is what anybody asked about, so leaving them in spends the extract on noise and pushes
 * the actual article past the limit.
 */
async function readablePageText(
  target: Page,
): Promise<{ text: string; truncated: boolean }> {
  const raw = await target.evaluate(() => {
    const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
    if (!clone) return "";
    for (const node of clone.querySelectorAll("script, style, noscript, svg")) {
      node.remove();
    }
    return clone.innerText ?? "";
  });

  const collapsed = raw.replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: collapsed.slice(0, TEXT_EXTRACT_LIMIT),
    truncated: collapsed.length > TEXT_EXTRACT_LIMIT,
  };
}

/**
 * Describe everything on the page a Bot can act on.
 *
 * Uses Playwright's AI snapshot rather than stamping attributes into the DOM. `ariaSnapshot` keeps
 * refs outside the page, survives framework re-renders, resolves accessible names, reports current
 * values and checked state, filters to actionable elements and descends into iframes.
 */
async function snapshotPage(
  session: BotSession,
  target: Page,
): Promise<{
  computerSessionId: string;
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
}> {
  session.snapshotId += 1;
  const yaml = await target.ariaSnapshot({ mode: "ai" });
  return {
    computerSessionId: COMPUTER_SESSION_ID,
    snapshotId: session.snapshotId,
    url: target.url(),
    title: await target.title(),
    ...parseAriaSnapshot(yaml),
  };
}

/**
 * Resolve a ref to a locator, refusing anything from a superseded snapshot.
 *
 * `aria-ref=` is a first-party Playwright selector engine, and it is the same one its MCP server uses.
 * The generation check here is the caller-facing half; see the note on `snapshotId` for why both exist.
 */
function locateRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
  expectedComputerSessionId?: string,
) {
  assertComputerSession(COMPUTER_SESSION_ID, expectedComputerSessionId);
  if (
    expectedSnapshotId !== undefined &&
    expectedSnapshotId !== session.snapshotId
  ) {
    throw new StaleSnapshotError(
      `That list of elements is out of date: it was taken for snapshot ${expectedSnapshotId} and the page is now at ${session.snapshotId}. Take a new snapshot and use the refs from it.`,
    );
  }
  return target.locator(`aria-ref=${ref}`);
}

/**
 * The element, or a refusal that says what to do about it.
 *
 * A generation check is not an existence check. A ref from
 * the current snapshot that names nothing on the page, because a model invented it or because the
 * page moved on without a new snapshot being taken, passes `locateRef` and then simply waits. The
 * action times out, and the caller gets a generic failure carrying Playwright's internal call log
 * instead of the actionable answer: take a fresh snapshot.
 *
 * `count()` resolves immediately rather than waiting, so a ref that names nothing is refused in
 * milliseconds instead of holding the action open for the full timeout.
 */
async function resolveRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
  expectedComputerSessionId?: string,
) {
  const locator = locateRef(
    session,
    target,
    ref,
    expectedSnapshotId,
    expectedComputerSessionId,
  );
  if ((await locator.count()) === 0) {
    throw new StaleSnapshotError(
      `Nothing on this page has the ref ${ref}. Take a new snapshot and use the refs it returns.`,
    );
  }
  return locator;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function browserUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrowserTabError("A web address is required.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserTabError("That is not a valid web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserTabError("Browser tabs can open only http or https addresses.");
  }
  return url.toString();
}

function browserTabId(value: unknown): string {
  if (typeof value !== "string" || !/^tab-[1-9][0-9]*$/.test(value)) {
    throw new BrowserTabError("A valid browser tab id is required.");
  }
  return value;
}

/**
 * One live viewer at a time per Bot, so a reconnect replaces rather than stacks, and two people
 * watching two different Bots do not fight over one cast.
 *
 * A second cast on the same page would have Chrome encoding every frame twice and both sockets acking
 * independently, which stalls both. One person drives; one cast.
 */
async function stopViewer(
  session: BotSession,
  expectedSocket?: unknown,
): Promise<void> {
  if (
    expectedSocket !== undefined &&
    !isCurrentViewer(session.viewerSocket, expectedSocket)
  ) {
    return;
  }
  const current = session.viewer;
  session.viewer = undefined;
  session.viewerSocket = undefined;
  if (current?.follow) clearInterval(current.follow);
  await current?.cast.stop();
}

/** Claim the viewer slot synchronously, then stop the cast it replaced. */
async function claimViewer(session: BotSession, socket: unknown): Promise<void> {
  const current = session.viewer;
  session.viewer = undefined;
  session.viewerSocket = socket;
  if (current?.follow) clearInterval(current.follow);
  await current?.cast.stop();
}

/** Push control and secret state over the existing screen socket; HTTP polling is only a fallback. */
function sendControl(session: BotSession): void {
  try {
    session.viewer?.socket.send(
      JSON.stringify({ type: "control", control: session.control.get() }),
    );
  } catch {
    // A socket closing between the state change and this send will reconnect and receive the state.
  }
}

/** Rebuild only the desktop capture so its baked cursor matches the current controller. */
async function syncDesktopCursor(session: BotSession): Promise<void> {
  if (COMPUTER_SURFACE !== "desktop") return;
  try {
    await session.viewer?.refresh();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "desktop-cursor-sync-error",
        error: describe(error, "The desktop cursor mode could not be updated."),
      }),
    );
  }
}

async function publishTabs(
  botId: string,
  session: BotSession,
): Promise<BrowserTabsState> {
  session.snapshotId += 1;
  const state = await profiles.tabs(botId);
  await session.viewer?.refresh().catch(() => undefined);
  return state;
}

/** How often the cast checks that it is still showing the page the Bot is on. */
const FOLLOW_INTERVAL_MS = 1_000;
/** Drop intermediate desktop frames before one slow viewer can exhaust service memory. */
const MAX_VIEWER_BUFFER_BYTES = 2 * 1024 * 1024;

/** What a live-screen socket carries: the Bot whose screen it is showing. */
type StreamData = { botId: string };

serve<StreamData>({
  port: PORT,
  idleTimeout: 120,
  /**
   * The live screen, pushed by Chrome rather than polled.
   *
   * Upgraded here rather than served as HTTP because the whole point is that frames arrive when the
   * page changes and input goes back over the same connection. See screencast.ts for why polling was
   * not good enough once a person had to type into this.
   */
  websocket: {
    async open(ws) {
      const session = sessionFor(ws.data.botId);
      try {
        await claimViewer(session, ws);

        const send = (frame: unknown) => {
          // A closed socket starts a fresh cast on the next connection.
          try {
            if (
              (frame as { type?: unknown })?.type === "frame" &&
              ws.getBufferedAmount() > MAX_VIEWER_BUFFER_BYTES
            ) {
              return;
            }
            const status = ws.send(JSON.stringify(frame));
            if (status === 0 && isCurrentViewer(session.viewerSocket, ws)) {
              void stopViewer(session, ws);
            }
          } catch {
            if (isCurrentViewer(session.viewerSocket, ws)) {
              void stopViewer(session, ws);
            }
          }
        };

        const sendDesktopFrame = (frame: DesktopFrameMessage) => {
          try {
            if (ws.getBufferedAmount() > MAX_VIEWER_BUFFER_BYTES) return;
            // JPEG bytes travel as a binary WebSocket frame. Base64 inside JSON made every frame
            // roughly one third larger and forced two needless copies on both sides.
            const status = ws.send(frame.data);
            if (status === 0 && isCurrentViewer(session.viewerSocket, ws)) {
              void stopViewer(session, ws);
            }
          } catch {
            if (isCurrentViewer(session.viewerSocket, ws)) {
              void stopViewer(session, ws);
            }
          }
        };

        send({
          type: "surface",
          surface: COMPUTER_SURFACE,
          label:
            COMPUTER_SURFACE === "desktop"
              ? "Khloei Linux desktop"
              : "Khloei browser",
          ...(COMPUTER_SURFACE === "desktop" ? DESKTOP_RESOLUTION : {}),
        });

        if (COMPUTER_SURFACE === "desktop") {
          // Starting the managed browser here makes Chrome part of the desktop immediately, while
          // preserving the same profile and accessibility-tree tools the Bot already uses.
          await currentPage(ws.data.botId);
          let refreshQueue = Promise.resolve();
          let refresh: () => Promise<void> = async () => undefined;
          const attach = async () => {
            if (!isCurrentViewer(session.viewerSocket, ws) || ws.readyState !== 1) {
              return;
            }
            const previous = session.viewer;
            const cast = await startDesktopScreencast(sendDesktopFrame, {
              // The person's browser already renders its own pointer. Excluding the X11 cursor
              // while they drive prevents a delayed remote cursor appearing beside it.
              drawMouseCursor: !session.control.humanMayDrive(),
              onError(error) {
                send({
                  type: "error",
                  error: describe(error, "The desktop screen stream stopped."),
                });
                ws.close();
              },
            });
            if (!isCurrentViewer(session.viewerSocket, ws) || ws.readyState !== 1) {
              await cast.stop();
              return;
            }
            session.viewer = {
              socket: ws,
              cast,
              refresh,
            };
            // Start the replacement first so changing control never blanks the last desktop frame.
            await previous?.cast.stop().catch(() => undefined);
          };

          refresh = () => {
            refreshQueue = refreshQueue
              .catch(() => undefined)
              .then(attach);
            return refreshQueue;
          };

          await refresh();
          sendControl(session);
          return;
        }

        /*
         * The cast follows the active tab. Re-checking also discovers popups, title changes and a
         * page being closed underneath us without coupling the viewer to every page event.
         */
        let casting: Page | undefined;
        let tabsFingerprint = "";
        let refreshQueue = Promise.resolve();
        let refresh: () => Promise<void> = async () => undefined;
        const attach = async () => {
          if (!isCurrentViewer(session.viewerSocket, ws) || ws.readyState !== 1) {
            return;
          }
          const target = await currentPage(ws.data.botId);
          if (!isCurrentViewer(session.viewerSocket, ws) || ws.readyState !== 1) {
            return;
          }
          if (target === casting) return;
          const previous = session.viewer;
          const cast = await startScreencast(target, (frame) =>
            send({ ...frame, url: target.url() }),
          );
          if (!isCurrentViewer(session.viewerSocket, ws) || ws.readyState !== 1) {
            await cast.stop();
            return;
          }
          casting = target;
          session.viewer = {
            socket: ws,
            cast,
            refresh,
            follow: previous?.follow,
          };
          // The old cast stops after the replacement is running, so the screen does not go blank.
          await previous?.cast.stop().catch(() => undefined);
        };

        refresh = () => {
          refreshQueue = refreshQueue
            .catch(() => undefined)
            .then(async () => {
              await attach();
              const tabs = await profiles.tabs(ws.data.botId);
              const fingerprint = JSON.stringify(tabs);
              if (fingerprint !== tabsFingerprint) {
                tabsFingerprint = fingerprint;
                send({ type: "tabs", ...tabs });
              }
            });
          return refreshQueue;
        };

        await refresh();
        if (!isCurrentViewer(session.viewerSocket, ws) || ws.readyState !== 1) {
          return;
        }
        sendControl(session);
        const follow = setInterval(() => {
          void refresh().catch(() => undefined);
        }, FOLLOW_INTERVAL_MS);
        if (session.viewer && isCurrentViewer(session.viewerSocket, ws)) {
          session.viewer.follow = follow;
        } else {
          clearInterval(follow);
        }
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "The screen could not be started."),
          }),
        );
        ws.close();
      }
    },

    async message(ws, raw) {
      const session = sessionFor(ws.data.botId);
      const viewer = session.viewer;
      // A superseded socket can close or deliver a buffered message after its replacement starts.
      // It must never drive the replacement cast.
      if (
        !isCurrentViewer(session.viewerSocket, ws) ||
        !isCurrentViewer(viewer?.socket, ws) ||
        !viewer
      ) {
        return;
      }
      let message: InputMessage;
      try {
        message = JSON.parse(String(raw)) as InputMessage;
      } catch {
        return;
      }
      // A person's input is accepted only while they hold the wheel. The socket being open is not permission:
      // without this check, anything that could reach this port could drive the browser while a Bot
      // was working, which is the one thing the control state exists to prevent.
      //
      // Refuse with an error so the surface can explain why input is ignored.
      if (!session.control.humanMayDrive()) {
        ws.send(JSON.stringify({ type: "error", error: TAKE_CONTROL_FIRST }));
        return;
      }
      try {
        await viewer.cast.send(message);
      } catch (error) {
        // Reported rather than swallowed. A dispatch that fails means the person's input did nothing,
        // and they must not be left believing it landed.
        console.error(
          JSON.stringify({
            type: "screencast-input-error",
            message: message.type,
            error: String(error),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "That input could not be applied."),
          }),
        );
      }
    },

    async close(ws) {
      const session = sessionFor(ws.data.botId);
      // Reconnects open the new socket before the old one closes. The old close must not stop the
      // replacement viewer.
      if (!isCurrentViewer(session.viewerSocket, ws)) return;
      await stopViewer(session, ws);
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);

    const isStream = url.pathname === "/stream";
    const botId = isStream
      ? botIdOf(request, url.searchParams.get("bot"))
      : botIdOf(request);
    const rootAuthorised = matchesToken(
      COMPUTER_TOKEN,
      offeredToken(request.headers, url),
    );
    const viewerAuthorised =
      isStream &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
      viewerSessions.consume({
        token: url.searchParams.get("viewer") ?? "",
        botId,
        origin: request.headers.get("origin") ?? "",
      });

    /*
     * Nothing below this line happens for an untrusted caller.
     *
     * `/health` is the single exception: it names no Bot, touches no browser and reports nothing but
     * whether this process is up, and a container orchestrator has to be able to ask that without
     * holding a secret.
     *
     * The websocket upgrade is checked here too. A browser cannot set headers on an upgrade, so the
     * React surface carries a short-lived viewer credential in the query. The root token remains in
     * the server-to-server authentication path.
     */
    if (
      !isOpenPath(url.pathname) &&
      !rootAuthorised &&
      !viewerAuthorised
    ) {
      // Says nothing about what is here. A refusal that describes the endpoint it is protecting is a
      // directory listing for whoever is knocking.
      return json({ error: "Not authorised." }, 401);
    }

    // Resolved once per request. Everything below that touches a browser, a takeover or a snapshot
    // goes through this Bot's session, so there is no path where one Bot's call reaches another's.
    // Refused here rather than deeper down, because the id names a directory and the API server
    // forwards whatever URL segment a caller typed. `reset` deletes that directory as root.
    // `/health` is exempt for the same reason it is exempt from the token: it names no Bot, and an
    // orchestrator's probe must not fail on a header it never meant to send.
    if (!isOpenPath(url.pathname) && !isPlainBotId(botId)) {
      return json({ error: "That is not a usable bot id." }, 400);
    }
    if (url.pathname === "/audit/events" && request.method === "POST") {
      if (!rootAuthorised) return json({ error: "Not authorised." }, 401);
      const declaredBytes = Number.parseInt(
        request.headers.get("content-length") ?? "0",
        10,
      );
      if (Number.isFinite(declaredBytes) && declaredBytes > 64 * 1024) {
        return json({ error: "The audit event is too large." }, 413);
      }
      const raw = await request.text();
      if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
        return json({ error: "The audit event is too large." }, 413);
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
        const input = parseComputerAuditInput(body);
        if (input.bot !== botId) {
          return json({ error: "The audit event names a different bot." }, 400);
        }
        return json(await auditLog.append(input), 201);
      } catch (error) {
        if (error instanceof ComputerAuditInputError || error instanceof SyntaxError) {
          return json({ error: error.message }, 400);
        }
        console.error(
          JSON.stringify({
            type: "computer-audit-write-error",
            error: describe(error, "The audit event could not be recorded."),
          }),
        );
        return json({ error: "The audit event could not be recorded." }, 500);
      }
    }

    const session = sessionFor(botId);

    if (url.pathname === "/stream") {
      /*
       * The socket carries the Bot in the query because it cannot do it in a header. Every other call here names
       * its Bot in `x-khloei-bot-id`, but a websocket client sends no custom headers on the upgrade,
       * so the stream, and only the stream, also accepts the Bot as a query parameter. The header
       * still wins where there is one.
       */
      if (server.upgrade(request, { data: { botId } }))
        return undefined as unknown as Response;
      return json({ error: "Expected a WebSocket upgrade." }, 400);
    }

    /**
     * Mint the only credential React receives. Root authentication was checked above; the result is
     * bound to this Bot and app origin, expires quickly, and is consumed by the first socket upgrade.
     */
    if (url.pathname === "/viewer/session" && request.method === "POST") {
      if (!rootAuthorised) return json({ error: "Not authorised." }, 401);
      const body = (await request.json().catch(() => null)) as {
        origin?: unknown;
      } | null;
      const origin = normaliseViewerOrigin(body?.origin);
      if (!origin) return json({ error: "A valid app origin is required." }, 400);
      return json(viewerSessions.mint({ botId, origin }));
    }

    /*
     * `/live` stays absent. A page served by this process can only be opened by putting the secret in
     * a URL, where it lands in history and logs. The React app is the guarded way to watch a Bot.
     */

    // Who has the wheel. Its state is pushed over the screen socket; this endpoint is also a fallback
    // for initial status and clients recovering from a missed message.
    if (url.pathname === "/control" && request.method === "GET") {
      return json(session.control.get());
    }

    // The Bot asking for help. It does not take control: it says it is stuck and why, and a person
    // decides. A Bot that could hand itself to a human could also hand a human a page they never
    // asked to see.
    if (url.pathname === "/control/request" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        reason?: unknown;
      } | null;
      const control = session.control.requestHelp(body?.reason);
      sendControl(session);
      return json(control);
    }

    // The Bot asking for one value it must not be told. It names a field from its fresh snapshot;
    // the secret-entry endpoint focuses that exact ref immediately before filling it.
    if (url.pathname === "/control/secret" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        label?: unknown;
        ref?: unknown;
        snapshotId?: unknown;
      } | null;
      try {
        const control = session.control.requestSecret(body ?? {});
        sendControl(session);
        return json(control);
      } catch (error) {
        if (error instanceof ControlRequestError) {
          return json({ error: error.message }, 400);
        }
        throw error;
      }
    }

    /**
     * A person supplying that value.
     *
     * Scoped by the pending request rather than by a control handover: it is usable only while the Bot
     * has actually asked for a secret, and the request is cleared the moment it is answered, so this
     * cannot be used as a general back door to type into the page.
     *
     * The value is typed and forgotten. Not stored on `control`, not returned in the response, not
     * logged. The response says how many characters arrived, which is enough for the surface to
     * confirm something was sent and useless to anybody reading it later.
     *
     * It types and does not submit. Committing a form is a separate action through the gateway and
     * audit trail; secret entry only places the value in the named field.
     */
    if (url.pathname === "/human/secret" && request.method === "POST") {
      const pending = session.control.pendingSecret();
      if (!pending) {
        return json({ error: NO_SECRET_PENDING }, 409);
      }
      const body = (await request.json().catch(() => null)) as {
        text?: unknown;
      } | null;
      if (typeof body?.text !== "string" || !body.text) {
        return json({ error: "A value is required." }, 400);
      }
      try {
        const target = await currentPage(botId);
        // Focus the field the Bot named, and let this throw if it cannot be found. A secret must not
        // be reported as delivered unless a field receives it.
        //
        // No generation check here: a Bot may take another snapshot after asking for a secret, while
        // the ref remains protected by Playwright's `aria-ref` rules.
        //
        // `aria-ref` resolves a ref only against the most recent snapshot, only while the element is
        // still connected, and mints a
        // new ref when an element's role or accessible name changes, so a recycled node cannot
        // inherit an old one. If the ref resolves, it is the field the Bot meant. If it does not,
        // nothing is typed, which is the outcome the generation check existed to guarantee.
        const field = locateRef(session, target, pending.ref, undefined);
        await field.click({ timeout: ACTION_TIMEOUT_MS });
        await field.fill(body.text, { timeout: ACTION_TIMEOUT_MS });
        const characters = body.text.length;
        // Cleared only after it actually landed, so a failure leaves the request open and the person
        // can try again rather than being told to start over.
        session.control.secretSupplied();
        sendControl(session);
        return json({ supplied: true, characters, url: target.url() });
      } catch (error) {
        if (error instanceof StaleSnapshotError) {
          return json({ error: error.message, stale: true }, 409);
        }
        // The field is gone, which is unretryable, so the request is closed rather than left open.
        // Keeping it open is right for a mistyped value and wrong here: the person would retype their
        // password into the same dead ref for ever. Clearing it also unblocks the Bot, which can see
        // on its next turn that nothing is pending and ask again against a fresh snapshot.
        session.control.secretSupplied();
        sendControl(session);
        return json(
          {
            error: describe(
              error,
              "That value could not be entered: the field is no longer on the page. Ask the assistant to request it again.",
            ),
          },
          502,
        );
      }
    }

    if (url.pathname === "/control/take" && request.method === "POST") {
      const control =
        COMPUTER_SURFACE === "desktop"
          ? await synchronizeDesktopOperation(() => session.control.take())
          : session.control.take();
      await syncDesktopCursor(session);
      sendControl(session);
      return json(control);
    }

    if (url.pathname === "/control/release" && request.method === "POST") {
      // `reason` is dropped on release: it described the thing the person was asked to do, and once
      // they have done it, leaving it set would have the surface still showing the old request.
      const control =
        COMPUTER_SURFACE === "desktop"
          ? await synchronizeDesktopOperation(() => session.control.release())
          : session.control.release();
      await syncDesktopCursor(session);
      sendControl(session);
      return json(control);
    }

    // The shared tab strip. Reading is harmless; mutations have separate Bot and human paths so the
    // same control state that protects clicks also protects opening, switching and closing pages.
    if (url.pathname === "/tabs" && request.method === "GET") {
      try {
        return json(await profiles.tabs(botId));
      } catch (error) {
        return json({ error: describe(error, "Tabs are unavailable.") }, 502);
      }
    }

    const botTabAction = url.pathname.match(
      /^\/tabs\/(open|activate|close)$/,
    )?.[1];
    const humanTabAction = url.pathname.match(
      /^\/human\/tabs\/(open|activate|close|navigate)$/,
    )?.[1];
    if ((botTabAction || humanTabAction) && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      try {
        if (botTabAction) session.control.assertBotMayAct();
        else if (!session.control.humanMayDrive()) {
          throw new BrowserTabError(TAKE_CONTROL_FIRST);
        }

        const action = botTabAction ?? humanTabAction;
        if (action === "open") {
          const target = await profiles.openTab(botId);
          if (botTabAction) {
            try {
              await target.goto(browserUrl(body?.url), {
                waitUntil: "domcontentloaded",
                timeout: NAVIGATION_TIMEOUT_MS,
              });
            } catch (error) {
              await target.close().catch(() => undefined);
              throw error;
            }
          }
        } else if (action === "activate") {
          await profiles.activateTab(botId, browserTabId(body?.tabId));
        } else if (action === "close") {
          await profiles.closeTab(botId, browserTabId(body?.tabId));
        } else {
          const target = await currentPage(botId);
          await target.goto(browserUrl(body?.url), {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT_MS,
          });
        }

        return json(await publishTabs(botId, session));
      } catch (error) {
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        if (error instanceof BrowserTabError) {
          return json({ error: error.message, tabError: true }, 409);
        }
        return json(
          { error: describe(error, "That tab action did not work.") },
          502,
        );
      }
    }

    // A person's input, by pixel. The Bot addresses elements by reference because it reads a list; a
    // person addresses them by pointing, because they are looking at a picture. Different problem,
    // different endpoint, and only usable while they hold the wheel.
    if (HUMAN_INPUT.has(url.pathname) && request.method === "POST") {
      if (!session.control.humanMayDrive()) {
        return json({ error: TAKE_CONTROL_FIRST }, 409);
      }
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      try {
        const target = await currentPage(botId);
        return json(await performHumanInput(target, url.pathname, body ?? {}));
      } catch (error) {
        return json({ error: describe(error, "That did not work.") }, 502);
      }
    }

    if (url.pathname === "/health") {
      const [profile] = profiles.summary([botId]);
      const desktopIsReady =
        COMPUTER_SURFACE === "desktop" ? await desktopReady() : undefined;
      // 200 whenever this service is answering. Whether the desktop came up is
      // reported as data, not as a failed probe: a platform healthcheck that
      // fails on an unready subsystem kills the very process that could report
      // it, and the browser, file and command tools are unaffected by a desktop
      // that never started. Readiness still reaches callers through
      // `desktop.ready` and through the contract features below.
      return json(
        {
          status: "ok",
          surface: COMPUTER_SURFACE,
          // What this image promises the app. Reported on the one unauthenticated
          // path so an operator or orchestrator can see version skew without
          // holding a secret, and so the app can name the difference precisely
          // instead of discovering it as a missing field mid-action.
          contract: {
            features: [...COMPUTER_CONTRACT_FEATURES].filter(
              (feature) =>
                (feature !== "desktop-visual" ||
                  (COMPUTER_SURFACE === "desktop" && desktopIsReady !== false)) &&
                (feature !== "desktop-shell" || shellAvailable()),
            ),
            version: COMPUTER_CONTRACT_VERSION,
          },
          capabilities: { shell: shellAvailable() },
          ...(COMPUTER_SURFACE === "desktop"
            ? {
                desktop: {
                  display: process.env.DISPLAY ?? ":1",
                  ready: desktopIsReady,
                  ...DESKTOP_RESOLUTION,
                },
              }
            : {}),
          computerSessionId: COMPUTER_SESSION_ID,
          // `browser` kept as it was: it is in the published contract and start.sh reads it.
          browser: profile?.running ?? false,
          profile,
          // Which Bot this computer can prove it is, when the deployment runs SPIRE. Null is a
          // deployment without it, not a failure, and it is reported rather than omitted so the
          // difference between "no identity here" and "identity broken" is visible.
          identity: await identity(),
        },
        200,
      );
    }

    /**
     * The computers this process holds. The shape is a list because the admin surface is a
     * list, and because a Bot that has a profile has a computer whether or not a browser is running
     * for it this second.
     */
    if (url.pathname === "/computers" && request.method === "GET") {
      return json({ computers: profiles.summary(await profiles.known()) });
    }

    /**
     * Stop the browser, keep what it knows.
     *
     * Closed gracefully so Chromium flushes its profile, and deliberately
     * not restarted here: the next request starts it again, which is the same path as a first ever
     * start, so there is no second way for a browser to come into existence.
     */
    if (url.pathname === "/computers/stop" && request.method === "POST") {
      const wasRunning = await profiles.stop(botId);
      // The wheel goes back to the Bot because the controlled browser no longer exists.
      session.control.release();
      sendControl(session);
      return json({ stopped: true, wasRunning });
    }

    /**
     * Forget everything and start over.
     *
     * Signs the computer out of everything by deleting the profile. Irreversible, which is why it is
     * its own endpoint rather than a flag on the one above: a person clicking "stop" must not be able
     * to discard a login by mistyping a parameter.
     */
    if (url.pathname === "/computers/reset" && request.method === "POST") {
      await profiles.reset(botId);
      // Reset releases control because any previous browser session and pending secret request are gone.
      session.control.release();
      sendControl(session);
      return json({ reset: true, botId });
    }

    if (url.pathname === "/navigate" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        url?: unknown;
      } | null;
      if (typeof body?.url !== "string") {
        return json({ error: "A url is required." }, 400);
      }

      const startedAt = Date.now();
      try {
        session.control.assertBotMayAct();
        const target = await currentPage(botId);
        await target.goto(body.url, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        // A new document wipes every stamp, so every ref handed out before now is meaningless.
        // Bumping the generation makes an action carrying one fail with "take a new snapshot" rather
        // than fall through to a selector that matches nothing and read as a missing element.
        session.snapshotId += 1;
        const extract = await readablePageText(target);
        return json({
          url: target.url(),
          title: await target.title(),
          text: extract.text,
          truncated: extract.truncated,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        // A person holding the wheel is not a failed navigation; the Bot should wait.
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        // The page is the Bot's working surface, so a failed navigation is reported rather than
        // thrown: the transcript needs to say what happened, and the browser stays usable.
        return json(
          {
            error:
              error instanceof Error ? error.message : "Navigation failed.",
          },
          502,
        );
      }
    }

    if (url.pathname === "/screenshot" && request.method === "GET") {
      try {
        if (COMPUTER_SURFACE === "desktop") {
          const buffer = await captureDesktopScreenshot("jpeg");
          return json({
            base64: buffer.toString("base64"),
            width: DESKTOP_RESOLUTION.width,
            height: DESKTOP_RESOLUTION.height,
            capturedAt: new Date().toISOString(),
            mimeType: "image/jpeg",
            url: "desktop://khloei",
          });
        }
        const target = await currentPage(botId);
        const buffer = await target.screenshot({ type: "png" });
        const size = target.viewportSize() ?? { width: 1280, height: 800 };
        return json({
          base64: buffer.toString("base64"),
          width: size.width,
          height: size.height,
          capturedAt: new Date().toISOString(),
          mimeType: "image/png",
          // Which page this is a picture of. A browser that has not been sent anywhere sits on
          // `about:blank`, and a screenshot of that is a valid, entirely white PNG, indistinguishable
          // from a real page to anything looking only at the bytes. The transcript needs to tell
          // those apart to avoid presenting a blank browser as though it were a loaded page.
          url: target.url(),
        });
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "Screenshot failed.",
          },
          502,
        );
      }
    }

    /**
     * Pixel-level model control of the full Linux desktop.
     *
     * The app gateway has already policy-decided and audited this operation.
     * This inner boundary still enforces the bot/human lock so a model action
     * can never land while the person has the wheel. Each action returns the
     * exact resulting frame so vision does not act on stale pixels.
     */
    if (url.pathname === "/desktop/action" && request.method === "POST") {
      if (COMPUTER_SURFACE !== "desktop") {
        return json({ error: "The full Linux desktop is not enabled." }, 404);
      }
      const body = (await request.json().catch(() => null)) as DesktopModelAction | null;
      if (!body || typeof body !== "object" || typeof body.action !== "string") {
        return json({ error: "A desktop action is required." }, 400);
      }
      try {
        session.control.assertBotMayAct();
        const result = await performDesktopAction(
          body,
          request.signal,
          () => session.control.assertBotMayAct(),
        );
        return json({
          action: result.action,
          elapsedMs: result.elapsedMs,
          screenshot: {
            base64: result.screenshot.toString("base64"),
            width: DESKTOP_RESOLUTION.width,
            height: DESKTOP_RESOLUTION.height,
            capturedAt: new Date().toISOString(),
            mimeType: "image/jpeg",
            url: "desktop://khloei",
          },
        });
      } catch (error) {
        if (request.signal.aborted) {
          return json({ error: "Stopped.", stopped: true }, 499);
        }
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        return json({ error: describe(error, "The desktop action failed.") }, 400);
      }
    }

    // The Bot's files. Confined to the workspace by workspace.ts. Nothing here decides whether a Bot
    // MAY touch a path: the gateway in front of this process does that.
    if (url.pathname === "/files/read" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
      } | null;
      try {
        return json(await workspace.read(String(body?.path ?? "")));
      } catch (error) {
        return json(
          { error: describe(error, "The file could not be read.") },
          fileStatus(error),
        );
      }
    }

    if (url.pathname === "/files/list" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
      } | null;
      try {
        return json(
          await workspace.list(
            typeof body?.path === "string" ? body.path : undefined,
          ),
        );
      } catch (error) {
        return json(
          { error: describe(error, "The folder could not be listed.") },
          fileStatus(error),
        );
      }
    }

    /**
     * A governed command in the persistent workspace.
     *
     * This endpoint is enabled only by the desktop image and refuses to run as root. The app gateway
     * has already decided and durably audited the exact command before it reaches this boundary.
     */
    if (url.pathname === "/exec" && request.method === "POST") {
      if (!SHELL_ENABLED) return json({ error: "Not found." }, 404);
      if (!shellAvailable()) {
        return json(
          { error: "The command runner refuses to run as root." },
          503,
        );
      }
      const body = (await request.json().catch(() => null)) as {
        command?: unknown;
        timeoutMs?: unknown;
      } | null;
      if (
        typeof body?.command !== "string" ||
        !body.command.trim() ||
        body.command.length > 20_000
      ) {
        return json({ error: "A command of at most 20,000 characters is required." }, 400);
      }
      try {
        session.control.assertBotMayAct();
        return json(
          await shell.run({
            command: body.command,
            ...(typeof body.timeoutMs === "number"
              ? { timeoutMs: body.timeoutMs }
              : {}),
            signal: request.signal,
          }),
        );
      } catch (error) {
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        return json(
          { error: describe(error, "The command could not be run.") },
          500,
        );
      }
    }

    if (url.pathname === "/files/write" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
        contents?: unknown;
        append?: unknown;
      } | null;
      if (typeof body?.contents !== "string") {
        return json({ error: "The contents to write are required." }, 400);
      }
      try {
        return json(
          await workspace.write(String(body?.path ?? ""), body.contents, {
            append: body.append === true,
          }),
        );
      } catch (error) {
        return json(
          { error: describe(error, "The file could not be written.") },
          fileStatus(error),
        );
      }
    }

    // The current page as text, without navigating anywhere.
    //
    // Reading must be available after actions too. Returning page text only from `/navigate` would be enough if
    // opening a page were the only way to change what is on screen. It is not: the Bot presses
    // "Submit order", the page becomes a confirmation, and it has no way to find out what the
    // confirmation said. "I clicked the button" is not an answer to what happened.
    if (url.pathname === "/read" && request.method === "GET") {
      try {
        const target = await currentPage(botId);
        const extract = await readablePageText(target);
        return json({
          url: target.url(),
          title: await target.title(),
          text: extract.text,
          truncated: extract.truncated,
        });
      } catch (error) {
        return json(
          { error: describe(error, "Reading the page failed.") },
          502,
        );
      }
    }

    // The list of things on the page a Bot can act on. POST rather than GET because it mutates the
    // page, stamping every element it describes, and a GET that changes the document is a lie that
    // caches and prefetchers eventually punish.
    if (url.pathname === "/snapshot" && request.method === "POST") {
      try {
        return json(await snapshotPage(session, await currentPage(botId)));
      } catch (error) {
        return json({ error: describe(error, "Snapshot failed.") }, 502);
      }
    }

    if (ACTIONS.has(url.pathname) && request.method === "POST") {
      const body = (await request
        .json()
        .catch(() => null)) as ActionBody | null;
      if (!body) {
        return json({ error: "An action needs a JSON body." }, 400);
      }

      const startedAt = Date.now();
      try {
        session.control.assertBotMayAct();
        const target = await currentPage(botId);
        const detail = await performAction(
          session,
          target,
          url.pathname,
          body,
          // The caller going away is the stop signal: the surface aborts its request, the server
          // aborts the one it made to this computer, and Bun aborts this one in turn.
          request.signal,
        );
        return json({ ...detail, elapsedMs: Date.now() - startedAt });
      } catch (error) {
        /*
         * Stopped, not failed. The signal is checked rather than the error text: Playwright words an
         * abort differently per call, and the caller's own request going away is the fact that
         * matters either way.
         *
         * Logged because the response is not observed after the caller aborts. The log distinguishes
         * "stopped in time" from "ran to completion after cancellation".
         */
        if (request.signal.aborted) {
          console.info(
            JSON.stringify({
              type: "action-stopped",
              action: url.pathname,
              ref: typeof body.ref === "string" ? body.ref : undefined,
              elapsedMs: Date.now() - startedAt,
            }),
          );
          // 499, the convention for a client that closed the request: this is not the computer
          // failing, and a 502 here would be counted as one.
          return json({ error: "Stopped.", stopped: true }, 499);
        }
        // A stale ref is the caller's mistake and is fixable by taking a new snapshot, so it is a 409
        // rather than a 502: the computer is fine and retrying the same call unchanged will not help.
        if (error instanceof StaleSnapshotError) {
          return json({ error: error.message, stale: true }, 409);
        }
        // 409 as well, and for the same reason: nothing is broken, the caller simply has to wait.
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        return json({ error: describe(error, "The action failed.") }, 502);
      }
    }

    return json({ error: "Not found." }, 404);
  },
});

type ActionBody = {
  computerSessionId?: unknown;
  ref?: unknown;
  snapshotId?: unknown;
  text?: unknown;
  key?: unknown;
  deltaY?: unknown;
  submit?: unknown;
};

const ACTIONS = new Set(["/click", "/type", "/key", "/scroll"]);

const HUMAN_INPUT = new Set([
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
]);

/**
 * Carry out one thing a person did with their mouse or keyboard.
 *
 * Coordinates are viewport pixels, which the surface works out from the screenshot it is displaying:
 * it knows the image's natural size and the size it drew it at, so it can scale a click back. Doing
 * that conversion in the browser rather than here keeps this endpoint bound to page coordinates
 * rather than window coordinates.
 *
 * Nothing a person types here reaches the model. It goes from their keyboard to this browser and
 * stops. That is what makes a password or a one-time code safe to enter during a takeover: not a
 * filter that strips it out afterwards, but a path the model is not on. The same reason the value is
 * never returned and never logged below.
 */
async function performHumanInput(
  target: Page,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("A click needs an x and a y inside the page.");
    }
    // Clamped rather than rejected. A click a pixel outside the viewport is a rounding artefact of
    // scaling the screenshot, not a mistake worth refusing.
    return {
      x: Math.min(Math.max(x, 0), VIEWPORT.width - 1),
      y: Math.min(Math.max(y, 0), VIEWPORT.height - 1),
    };
  };

  if (action === "/human/click") {
    const { x, y } = at();
    await target.mouse.click(x, y);
    return { action: "human_click", url: target.url() };
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") {
      throw new Error("Typing needs text.");
    }
    // `insertText` rather than per-key typing: a person pasting a one-time code should not have it
    // arrive one character at a time into a field that reformats as you go.
    await target.keyboard.insertText(body.text);
    // Length only, never the value. See the note above about the model not being on this path.
    return {
      action: "human_type",
      characters: body.text.length,
      url: target.url(),
    };
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name.");
    }
    await target.keyboard.press(body.key);
    return { action: "human_key", key: body.key, url: target.url() };
  }

  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 400;
  await target.mouse.wheel(0, deltaY);
  return { action: "human_scroll", deltaY, url: target.url() };
}

/**
 * Carry out one action on the page.
 *
 * Every action that addresses an element goes through {@link locateRef}, so the staleness check
 * cannot be forgotten at a call site. `/key` and `/scroll` may omit a ref and act on the page itself,
 * which is how a Bot presses Enter to submit or scrolls to bring more of a long form into view.
 *
 * Stop has to reach the browser. `signal` is the caller's request going away, the person pressed
 * Stop, and the abort travels from the surface, through the server, to here. Without passing it on,
 * pressing Stop ended the run in the transcript while the click it was meant to prevent carried on
 * landing on a live page. Stop must reach the browser before a high-impact click lands.
 */
async function performAction(
  session: BotSession,
  target: Page,
  action: string,
  body: ActionBody,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Passed to every Playwright call below. It does not disable the timeout, which still applies.
  const acting = { timeout: ACTION_TIMEOUT_MS, ...(signal ? { signal } : {}) };
  const expected =
    typeof body.snapshotId === "number" ? body.snapshotId : undefined;
  const expectedComputerSessionId =
    typeof body.computerSessionId === "string"
      ? body.computerSessionId
      : undefined;
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;

  if (action === "/click") {
    if (!ref) throw new Error("A click needs the ref of an element to click.");
    await (
      await resolveRef(
        session,
        target,
        ref,
        expected,
        expectedComputerSessionId,
      )
    ).click(acting);
    return { action: "click", ref, url: target.url() };
  }

  if (action === "/type") {
    if (!ref) throw new Error("Typing needs the ref of a field to type into.");
    if (typeof body.text !== "string") {
      throw new Error("Typing needs the text to enter.");
    }
    const field = await resolveRef(
      session,
      target,
      ref,
      expected,
      expectedComputerSessionId,
    );
    // `fill` rather than keystrokes: it clears the field first, which is what "put this value in
    // this box" means. Typing into a field a previous attempt half-filled otherwise appends, and the
    // form ends up with "AlicAlice" in it.
    await field.fill(body.text, acting);
    if (body.submit === true) {
      await field.press("Enter", acting);
    }
    // The text itself is deliberately NOT returned. It is echoed nowhere: this response is read by
    // the model and logged by the server, and a value typed into a form is exactly where a password
    // or a card number lives. The caller already knows what it sent.
    return {
      action: "type",
      ref,
      characters: body.text.length,
      submitted: body.submit === true,
      url: target.url(),
    };
  }

  if (action === "/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name, such as Enter or Tab.");
    }
    if (ref) {
      await (
        await resolveRef(
          session,
          target,
          ref,
          expected,
          expectedComputerSessionId,
        )
      ).press(
        body.key,
        acting,
      );
    } else {
      await target.keyboard.press(body.key);
    }
    return { action: "key", key: body.key, ref, url: target.url() };
  }

  // Scroll. A plain wheel event on the page, which is what moves a long form, rather than scrolling a
  // specific element into view: the Bot asked to see further down, not to hunt for one control.
  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 600;
  await target.mouse.wheel(0, deltaY);
  return { action: "scroll", deltaY, url: target.url() };
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Which status a file failure deserves.
 *
 * A path outside the workspace is the caller asking for something it may never have, so 403: retrying
 * it unchanged will never work, and it is not a fault. A missing file or an oversized write is a 400,
 * because a different request would succeed. Collapsing both into 500 would tell the Bot the computer
 * is broken and invite it to try the same thing again.
 */
function fileStatus(error: unknown): 400 | 403 | 500 {
  if (error instanceof WorkspacePathError) return 403;
  if (error instanceof WorkspaceFileError) return 400;
  return 500;
}

console.info(`agent-computer listening on http://localhost:${PORT}`);

/**
 * Hand the profile back before dying.
 *
 * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait, so this is the window in
 * which Chromium can flush its profile to the volume. This is the graceful-shutdown path for normal
 * container restarts.
 *
 * `stop_grace_period` in docker-compose.yml is what gives this time to run.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      console.info(`${signal}: closing the browser so its profile is flushed`);
      await profiles.closeAll();
      process.exit(0);
    })();
  });
}
