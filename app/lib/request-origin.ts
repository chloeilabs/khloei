/**
 * Reject browser mutations whose provenance cannot be tied to this Khloei app.
 * This is request hardening only; it does not identify or authenticate a user.
 */
export function requireSameOriginRequest(request: Request) {
  const origin = request.headers.get('origin')
  const requestOrigin = (() => {
    try {
      return new URL(request.url).origin
    } catch {
      return null
    }
  })()

  if (
    !origin ||
    !requestOrigin ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    origin !== requestOrigin
  ) {
    return Response.json(
      { error: 'Cross-origin requests are not allowed.' },
      { headers: { 'Cache-Control': 'no-store' }, status: 403 },
    )
  }

  return null
}
