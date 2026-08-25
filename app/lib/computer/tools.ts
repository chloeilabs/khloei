import 'server-only'

import type {
  FunctionTool,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses'

import {
  ActionRefusedError,
  type KhloeiComputerGateway,
} from './gateway'
import type {
  DesktopMouseButton,
  DesktopPoint,
  ScreenshotResult,
} from './schema'

export const KHLOEI_COMPUTER_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    name: 'computer_navigate',
    description:
      'Open a web page on Khloei\'s own browser. Returns the title and readable page text. Use this for website interaction, not when web search alone answers the question.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full http or https URL to open.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_read',
    description:
      'Read the page currently open in Khloei\'s browser without navigating. Use after a click, form submission, or page change.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_snapshot',
    description:
      'List interactive elements on the current page. Call before clicking or typing. Every returned ref is valid only for its snapshotId.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_request_help',
    description:
      'Ask the person watching Khloei\'s computer to take control for a step only they can complete. This is the action that offers them the wheel; asking only in prose does not. Waits for them to hand control back.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'A short explanation of what the person needs to do.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_request_secret',
    description:
      'Ask the person to enter one password, one-time code, card number, or other secret directly into a field without exposing it to the model. Take a fresh snapshot first and pass that field ref; the secure service focuses it. The value is typed but not submitted.',
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Human-readable name of the requested value.',
        },
        ref: { type: 'string' },
        snapshotId: { type: 'number' },
      },
      required: ['label', 'ref', 'snapshotId'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_list_tabs',
    description:
      'List every open browser tab and identify the active tab. Use before switching or closing tabs.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_open_tab',
    description:
      'Open a full http or https URL in a new browser tab and make it active.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full http or https URL to open in the new tab.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_switch_tab',
    description:
      'Switch to an open browser tab by id. Call computer_list_tabs first.',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_close_tab',
    description:
      'Close an open browser tab by id. The browser always keeps at least one tab open.',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_click',
    description:
      'Click an element from the latest computer_snapshot. If refs are stale, take another snapshot rather than guessing.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        snapshotId: { type: 'number' },
      },
      required: ['ref', 'snapshotId'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_type',
    description:
      'Replace the contents of a field from the latest snapshot. Never enter passwords, one-time codes, payment details, or other secrets.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        snapshotId: { type: 'number' },
        text: { type: 'string' },
        submit: {
          type: 'boolean',
          description: 'Whether to press Enter after filling the field.',
        },
      },
      required: ['ref', 'snapshotId', 'text', 'submit'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_key',
    description:
      'Press a keyboard key in the browser. Provide a ref and snapshotId to target an element, or null for both to act on the page.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: ['string', 'null'] },
        snapshotId: { type: ['number', 'null'] },
        key: {
          type: 'string',
          description: 'Playwright key name such as Enter, Tab, or Escape.',
        },
      },
      required: ['ref', 'snapshotId', 'key'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_scroll',
    description: 'Scroll the current browser page vertically.',
    parameters: {
      type: 'object',
      properties: {
        deltaY: {
          type: 'number',
          description: 'Positive scrolls down; negative scrolls up.',
        },
      },
      required: ['deltaY'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_list_files',
    description:
      'List files and folders inside Khloei\'s confined persistent workspace. Use "." for the whole workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_read_file',
    description:
      'Read a UTF-8 text file inside Khloei\'s confined persistent workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_write_file',
    description:
      'Write a UTF-8 text file inside Khloei\'s confined persistent workspace. This cannot reach project or host files outside that workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        contents: { type: 'string' },
        append: { type: 'boolean' },
      },
      required: ['path', 'contents', 'append'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_run_command',
    description:
      "Run a non-interactive Bash command in Khloei's persistent workspace for coding, tests, and local file processing. Pipes, redirection, and && work. The command runs as an unprivileged container user, receives no deployment secrets, is time-bounded, and returns bounded stdout/stderr. It cannot be used to bypass a policy refusal.",
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact command to run in the persistent workspace.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_screenshot',
    description:
      "Capture Khloei's complete Linux desktop at full resolution. Use before any desktop coordinate action and after a person hands control back. Prefer browser refs, files, or shell when they can do the task reliably.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_click',
    description:
      'Click a visible point on the full Linux desktop. Coordinates must come from the latest desktop screenshot; never guess them.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
      },
      required: ['x', 'y', 'button'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_double_click',
    description:
      'Double-click a visible point on the full Linux desktop using coordinates from the latest screenshot.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
      },
      required: ['x', 'y', 'button'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_move',
    description:
      'Move Khloei\'s pointer to a visible desktop coordinate without clicking. Useful for hover-only native UI.',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_scroll',
    description:
      'Scroll at a visible point on the Linux desktop. Positive deltaY scrolls down; negative scrolls up.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
      },
      required: ['x', 'y', 'deltaX', 'deltaY'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_type',
    description:
      'Type non-secret text into the currently focused native desktop control. Never type passwords, codes, payment data, API keys, or other secrets; request human help for those.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_keypress',
    description:
      'Press one key or a chord in a native Linux app. Examples: ["Enter"], ["Control","L"], ["Alt","F4"].',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 8,
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_drag',
    description:
      'Drag through 2-100 points on the full Linux desktop. Every point must come from the latest screenshot.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'array',
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
            additionalProperties: false,
          },
          minItems: 2,
          maxItems: 100,
        },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
      },
      required: ['path', 'button'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'computer_desktop_wait',
    description:
      'Wait briefly for a native app animation or load, then capture a fresh desktop screenshot.',
    parameters: {
      type: 'object',
      properties: {
        durationMs: { type: 'number', minimum: 100, maximum: 5000 },
      },
      required: ['durationMs'],
      additionalProperties: false,
    },
    strict: true,
  },
]

