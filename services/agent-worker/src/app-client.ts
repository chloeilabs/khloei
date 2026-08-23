import type {
  ComputerToolInvocation,
  WorkerActionResponse,
} from './types'

type AppOperation =
  | 'assistance_status'
  | 'begin_assistance'
  | 'cancel_assistance'
  | 'tool'

function appConfiguration() {
  const rawUrl = process.env.KHLOEI_APP_URL?.trim()
  const protectionBypass =
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
  const dedicated = process.env.KHLOEI_AGENT_WORKER_TOKEN?.trim()
  const localDevelopment =
    !process.env.RAILWAY_ENVIRONMENT_ID &&
    process.env.NODE_ENV !== 'production'
  const token =
    dedicated ||
    (localDevelopment ? process.env.COMPUTER_TOKEN?.trim() : undefined)
  if (!rawUrl) throw new Error('KHLOEI_APP_URL is not configured.')
  if (!token) throw new Error('KHLOEI_AGENT_WORKER_TOKEN is not configured.')
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('KHLOEI_APP_URL must be an http or https URL.')
  }
  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    protectionBypass,
    token,
  }
}

export class KhloeiAppClient {
  async operation(
    operation: AppOperation,
    taskId: string,
    invocation: ComputerToolInvocation,
    gatewayState: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): Promise<WorkerActionResponse> {
    const { baseUrl, protectionBypass, token } = appConfiguration()
    const response = await fetch(`${baseUrl}/api/internal/computer`, {
      body: JSON.stringify({
        ...(gatewayState ? { gatewayState } : {}),
        invocation,
        operation,
        taskId,
      }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(protectionBypass
          ? { 'x-vercel-protection-bypass': protectionBypass }
          : {}),
      },
      method: 'POST',
      signal,
    })
    const body = (await response.json().catch(() => null)) as
      | (WorkerActionResponse & { error?: unknown })
      | null
    if (!response.ok) {
      throw new Error(
        body && typeof body.error === 'string'
          ? body.error
          : 'The Khloei app rejected the computer action.',
      )
    }
    if (!body || !Array.isArray(body.events) || !body.gatewayState) {
      throw new Error('The Khloei app returned an invalid computer action result.')
    }
    return body
  }
}
