import {
  appRequestOrigin,
  createComputerViewerSession,
} from '@/app/lib/computer/surface-client'
import { requireSameOriginRequest } from '@/app/lib/request-origin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  try {
    return Response.json(
      await createComputerViewerSession(appRequestOrigin(request)),
      { headers: { 'Cache-Control': 'no-store' } },
    )
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
