import { describe, expect, test } from "bun:test";
import {
  batchXdotoolCommands,
  desktopActionCommands,
  desktopCaptureCommand,
  desktopInputCommands,
  splitJpegFrames,
  synchronizeDesktopOperation,
} from "../src/desktop-screencast";
import {
  parseComputerSurface,
  parseDesktopFrameRate,
  parseDesktopJpegQuality,
  parseDesktopResolution,
} from "../src/surface";

describe("desktop surface configuration", () => {
  test("desktop mode is explicit and browser remains the safe default", () => {
    expect(parseComputerSurface("desktop")).toBe("desktop");
    expect(parseComputerSurface(" DESKTOP ")).toBe("desktop");
    expect(parseComputerSurface(undefined)).toBe("browser");
    expect(parseComputerSurface("anything-else")).toBe("browser");
  });

  test("resolution is bounded", () => {
    expect(parseDesktopResolution("1600x900")).toEqual({ width: 1600, height: 900 });
    expect(parseDesktopResolution("8000x4000")).toEqual({ width: 1920, height: 1080 });
    expect(parseDesktopResolution("broken")).toEqual({ width: 1920, height: 1080 });
  });

  test("stream quality settings are high by default and bounded", () => {
    expect(parseDesktopFrameRate(undefined)).toBe(30);
    expect(parseDesktopFrameRate("30")).toBe(30);
    expect(parseDesktopFrameRate("60")).toBe(30);
    expect(parseDesktopJpegQuality(undefined)).toBe(2);
    expect(parseDesktopJpegQuality("2")).toBe(2);
    expect(parseDesktopJpegQuality("1")).toBe(2);
  });
});

describe("desktop frame parsing", () => {
  const jpeg = (...payload: number[]) => Buffer.from([0xff, 0xd8, ...payload, 0xff, 0xd9]);

  test("extracts multiple frames and keeps a partial frame", () => {
    const first = jpeg(1, 2);
    const second = jpeg(3, 4, 5);
    const partial = Buffer.from([0xff, 0xd8, 9]);
    const split = splitJpegFrames(Buffer.concat([Buffer.from([0]), first, second, partial]));

    expect(split.frames).toEqual([first, second]);
    expect(split.remainder).toEqual(partial);
  });

  test("keeps a split start marker", () => {
    const split = splitJpegFrames(Buffer.from([1, 2, 0xff]));
    expect(split.frames).toHaveLength(0);
    expect(split.remainder).toEqual(Buffer.from([0xff]));
  });
});

describe("desktop cursor capture", () => {
  const drawMouseValue = (command: string[]) => {
    const option = command.indexOf("-draw_mouse");
    return command[option + 1];
  };

  test("shows Khloei's cursor until a person takes control", () => {
    expect(drawMouseValue(desktopCaptureCommand("mjpeg"))).toBe("1");
    expect(
      drawMouseValue(
        desktopCaptureCommand("mjpeg", undefined, undefined, false),
      ),
    ).toBe("0");
  });

  test("captures one maximum-quality JPEG for each model action", () => {
    const command = desktopCaptureCommand("jpeg");
    expect(command.slice(command.indexOf("-frames:v"), command.indexOf("-frames:v") + 2)).toEqual([
      "-frames:v",
      "1",
    ]);
    expect(command.slice(command.indexOf("-c:v"), command.indexOf("-c:v") + 2)).toEqual([
      "-c:v",
      "mjpeg",
    ]);
    expect(command.slice(command.indexOf("-q:v"), command.indexOf("-q:v") + 2)).toEqual([
      "-q:v",
      "2",
    ]);
  });
});

