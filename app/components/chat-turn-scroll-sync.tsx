'use client'

import { useLayoutEffect } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'

export function ChatTurnScrollSync() {
  const { state } = useStickToBottomContext()

  // A new message id remounts this component. Cancel any active animation and
  // place the new turn at its calculated anchor before the browser paints.
  /* eslint-disable react-hooks/immutability -- the library exposes mutable scroll state */
  useLayoutEffect(() => {
    state.animation = undefined
    state.lastTick = undefined
    state.velocity = 0
    state.accumulated = 0
    state.scrollTop = state.calculatedTargetScrollTop
  }, [state])
  /* eslint-enable react-hooks/immutability */

  return null
}
