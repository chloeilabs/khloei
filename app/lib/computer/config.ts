/** Whether local development may navigate to services on its own private network. */
export function privateHostsAllowed(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const requested =
    environment.KHLOEI_COMPUTER_ALLOW_PRIVATE_HOSTS?.trim() === 'true'
  if (!requested) return false

  if (environment.NODE_ENV?.trim() === 'production') {
    throw new Error(
      'KHLOEI_COMPUTER_ALLOW_PRIVATE_HOSTS=true is for local development only. Remove it from the production environment.',
    )
  }

  return true
}
