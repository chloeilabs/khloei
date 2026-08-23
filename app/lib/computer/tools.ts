import 'server-only'

import type {
  FunctionTool,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses'

import {
  ActionRefusedError,
  type KhloeiComputerGateway,
} from './gateway'

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

export function isBrowserComputerTool(name: string) {
  return BROWSER_ACTIONS.has(name)
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
