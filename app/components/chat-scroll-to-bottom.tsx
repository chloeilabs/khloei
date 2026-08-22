'use client'

import { ArrowDown } from 'lucide-react'
import { useCallback, useRef } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'

import { PromptGlass } from './prompt-glass'

export function ChatScrollToBottom() {
  const stickToBottom = useStickToBottomContext()
  const manualScrollInFlightRef = useRef(false)
  const { isAtBottom } = stickToBottom

  // Temporarily bypass the turn anchor when the user explicitly asks for the
  // true bottom of the conversation.
  // eslint-disable-next-line react-hooks/immutability -- library override point
  const handleScrollToBottom = useCallback(async () => {
    if (manualScrollInFlightRef.current) return

    manualScrollInFlightRef.current = true
    const previousTargetScrollTop = stickToBottom.targetScrollTop
    // eslint-disable-next-line react-hooks/immutability -- library override point
    stickToBottom.targetScrollTop = (targetScrollTop) => targetScrollTop

    try {
      await stickToBottom.scrollToBottom()
    } finally {
      stickToBottom.targetScrollTop = previousTargetScrollTop
      manualScrollInFlightRef.current = false
    }
  }, [stickToBottom])

  return (
    <button
      aria-hidden={isAtBottom || undefined}
      aria-label="Scroll to bottom"
      className="glass-surface prompt-glass chat-scroll-to-bottom"
      data-hidden={isAtBottom || undefined}
      disabled={isAtBottom}
      onClick={() => {
        void handleScrollToBottom()
      }}
      tabIndex={isAtBottom ? -1 : 0}
      type="button"
    >
      <PromptGlass />
      <ArrowDown aria-hidden size={14} />
    </button>
  )
}