describe("xdotool batching", () => {
  test("chains a burst of pointer samples into one invocation", () => {
    // Every spawn costs far more than the X request it carries, so a drag that
    // spawned once per sample was paying that cost dozens of times.
    expect(
      batchXdotoolCommands([
        ["mousemove", "10", "20"],
        ["mousedown", "1"],
        ["mousemove", "--sync", "30", "40"],
        ["mouseup", "1"],
      ]),
    ).toEqual([
      [
        "mousemove", "10", "20",
        "mousedown", "1",
        "mousemove", "--sync", "30", "40",
        "mouseup", "1",
      ],
    ])
  })

  test("keeps typed text in its own invocation and preserves order", () => {
    // Everything after `--` belongs to the typed string, so a command chained
    // after it would be typed rather than run.
    expect(
      batchXdotoolCommands([
        ["mousemove", "5", "5"],
        ["type", "--clearmodifiers", "--delay", "1", "--", "hi"],
        ["key", "--clearmodifiers", "Return"],
      ]),
    ).toEqual([
      ["mousemove", "5", "5"],
      ["type", "--clearmodifiers", "--delay", "1", "--", "hi"],
      ["key", "--clearmodifiers", "Return"],
    ])
  })

  test("returns nothing for nothing", () => {
    expect(batchXdotoolCommands([])).toEqual([])
  })
})

describe("desktop input", () => {
  test("serializes control handovers behind in-flight desktop input", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const input = synchronizeDesktopOperation(async () => {
      order.push("input-start");
      markStarted?.();
      await gate;
      order.push("input-end");
    });
    const takeover = synchronizeDesktopOperation(() => {
      order.push("takeover");
    });

    await started;
    expect(order).toEqual(["input-start"]);
    release?.();
    await Promise.all([input, takeover]);
    expect(order).toEqual(["input-start", "input-end", "takeover"]);
  });

  test("clamps pointer coordinates", () => {
    expect(
      desktopInputCommands(
        {
          type: "mouse",
          event: "pressed",
          x: -50,
          y: 9000,
          button: "right",
        },
        { width: 1280, height: 720 },
      ),
    ).toEqual([
      ["mousemove", "0", "719", "mousedown", "3"],
    ]);
  });

  test("pointer movement never waits for an already-reached coordinate", () => {
    expect(
      desktopInputCommands({
        type: "mouse",
        event: "moved",
        x: 100,
        y: 200,
      }),
    ).toEqual([["mousemove", "100", "200"]]);
  });

  test("passes pasted text as one argument rather than shell syntax", () => {
    const text = "$(touch /tmp/no) `whoami` ' \"";
    expect(desktopInputCommands({ type: "text", text })).toEqual([
      ["type", "--clearmodifiers", "--delay", "1", "--", text],
    ]);
  });

  test("maps editing keys to X11 names", () => {
    expect(
      desktopInputCommands({
        type: "key",
        event: "down",
        key: "Backspace",
        code: "Backspace",
      }),
    ).toEqual([["keydown", "BackSpace"]]);
  });

  test("inserts a printable key once and ignores its matching key-up", () => {
    expect(
      desktopInputCommands({
        type: "key",
        event: "down",
        key: "A",
        code: "KeyA",
        text: "A",
      }),
    ).toEqual([["type", "--clearmodifiers", "--delay", "1", "--", "A"]]);
    expect(
      desktopInputCommands({
        type: "key",
        event: "up",
        key: "A",
        code: "KeyA",
        text: "A",
      }),
    ).toEqual([]);
  });

  test("builds clamped model clicks without shell interpolation", () => {
    expect(
      desktopActionCommands(
        { action: "click", x: -2, y: 999, button: "left" },
        { width: 100, height: 80 },
      ),
    ).toEqual([["mousemove", "0", "79", "click", "1"]]);
  });

  test("maps model chords and keeps typed text in one argument", () => {
    expect(
      desktopActionCommands({
        action: "keypress",
        keys: ["Control", "L"],
      }),
    ).toEqual([["key", "--clearmodifiers", "ctrl+L"]]);
    const text = "$(touch /tmp/no) `whoami`";
    expect(desktopActionCommands({ action: "type", text })).toEqual([
      ["type", "--clearmodifiers", "--delay", "1", "--", text],
    ]);
  });

  test("builds a bounded drag with an explicit release", () => {
    expect(
      desktopActionCommands({
        action: "drag",
        button: "left",
        path: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      }),
    ).toEqual([
      ["mousemove", "10", "20"],
      ["mousedown", "1"],
      ["mousemove", "--sync", "30", "40"],
      ["mouseup", "1"],
    ]);
  });
});
