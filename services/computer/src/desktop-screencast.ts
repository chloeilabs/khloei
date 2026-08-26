/**
 * Full Linux desktop capture and input for the KasmVNC/Xfce image.
 *
 * KasmVNC owns the Xfce session inside the image, while the default deployment
 * leaves its port unpublished. Khloei's app deliberately keeps using the
 * existing scoped viewer socket. That preserves the one-use viewer credential
 * and the bot/human control lock instead of exposing a second unaudited control
 * path to the React surface.
 */
import type {
  FrameMessage,
  InputMessage,
  Screencast,
} from "./screencast";
import {
  DESKTOP_DISPLAY,
  DESKTOP_FRAME_RATE,
  DESKTOP_JPEG_QUALITY,
  DESKTOP_RESOLUTION,
  type DesktopResolution,
} from "./surface";

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const MAX_PENDING_FRAME_BYTES = 16 * 1024 * 1024;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const CAPTURE_TIMEOUT_MS = 15_000;
const INPUT_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 2_000;
const MAX_QUEUED_INPUTS = 256;
const MAX_DESKTOP_TEXT_LENGTH = 20_000;
const MAX_DESKTOP_KEY_COUNT = 8;
const MAX_DESKTOP_DRAG_POINTS = 100;

type SpawnedProcess = ReturnType<typeof Bun.spawn>;

export type DesktopFrameMessage = Omit<FrameMessage, "data"> & {
  data: Buffer;
};

export type DesktopModelAction =
  | { action: "click"; x: number; y: number; button: "left" | "middle" | "right" }
  | { action: "double_click"; x: number; y: number; button: "left" | "middle" | "right" }
  | { action: "move"; x: number; y: number }
  | { action: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { action: "type"; text: string }
  | { action: "keypress"; keys: string[] }
  | {
      action: "drag";
      path: Array<{ x: number; y: number }>;
      button: "left" | "middle" | "right";
    }
  | { action: "wait"; durationMs: number };

let desktopOperationQueue: Promise<void> = Promise.resolve();

/** Keep human and model X11 input from interleaving during a handover. */
function enqueueDesktopOperation<T>(operation: () => Promise<T>): Promise<T> {
  const current = desktopOperationQueue.catch(() => undefined).then(operation);
  desktopOperationQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

/** Order a desktop control-state transition with all X11 input. */
export function synchronizeDesktopOperation<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  return enqueueDesktopOperation(async () => operation());
}

/** Split complete JPEGs out of ffmpeg's image2pipe byte stream. */
export function splitJpegFrames(input: Buffer): {
  frames: Buffer[];
  remainder: Buffer;
} {
  const frames: Buffer[] = [];
  let cursor = 0;

  for (;;) {
    const start = input.indexOf(JPEG_START, cursor);
    if (start < 0) {
      // Keep a possible first marker byte split across two chunks.
      const keep = input.at(-1) === JPEG_START[0] ? input.subarray(-1) : Buffer.alloc(0);
      return { frames, remainder: keep };
    }
    const end = input.indexOf(JPEG_END, start + JPEG_START.length);
    if (end < 0) return { frames, remainder: input.subarray(start) };
    frames.push(input.subarray(start, end + JPEG_END.length));
    cursor = end + JPEG_END.length;
    if (cursor >= input.length) return { frames, remainder: Buffer.alloc(0) };
  }
}

function finiteCoordinate(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum - 1, Math.max(0, Math.round(value)));
}

function mouseButton(value: "left" | "middle" | "right" | undefined): string {
  if (value === "middle") return "2";
  if (value === "right") return "3";
  return "1";
}

const X11_KEYS: Record<string, string> = {
  Alt: "alt",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backspace: "BackSpace",
  Control: "ctrl",
  Delete: "Delete",
  End: "End",
  Enter: "Return",
  Escape: "Escape",
  Home: "Home",
  Meta: "super",
  PageDown: "Page_Down",
  PageUp: "Page_Up",
  Shift: "shift",
  Tab: "Tab",
  " ": "space",
};

function x11Key(value: string): string {
  return X11_KEYS[value] ?? value;
}

/**
 * Convert one viewer event to argument-vector commands.
 *
 * Argument arrays are intentional. Human text never enters a shell string, so
 * pasted backticks, substitutions, or quotes cannot become commands.
 */
