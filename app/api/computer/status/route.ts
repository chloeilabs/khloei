import { getComputerDeploymentStatus } from '@/app/lib/computer/surface-client'
import { requireSameOriginRequest } from '@/app/lib/request-origin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Deployment parity between this app build and the computer image it drives.
 *
 * The two ship on different cadences, so this answers the question an operator
 * actually has after a deploy: is the running computer the one this app was
 * built against, and if not, what specifically is missing. The response carries
 * an HTTP status as well as a body, so a probe that only reads the code still
 * sees skew: 200 aligned, 409 reachable but mismatched, 503 unreachable.
 */
export async function GET(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  const status = await getComputerDeploymentStatus(request.signal)
  const code = !status.computer.reachable ? 503 : status.skew.compatible ? 200 : 409

  return Response.json(status, {
    headers: { 'Cache-Control': 'no-store' },
    status: status.skew.severity === 'aligned' ? 200 : code,
  })
}
