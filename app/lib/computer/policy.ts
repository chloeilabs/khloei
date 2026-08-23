/**
 * A small, non-executable policy language for Khloei's computer gateway.
 *
 * Khloei uses deny-first, default-deny, dry-run/enforce semantics with
 * declarative matchers so an administrator-provided rule is never evaluated
 * as code.
 *
 * Rules are `*`, `tool:<name>`, `intent:<name>`, `host:<hostname>`,
 * `file:<path>`, `extension:<ext>`, `element:<label>`, `actor:<id>`, or
 * `bot:<id>`. A trailing `*` is a prefix wildcard. Matching is
 * case-insensitive.
 */

export type PolicyMode = 'dry-run' | 'enforce'

export type ActionPolicy = {
  mode: PolicyMode
  deny: string[]
  allow: string[]
}

export type PolicyContext = {
  tool: { name: string }
  bot: { id: string }
  page: { url: string; host: string }
  actor: { id: string }
  element?: {
    ref: string
    role: string
    name: string
    type?: string
  }
  key?: string
  intent?:
    | 'activate'
    | 'type'
    | 'navigate'
    | 'read'
    | 'read_file'
    | 'write_file'
    | 'list_files'
    | 'read_tool'
    | 'write_tool'
    | 'run_command'
  file?: {
    path: string
    name: string
    extension: string
  }
  command?: string
}

export type PolicyDecision = {
  allowed: boolean
  mode: PolicyMode
  matched: string | null
  source: 'deny' | 'allow' | 'default'
  forward: boolean
  reason: string
}

const RULE_FIELDS = new Set([
  'actor',
  'bot',
  'element',
  'extension',
  'file',
  'host',
  'intent',
  'tool',
])

function valueFor(field: string, context: PolicyContext) {
  switch (field) {
    case 'actor':
      return context.actor.id
    case 'bot':
      return context.bot.id
    case 'element':
      return context.element?.name ?? ''
    case 'extension':
      return context.file?.extension ?? ''
    case 'file':
      return context.file?.path ?? ''
    case 'host':
      return context.page.host
    case 'intent':
      return context.intent ?? ''
    case 'tool':
      return context.tool.name
    default:
      return ''
  }
}

function matchesRule(rule: string, context: PolicyContext) {
  const normalized = rule.trim()
  if (normalized === '*' || normalized.toLowerCase() === 'true') return true

  const colon = normalized.indexOf(':')
  if (colon <= 0 || colon === normalized.length - 1) {
    throw new Error(`Unknown computer policy rule: ${rule}`)
  }
  const field = normalized.slice(0, colon).trim().toLowerCase()
  const expected = normalized.slice(colon + 1).trim().toLowerCase()
  if (!RULE_FIELDS.has(field)) {
    throw new Error(`Unknown computer policy field: ${field}`)
  }

  const actual = valueFor(field, context).toLowerCase()
  if (expected.endsWith('*')) {
    return actual.startsWith(expected.slice(0, -1))
  }
  if (field === 'element') return actual.includes(expected)
  if (field === 'host') {
    return actual === expected || actual.endsWith(`.${expected}`)
  }
  return actual === expected
}

function refusal(context: PolicyContext, rule: string) {
  const subject = context.file?.path
    ? `the file ${context.file.path}`
    : context.element?.name
      ? `“${context.element.name}”`
      : context.page.host
        ? `${context.tool.name} on ${context.page.host}`
        : context.tool.name
  return `Khloei's computer policy blocks ${subject} by the rule \`${rule}\`.`
}

export function evaluateActionPolicy(
  policy: ActionPolicy | null | undefined,
  context: PolicyContext,
): PolicyDecision {
  const mode = policy?.mode ?? 'enforce'
  const deny = policy?.deny ?? []
  const allow = policy?.allow ?? []

  for (const rule of deny) {
    let matched = false
    try {
      matched = matchesRule(rule, context)
    } catch (error) {
      console.error(
        JSON.stringify({
          type: 'computer-policy-rule-error',
          rule,
          error: error instanceof Error ? error.message : String(error),
          treatedAs: true,
        }),
      )
      matched = true
    }
    if (matched) {
      return {
        allowed: false,
        mode,
        matched: rule,
        source: 'deny',
        forward: mode === 'dry-run',
        reason: refusal(context, rule),
      }
    }
  }

  for (const rule of allow) {
    try {
      if (matchesRule(rule, context)) {
        return {
          allowed: true,
          mode,
          matched: rule,
          source: 'allow',
          forward: true,
          reason: 'Permitted by Khloei computer policy.',
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: 'computer-policy-rule-error',
          rule,
          error: error instanceof Error ? error.message : String(error),
          treatedAs: false,
        }),
      )
    }
  }

  return {
    allowed: false,
    mode,
    matched: null,
    source: 'default',
    forward: mode === 'dry-run',
    reason:
      'No rule in Khloei computer policy permits that action, so it was refused.',
  }
}