export function desktopInputCommands(
  message: InputMessage,
  resolution: DesktopResolution = DESKTOP_RESOLUTION,
): string[][] {
  if (message.type === "mouse") {
    const position = [
      String(finiteCoordinate(message.x, resolution.width)),
      String(finiteCoordinate(message.y, resolution.height)),
    ];
    if (message.event === "moved") return [["mousemove", ...position]];
    return [
      [
        "mousemove",
        ...position,
        message.event === "pressed" ? "mousedown" : "mouseup",
        mouseButton(message.button),
      ],
    ];
  }

  if (message.type === "wheel") {
    const position = [
      String(finiteCoordinate(message.x, resolution.width)),
      String(finiteCoordinate(message.y, resolution.height)),
    ];
    const command: string[] = ["mousemove", ...position];
    const addWheel = (delta: number, negative: string, positive: string) => {
      const clicks = Math.min(20, Math.max(0, Math.ceil(Math.abs(delta) / 100)));
      if (clicks > 0) {
        command.push(
          "click",
          "--repeat",
          String(clicks),
          delta < 0 ? negative : positive,
        );
      }
    };
    addWheel(message.deltaY, "4", "5");
    addWheel(message.deltaX, "6", "7");
    return [command];
  }

  if (message.type === "text") {
    return [["type", "--clearmodifiers", "--delay", "1", "--", message.text]];
  }

  // Printable key-down events already carry the text they should insert. Let
  // xdotool synthesize the matching down/up pair once, and ignore the browser's
  // later key-up event for that same character.
  if (message.text && message.event === "down") {
    return [["type", "--clearmodifiers", "--delay", "1", "--", message.text]];
  }
  if (message.text && message.event === "up") return [];
  return [[message.event === "down" ? "keydown" : "keyup", x11Key(message.key)]];
}

async function processError(process: SpawnedProcess): Promise<string> {
  if (!process.stderr || typeof process.stderr === "number") return "";
  return new Response(process.stderr).text().catch(() => "");
}