const BROWSER_ACTIONS = new Set([
  'computer_navigate',
  'computer_read',
  'computer_snapshot',
  'computer_open_tab',
  'computer_switch_tab',
  'computer_close_tab',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
])

const DESKTOP_ACTIONS = new Set([
  'computer_desktop_screenshot',
  'computer_desktop_click',
  'computer_desktop_double_click',
  'computer_desktop_move',
  'computer_desktop_scroll',
  'computer_desktop_type',
  'computer_desktop_keypress',
  'computer_desktop_drag',
  'computer_desktop_wait',
])

function argumentsObject(call: ResponseFunctionToolCall) {
  let value: unknown
  try {
    value = JSON.parse(call.arguments || '{}')
  } catch {
    throw new Error(`${call.name} supplied invalid JSON arguments.`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${call.name} arguments must be an object.`)
  }
  return value as Record<string, unknown>
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
) {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${tool} requires ${key}.`)
  }
  return value
}

function requiredText(
  args: Record<string, unknown>,
  key: string,
  tool: string,
) {
  const value = args[key]
  if (typeof value !== 'string') {
    throw new Error(`${tool} requires a string ${key}.`)
  }
  return value
}

function requiredNumber(
  args: Record<string, unknown>,
  key: string,
  tool: string,
) {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${tool} requires a numeric ${key}.`)
  }
  return value
}

function requiredBoolean(
  args: Record<string, unknown>,
  key: string,
  tool: string,
) {
  const value = args[key]
  if (typeof value !== 'boolean') {
    throw new Error(`${tool} requires a boolean ${key}.`)
  }
  return value
}

function requiredDesktopButton(
  args: Record<string, unknown>,
  tool: string,
): DesktopMouseButton {
  const value = args.button
  if (value !== 'left' && value !== 'middle' && value !== 'right') {
    throw new Error(`${tool} requires a left, middle, or right button.`)
  }
  return value
}

function requiredKeys(args: Record<string, unknown>, tool: string) {
  const value = args.keys
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8 ||
    value.some(
      (key) => typeof key !== 'string' || !key || key.length > 50,
    )
  ) {
    throw new Error(`${tool} requires 1-8 usable key names.`)
  }
  return value as string[]
}

function requiredDesktopPath(
  args: Record<string, unknown>,
  tool: string,
): DesktopPoint[] {
  const value = args.path
  if (!Array.isArray(value) || value.length < 2 || value.length > 100) {
    throw new Error(`${tool} requires 2-100 coordinate points.`)
  }
  return value.map((point, index) => {
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      throw new Error(`${tool} point ${index + 1} must contain x and y.`)
    }
    const record = point as Record<string, unknown>
    return {
      x: requiredNumber(record, 'x', tool),
      y: requiredNumber(record, 'y', tool),
    }
  })
}

export function isBrowserComputerTool(name: string) {
  return BROWSER_ACTIONS.has(name)
}

export function isDesktopComputerTool(name: string) {
  return DESKTOP_ACTIONS.has(name)
}

export function desktopScreenshotFromToolOutcome(
  name: string,
  outcome: unknown,
): ScreenshotResult | null {
  if (
    !isDesktopComputerTool(name) ||
    !outcome ||
    typeof outcome !== 'object' ||
    !('ok' in outcome) ||
    outcome.ok !== true ||
    !('result' in outcome) ||
    !outcome.result ||
    typeof outcome.result !== 'object'
  ) {
    return null
  }
  const result = outcome.result as Record<string, unknown>
  const value =
    name === 'computer_desktop_screenshot'
      ? result
      : result.screenshot && typeof result.screenshot === 'object'
        ? (result.screenshot as Record<string, unknown>)
        : null
  if (
    !value ||
    typeof value.base64 !== 'string' ||
    typeof value.width !== 'number' ||
    typeof value.height !== 'number' ||
    typeof value.capturedAt !== 'string'
  ) {
    return null
  }
  return value as ScreenshotResult
}

export async function executeComputerTool(
  call: ResponseFunctionToolCall,
  gateway: KhloeiComputerGateway,
) {
  const activityId = call.call_id

  try {
    const args = argumentsObject(call)
    let result: unknown
    switch (call.name) {
      case 'computer_navigate':
        result = await gateway.navigate(
          { url: requiredString(args, 'url', call.name) },
          activityId,
        )
        break
      case 'computer_read':
        result = await gateway.read(activityId)
        break
      case 'computer_snapshot':
        result = await gateway.snapshot(activityId)
        break
      case 'computer_request_help':
        result = await gateway.requestHelp(
          requiredString(args, 'reason', call.name),
          activityId,
        )
        break
      case 'computer_request_secret':
        result = await gateway.requestSecret(
          {
            label: requiredString(args, 'label', call.name),
            ref: requiredString(args, 'ref', call.name),
            snapshotId: requiredNumber(args, 'snapshotId', call.name),
          },
          activityId,
        )
        break
      case 'computer_list_tabs':
        result = await gateway.listTabs(activityId)
        break
      case 'computer_open_tab':
        result = await gateway.openTab(
          { url: requiredString(args, 'url', call.name) },
          activityId,
        )
        break
      case 'computer_switch_tab':
        result = await gateway.switchTab(
          { tabId: requiredString(args, 'tabId', call.name) },
          activityId,
        )
        break
      case 'computer_close_tab':
        result = await gateway.closeTab(
          { tabId: requiredString(args, 'tabId', call.name) },
          activityId,
        )
        break
      case 'computer_click':
        result = await gateway.click(
          {
            ref: requiredString(args, 'ref', call.name),
            snapshotId: requiredNumber(args, 'snapshotId', call.name),
          },
          activityId,
        )
        break
      case 'computer_type':
        result = await gateway.type(
          {
            ref: requiredString(args, 'ref', call.name),
            snapshotId: requiredNumber(args, 'snapshotId', call.name),
            text: requiredText(args, 'text', call.name),
            submit: requiredBoolean(args, 'submit', call.name),
          },
          activityId,
        )
        break
      case 'computer_key': {
        const ref = args.ref
        const snapshotId = args.snapshotId
        if (ref !== null && typeof ref !== 'string') {
          throw new Error('computer_key ref must be a string or null.')
        }
        if (snapshotId !== null && typeof snapshotId !== 'number') {
          throw new Error('computer_key snapshotId must be a number or null.')
        }
        result = await gateway.key(
          {
            key: requiredString(args, 'key', call.name),
            ...(typeof ref === 'string' ? { ref } : {}),
            ...(typeof snapshotId === 'number' ? { snapshotId } : {}),
          },
          activityId,
        )
        break
      }
      case 'computer_scroll':
        result = await gateway.scroll(
          { deltaY: requiredNumber(args, 'deltaY', call.name) },
          activityId,
        )
        break
      case 'computer_list_files':
        result = await gateway.listFiles(
          { path: requiredString(args, 'path', call.name) },
          activityId,
        )
        break
      case 'computer_read_file':
        result = await gateway.readFile(
          { path: requiredString(args, 'path', call.name) },
          activityId,
        )
        break
      case 'computer_write_file':
        result = await gateway.writeFile(
          {
            path: requiredString(args, 'path', call.name),
            contents: requiredText(args, 'contents', call.name),
            append: requiredBoolean(args, 'append', call.name),
          },
          activityId,
        )
        break
      case 'computer_run_command': {
        const command = requiredString(args, 'command', call.name)
        if (command.length > 20_000) {
          throw new Error('computer_run_command command is too long.')
        }
        result = await gateway.runCommand({ command }, activityId)
        break
      }
      case 'computer_desktop_screenshot':
        result = await gateway.desktopScreenshot(activityId)
        break
      case 'computer_desktop_click':
      case 'computer_desktop_double_click':
        result = await gateway.desktopAction(
          {
            action:
              call.name === 'computer_desktop_click'
                ? 'click'
                : 'double_click',
            x: requiredNumber(args, 'x', call.name),
            y: requiredNumber(args, 'y', call.name),
            button: requiredDesktopButton(args, call.name),
          },
          activityId,
        )
        break
      case 'computer_desktop_move':
        result = await gateway.desktopAction(
          {
            action: 'move',
            x: requiredNumber(args, 'x', call.name),
            y: requiredNumber(args, 'y', call.name),
          },
          activityId,
        )
        break
      case 'computer_desktop_scroll':
        result = await gateway.desktopAction(
          {
            action: 'scroll',
            x: requiredNumber(args, 'x', call.name),
            y: requiredNumber(args, 'y', call.name),
            deltaX: requiredNumber(args, 'deltaX', call.name),
            deltaY: requiredNumber(args, 'deltaY', call.name),
          },
          activityId,
        )
        break
      case 'computer_desktop_type': {
        const text = requiredText(args, 'text', call.name)
        if (text.length > 20_000) {
          throw new Error('computer_desktop_type text is too long.')
        }
        result = await gateway.desktopAction({ action: 'type', text }, activityId)
        break
      }
      case 'computer_desktop_keypress':
        result = await gateway.desktopAction(
          { action: 'keypress', keys: requiredKeys(args, call.name) },
          activityId,
        )
        break
      case 'computer_desktop_drag':
        result = await gateway.desktopAction(
          {
            action: 'drag',
            path: requiredDesktopPath(args, call.name),
            button: requiredDesktopButton(args, call.name),
          },
          activityId,
        )
        break
      case 'computer_desktop_wait': {
        const durationMs = requiredNumber(args, 'durationMs', call.name)
        if (durationMs < 100 || durationMs > 5_000) {
          throw new Error('computer_desktop_wait must be between 100 and 5,000 milliseconds.')
        }
        result = await gateway.desktopAction(
          { action: 'wait', durationMs },
          activityId,
        )
        break
      }
      default:
        throw new Error(`Khloei does not publish the tool ${call.name}.`)
    }
    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'The computer action failed.',
      ...(error instanceof ActionRefusedError
        ? { refused: true, rule: error.rule }
        : {}),
    }
  }
}
