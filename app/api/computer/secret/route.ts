import {
  supplyComputerSecret,
} from '@/app/lib/computer/surface-client'
import { requireSameOriginRequest } from '@/app/lib/request-origin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  const body = (await request.json().catch(() => null)) as {
    text?: unknown
  } | null
  if (typeof body?.text !== 'string' || !body.text) {
    return Response.json({ error: 'Enter a value first.' }, { status: 400 })
  }
  try {
    return Response.json(await supplyComputerSecret(body.text), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'The value could not be supplied.',
      },
      { status: 502 },
    )
  }
}