async function runXdotool(args: string[]): Promise<void> {
  const process = Bun.spawn(["xdotool", ...args], {
    env: {
      DISPLAY: DESKTOP_DISPLAY,
      HOME: Bun.env.HOME ?? "/home/kasm-user",
      PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...(Bun.env.XAUTHORITY ? { XAUTHORITY: Bun.env.XAUTHORITY } : {}),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => process.kill("SIGKILL"), INPUT_TIMEOUT_MS);
  try {
    const [code, stderr] = await Promise.all([process.exited, processError(process)]);
    if (code !== 0) {
      throw new Error(stderr.trim() || `xdotool exited with status ${code}.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function applyDesktopInput(message: InputMessage): Promise<void> {
  await enqueueDesktopOperation(async () => {
    for (const args of desktopInputCommands(message)) await runXdotool(args);
  });
}

function requiredFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function modelPosition(
  action: { x: number; y: number },
  resolution: DesktopResolution,
): [string, string] {
  return [
    String(finiteCoordinate(requiredFinite(action.x, "x"), resolution.width)),
    String(finiteCoordinate(requiredFinite(action.y, "y"), resolution.height)),
  ];
}

/** Convert one model visual action to shell-free xdotool argument vectors. */
export function desktopActionCommands(
  action: DesktopModelAction,
  resolution: DesktopResolution = DESKTOP_RESOLUTION,
): string[][] {
  if (action.action === "click" || action.action === "double_click") {
    const position = modelPosition(action, resolution);
    return [[
      "mousemove",
      ...position,
      "click",
      ...(action.action === "double_click"
        ? ["--repeat", "2", "--delay", "120"]
        : []),
      mouseButton(action.button),
    ]];
  }
  if (action.action === "move") {
    return [["mousemove", ...modelPosition(action, resolution)]];
  }
  if (action.action === "scroll") {
    const input: InputMessage = {
      type: "wheel",
      x: requiredFinite(action.x, "x"),
      y: requiredFinite(action.y, "y"),
      deltaX: requiredFinite(action.deltaX, "deltaX"),
      deltaY: requiredFinite(action.deltaY, "deltaY"),
    };
    return desktopInputCommands(input, resolution);
  }
  if (action.action === "type") {
    if (typeof action.text !== "string" || action.text.length > MAX_DESKTOP_TEXT_LENGTH) {
      throw new Error(`Desktop text must be at most ${MAX_DESKTOP_TEXT_LENGTH} characters.`);
    }
    return [["type", "--clearmodifiers", "--delay", "1", "--", action.text]];
  }
  if (action.action === "keypress") {
    if (
      !Array.isArray(action.keys) ||
      action.keys.length < 1 ||
      action.keys.length > MAX_DESKTOP_KEY_COUNT ||
      action.keys.some((key) => typeof key !== "string" || !key || key.length > 50)
    ) {
      throw new Error(`A keypress needs 1-${MAX_DESKTOP_KEY_COUNT} usable key names.`);
    }
    return [["key", "--clearmodifiers", action.keys.map(x11Key).join("+")]];
  }
  if (action.action === "drag") {
    if (
      !Array.isArray(action.path) ||
      action.path.length < 2 ||
      action.path.length > MAX_DESKTOP_DRAG_POINTS
    ) {
      throw new Error(`A drag needs 2-${MAX_DESKTOP_DRAG_POINTS} points.`);
    }
    const [first, ...rest] = action.path;
    const button = mouseButton(action.button);
    return [
      ["mousemove", ...modelPosition(first!, resolution)],
      ["mousedown", button],
      ...rest.map((point) => [
        "mousemove",
        "--sync",
        ...modelPosition(point, resolution),
      ]),
      ["mouseup", button],
    ];
  }
  if (action.action === "wait") {
    if (!Number.isFinite(action.durationMs) || action.durationMs < 100 || action.durationMs > 5_000) {
      throw new Error("Desktop wait must be between 100 and 5,000 milliseconds.");
    }
    return [];
  }
  throw new Error("That desktop action is not supported.");
}

/**
 * What geometry the X display actually reports, or null when it cannot be read.
 *
 * Returned rather than compared away: "the desktop is not ready" is far less
 * useful to whoever has to fix it than "the desktop is 1024x768 and we expect
 * 1920x1080", and on a host whose logs are rotated the difference is the only
 * thing that reaches an operator.
 */
export async function desktopGeometry(): Promise<string | null> {
  try {
    const process = Bun.spawn(["xdotool", "getdisplaygeometry"], {
      env: { ...Bun.env, DISPLAY: DESKTOP_DISPLAY },
      stdout: "pipe",
      stderr: "ignore",
    });
    const timeout = setTimeout(() => process.kill("SIGKILL"), READY_TIMEOUT_MS);
    try {
      const [code, output] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);
      return code === 0 ? output.trim() || null : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

/**
 * Enough about the X server to tell apart the ways it can be missing.
 *
 * A null geometry says only that the display could not be read. Whether an X
 * socket exists, and whether an Xvnc process is alive, separates "the desktop
 * never started" from "it started and this process cannot reach it" -- which
 * are different bugs with different fixes. Neither value is sensitive: it is a
 * socket name and a process count.
 */
export async function desktopDiagnostics(): Promise<{
  home: string;
  homeWritable: boolean;
  sockets: string[];
  uid: number | null;
  vncProcesses: number;
  vncStateWritable: boolean;
}> {
  const sockets = await Array.fromAsync(
    new Bun.Glob("*").scan({ cwd: "/tmp/.X11-unix", onlyFiles: false }),
  ).catch(() => [] as string[]);

  let vncProcesses = 0;
  try {
    const process = Bun.spawn(["pgrep", "-c", "-f", "Xvnc|Xtigervnc"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const timeout = setTimeout(() => process.kill("SIGKILL"), READY_TIMEOUT_MS);
    try {
      const [, output] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);
      vncProcesses = Number.parseInt(output.trim(), 10) || 0;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // pgrep absent or unreadable; the socket list still carries information.
  }

  // The X server writes its own state under HOME before it ever listens. HOME
  // is a symlink onto the mounted volume, and the volume is only made writable
  // by the privileged first pass of the entrypoint, so a runtime that starts
  // the container unprivileged leaves the desktop unable to start while every
  // other tool keeps working. Probe it rather than infer it.
  const home = Bun.env.HOME ?? "/home/kasm-user";
  const canWrite = async (directory: string) => {
    const probe = `${directory}/.khloei-write-probe-${process.pid}`;
    try {
      await Bun.write(probe, "");
      await Bun.file(probe).delete();
      return true;
    } catch {
      return false;
    }
  };

  return {
    home,
    homeWritable: await canWrite(home),
    sockets,
    uid: process.getuid?.() ?? null,
    vncProcesses,
    vncStateWritable: await canWrite(`${home}/.vnc`),
  };
}

/** The geometry our frames and pointer coordinates advertise. */
export function expectedDesktopGeometry(): string {
  return `${DESKTOP_RESOLUTION.width} ${DESKTOP_RESOLUTION.height}`;
}

/** True only after Xfce's X display has the exact geometry our frames advertise. */
export async function desktopReady(): Promise<boolean> {
  return (await desktopGeometry()) === expectedDesktopGeometry();
}

export function desktopCaptureCommand(
  format: "jpeg" | "mjpeg" | "png",
  resolution = DESKTOP_RESOLUTION,
  jpegQuality = DESKTOP_JPEG_QUALITY,
  drawMouseCursor = true,
) {
  return [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-draw_mouse",
    drawMouseCursor ? "1" : "0",
    "-video_size",
    `${resolution.width}x${resolution.height}`,
    "-i",
    DESKTOP_DISPLAY,
    ...(format === "mjpeg" || format === "jpeg"
      ? [
          ...(format === "jpeg" ? ["-frames:v", "1"] : []),
          "-an",
          "-c:v",
          "mjpeg",
          "-q:v",
          String(jpegQuality),
          "-f",
          "image2pipe",
          "pipe:1",
        ]
      : ["-frames:v", "1", "-an", "-c:v", "png", "-f", "image2pipe", "pipe:1"]),
  ];
}

async function captureDesktopScreenshotNow(
  format: "jpeg" | "png",
): Promise<Buffer> {
  const process = Bun.spawn(desktopCaptureCommand(format), {
    env: { ...Bun.env, DISPLAY: DESKTOP_DISPLAY },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(
    () => process.kill("SIGKILL"),
    CAPTURE_TIMEOUT_MS,
  );
  const [code, output, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    processError(process),
  ]).finally(() => clearTimeout(timeout));
  if (code !== 0) {
    throw new Error(stderr.trim() || `Desktop capture exited with status ${code}.`);
  }
  const buffer = Buffer.from(output);
  if (buffer.length === 0) throw new Error("Desktop capture returned no pixels.");
  return buffer;
}

/** Capture one desktop frame without racing an input operation. */
export function captureDesktopScreenshot(
  format: "jpeg" | "png" = "png",
): Promise<Buffer> {
  return enqueueDesktopOperation(() => captureDesktopScreenshotNow(format));
}

/** Carry out one model action and capture the exact resulting desktop state. */
export function performDesktopAction(
  action: DesktopModelAction,
  signal?: AbortSignal,
  assertBotMayAct?: () => void,
): Promise<{ action: DesktopModelAction["action"]; elapsedMs: number; screenshot: Buffer }> {
  return enqueueDesktopOperation(async () => {
    const startedAt = Date.now();
    const commands = desktopActionCommands(action);
    assertBotMayAct?.();
    if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
    if (action.action === "wait") {
      await new Promise<void>((resolve, reject) => {
        const complete = () => {
          signal?.removeEventListener("abort", aborted);
          resolve();
        };
        const timeout = setTimeout(complete, action.durationMs);
        const aborted = () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", aborted);
          reject(new DOMException("Stopped.", "AbortError"));
        };
        signal?.addEventListener("abort", aborted, { once: true });
      });
    } else {
      let dragging = false;
      try {
        for (const args of commands) {
          if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
          await runXdotool(args);
          if (args[0] === "mousedown") dragging = true;
          if (args[0] === "mouseup") dragging = false;
        }
      } finally {
        if (dragging && action.action === "drag") {
          await runXdotool(["mouseup", mouseButton(action.button)]).catch(
            () => undefined,
          );
        }
      }
    }
    if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
    return {
      action: action.action,
      elapsedMs: Date.now() - startedAt,
      screenshot: await captureDesktopScreenshotNow("jpeg"),
    };
  });
}

/**
 * Start a change-independent desktop stream.
 *
 * A full desktop has animations, clocks and cursors outside Chromium, so CDP's
 * page-change stream cannot represent it. ffmpeg captures the X11 root window
 * at a deliberately modest frame rate; the viewer socket still provides
 * backpressure at the application boundary.
 */
export async function startDesktopScreencast(
  onFrame: (frame: DesktopFrameMessage) => void,
  options: {
    drawMouseCursor?: boolean;
    frameRate?: number;
    jpegQuality?: number;
    onError?: (error: Error) => void;
  } = {},
): Promise<Screencast> {
  const frameRate = Math.min(
    30,
    Math.max(2, Math.round(options.frameRate ?? DESKTOP_FRAME_RATE)),
  );
  const jpegQuality = Math.min(
    12,
    Math.max(2, Math.round(options.jpegQuality ?? DESKTOP_JPEG_QUALITY)),
  );
  const command = desktopCaptureCommand(
    "mjpeg",
    DESKTOP_RESOLUTION,
    jpegQuality,
    options.drawMouseCursor ?? true,
  );
  command.splice(command.indexOf("-video_size"), 0, "-framerate", String(frameRate));

  const process = Bun.spawn(command, {
    env: { ...Bun.env, DISPLAY: DESKTOP_DISPLAY },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stopped = false;
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const queuedInputs: InputMessage[] = [];
  let inputDrain: Promise<void> | undefined;
  let firstFrameResolve: (() => void) | undefined;
  let firstFrameReject: ((error: Error) => void) | undefined;
  const firstFrame = new Promise<void>((resolve, reject) => {
    firstFrameResolve = resolve;
    firstFrameReject = reject;
  });

  const pump = async () => {
    try {
      const reader = process.stdout.getReader();
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        pending = Buffer.concat([pending, Buffer.from(value)]);
        if (pending.length > MAX_PENDING_FRAME_BYTES) {
          throw new Error("The desktop frame stream exceeded its safety limit.");
        }
        const split = splitJpegFrames(pending);
        pending = split.remainder;
        for (const jpeg of split.frames) {
          onFrame({
            type: "frame",
            data: jpeg,
            width: DESKTOP_RESOLUTION.width,
            height: DESKTOP_RESOLUTION.height,
          });
          firstFrameResolve?.();
          firstFrameResolve = undefined;
          firstFrameReject = undefined;
        }
      }
      if (!stopped) {
        const stderr = await processError(process);
        throw new Error(stderr.trim() || "The desktop frame stream stopped unexpectedly.");
      }
    } catch (error) {
      const described = error instanceof Error ? error : new Error(String(error));
      if (firstFrameReject) firstFrameReject(described);
      else if (!stopped) options.onError?.(described);
      firstFrameResolve = undefined;
      firstFrameReject = undefined;
    }
  };
  void pump();

  const timeout = setTimeout(() => {
    firstFrameReject?.(new Error("The Linux desktop did not produce a frame in time."));
    firstFrameResolve = undefined;
    firstFrameReject = undefined;
  }, FIRST_FRAME_TIMEOUT_MS);
  try {
    await firstFrame;
  } catch (error) {
    stopped = true;
    process.kill("SIGTERM");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      process.kill("SIGTERM");
      await process.exited.catch(() => undefined);
    },

    async send(message: InputMessage) {
      if (stopped) return;
      const previous = queuedInputs.at(-1);
      if (
        message.type === "mouse" &&
        message.event === "moved" &&
        previous?.type === "mouse" &&
        previous.event === "moved"
      ) {
        queuedInputs[queuedInputs.length - 1] = message;
      } else {
        if (queuedInputs.length >= MAX_QUEUED_INPUTS) {
          throw new Error("Desktop input is arriving faster than it can be applied.");
        }
        queuedInputs.push(message);
      }

      if (!inputDrain) {
        inputDrain = (async () => {
          try {
            while (!stopped && queuedInputs.length > 0) {
              const next = queuedInputs.shift();
              if (next) await applyDesktopInput(next);
            }
          } catch (error) {
            // Do not let one failed X11 action poison every later interaction.
            queuedInputs.length = 0;
            throw error;
          } finally {
            inputDrain = undefined;
          }
        })();
      }
      await inputDrain;
    },
  };
}
