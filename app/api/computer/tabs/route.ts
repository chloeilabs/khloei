import {
  BrowserTabRequestError,
  NavigationRefusedError,
} from '@/app/lib/computer/client'
import {
  changeComputerTab,
  type HumanTabAction,
} from '@/app/lib/computer/surface-client'
import { requireSameOriginRequest } from '@/app/lib/request-origin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function tabAction(value: unknown): HumanTabAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (body.action === 'open') return { action: 'open' }
  if (
    (body.action === 'activate' || body.action === 'close') &&
    typeof body.tabId === 'string'
  ) {
    return { action: body.action, tabId: body.tabId }
  }
  if (body.action === 'navigate' && typeof body.url === 'string') {
    return { action: 'navigate', url: body.url }
  }
  return null
}

export async function POST(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  const input = tabAction(await request.json().catch(() => null))
  if (!input) {
    return Response.json(
      { error: 'A valid tab action is required.' },
      { status: 400 },
    )
  }

  try {
    return Response.json(await changeComputerTab(input), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'That tab action did not work.',
      },
      {
        status:
          error instanceof BrowserTabRequestError
            ? 409
            : error instanceof NavigationRefusedError
              ? 400
              : 503,
      },
    )
  }
}
