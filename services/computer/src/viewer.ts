/**
 * Return whether a socket still owns the live screen.
 *
 * Viewer reconnects are make-before-break: the new socket replaces the old one, then the old
 * socket closes. Only the current socket may stop or drive the replacement cast.
 */
export function isCurrentViewer(
  current: unknown,
  socket: unknown,
): boolean {
  return current === socket;
}
