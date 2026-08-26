/**
 * What a person watches when they expand Khloei's computer.
 *
 * Browser mode is the existing lightweight Playwright service. Desktop mode is
 * enabled only by the desktop image, where the same API runs beside an Xfce
 * session and captures the complete X11 display.
 */
export type ComputerSurface = "browser" | "desktop";

export function parseComputerSurface(value: string | undefined): ComputerSurface {
  return value?.trim().toLowerCase() === "desktop" ? "desktop" : "browser";
}

export const COMPUTER_SURFACE = parseComputerSurface(
  process.env.KHLOEI_COMPUTER_SURFACE,
);

export type DesktopResolution = { width: number; height: number };

const DEFAULT_DESKTOP_RESOLUTION: DesktopResolution = {
  width: 1920,
  height: 1080,
};

const DEFAULT_DESKTOP_FRAME_RATE = 30;
const DEFAULT_DESKTOP_JPEG_QUALITY = 2;

/**
 * Parse the WIDTHxHEIGHT setting while keeping screen capture bounded.
 *
 * The lower bound prevents a malformed value from creating a useless desktop;
 * the upper bound avoids accidentally asking ffmpeg and the model to process an
 * 8K display on every frame.
 */
export function parseDesktopResolution(
  value: string | undefined,
): DesktopResolution {
  const match = value?.trim().match(/^(\d{3,4})x(\d{3,4})$/i);
  if (!match) return DEFAULT_DESKTOP_RESOLUTION;

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width < 640 || width > 3840 || height < 480 || height > 2160) {
    return DEFAULT_DESKTOP_RESOLUTION;
  }
  return { width, height };
}

export const DESKTOP_RESOLUTION = parseDesktopResolution(
  process.env.KHLOEI_DESKTOP_RESOLUTION ?? process.env.VNC_RESOLUTION,
);

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

/** Frames per second for the interactive desktop stream. */
export function parseDesktopFrameRate(value: string | undefined): number {
  return boundedInteger(value, DEFAULT_DESKTOP_FRAME_RATE, 2, 30);
}

/** ffmpeg's MJPEG qscale: 2 is visually lossless and larger values are smaller. */
export function parseDesktopJpegQuality(value: string | undefined): number {
  return boundedInteger(value, DEFAULT_DESKTOP_JPEG_QUALITY, 2, 12);
}

export const DESKTOP_FRAME_RATE = parseDesktopFrameRate(
  process.env.KHLOEI_DESKTOP_FRAME_RATE,
);

export const DESKTOP_JPEG_QUALITY = parseDesktopJpegQuality(
  process.env.KHLOEI_DESKTOP_JPEG_QUALITY,
);

export const DESKTOP_DISPLAY = process.env.DISPLAY?.trim() || ":1";
