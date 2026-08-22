'use client'

import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react'

import {
  readLatestTurnScrollMetrics,
  resolveThreadScrollTop,
} from '../lib/chat-thread-anchor'

export function useChatThreadScroll(
  isActiveTurnInProgress: boolean,
  hasMessages: boolean,
  promptElementRef: RefObject<HTMLElement | null>,
) {
  const overflowPinnedTurnIdRef = useRef<string | null>(null)
  const isActiveTurnInProgressRef = useRef(isActiveTurnInProgress)

  // The scroll library keeps its first target callback. Keep live stream state
  // in a ref and synchronize it before layout effects run for a new token.
  useInsertionEffect(() => {
    isActiveTurnInProgressRef.current = isActiveTurnInProgress
  })

  useEffect(() => {
    if (!hasMessages) overflowPinnedTurnIdRef.current = null
  }, [hasMessages])

  useEffect(
    () => () => {
      document.documentElement.style.removeProperty('--khloei-prompt-height')
    },
    [],
  )

  useLayoutEffect(() => {
    const promptShell = promptElementRef.current
    if (!promptShell) return

    const root = document.documentElement
    const updatePromptHeight = () => {
      const promptForm =
        promptShell.querySelector<HTMLElement>('form.prompt-input')
      if (!promptForm) return

      root.style.setProperty(
        '--khloei-prompt-height',
        `${promptForm.getBoundingClientRect().height}px`,
      )
    }

    updatePromptHeight()
    const observer = new ResizeObserver(updatePromptHeight)
    observer.observe(promptShell, { box: 'border-box' })

    return () => observer.disconnect()
  }, [hasMessages, promptElementRef])

  return useCallback(
    (
      targetScrollTop: number,
      {
        contentElement,
        scrollElement,
      }: {
        contentElement: HTMLElement
        scrollElement: HTMLElement
      },
    ) => {
      const metrics = readLatestTurnScrollMetrics(
        contentElement,
        scrollElement,
        promptElementRef.current,
      )
      if (!metrics) return targetScrollTop

      const result = resolveThreadScrollTop({
        ...metrics,
        isActiveTurnInProgress: isActiveTurnInProgressRef.current,
        overflowPinnedTurnId: overflowPinnedTurnIdRef.current,
        targetScrollTop,
      })
      overflowPinnedTurnIdRef.current = result.overflowPinnedTurnId
      return result.scrollTop
    },
    [promptElementRef],
  )
}
