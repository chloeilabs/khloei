import {
  getComputerControl,
  setComputerControl,
} from '@/app/lib/computer/surface-client'
import { requireSameOriginRequest } from '@/app/lib/request-origin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    return Response.json(await getComputerControl(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Khloei's computer is unavailable.",
      },
      { status: 503 },
    )
  }
}

export async function POST(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  const body = (await request.json().catch(() => null)) as {
    action?: unknown
  } | null
  if (body?.action !== 'take' && body?.action !== 'release') {
    return Response.json({ error: 'Choose take or release.' }, { status: 400 })
  }
  try {
    return Response.json(await setComputerControl(body.action), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Khloei's computer is unavailable.",
      },
      { status: 503 },
    )
  }
}
