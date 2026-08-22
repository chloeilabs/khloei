export const STREAMING_SCROLL_EARLY_TRIGGER_PX = 72
export const STREAMING_SCROLL_PROMPT_BUFFER_PX = 32

export type ChatTurnMessage = {
  id: string
  role: 'assistant' | 'user'
}

export type ThreadScrollTopInput = {
  currentScrollTop: number
  isActiveTurnInProgress: boolean
  latestAnchorTop: number
  latestTurnId: string | null
  latestVisibleTurnBoundary: number
  overflowPinnedTurnId: string | null
  promptClearance: number
  scrollViewportHeight: number
  scrollViewportTop: number
  targetScrollTop: number
}

export type ThreadScrollTopResult = {
  overflowPinnedTurnId: string | null
  scrollTop: number
}

export function groupChatTurns<T extends ChatTurnMessage>(messages: T[]): T[][] {
  const groups: T[][] = []

  for (const message of messages) {
    if (message.role === 'user') {
      groups.push([message])
      continue
    }

    const lastGroup = groups[groups.length - 1]
    if (lastGroup?.[0]?.role === 'user') {
      lastGroup.push(message)
      continue
    }

    groups.push([message])
  }

  return groups
}

export function scrollTopToPlaceAtViewport(
  elementTop: number,
  viewportTop: number,
  currentScrollTop: number,
) {
  return Math.max(0, elementTop - viewportTop + currentScrollTop)
}

export function resolveThreadScrollTop(
  input: ThreadScrollTopInput,
): ThreadScrollTopResult {
  const anchoredTarget = scrollTopToPlaceAtViewport(
    input.latestAnchorTop,
    input.scrollViewportTop,
    input.currentScrollTop,
  )
  const earlyTriggerOffset = Math.max(
    STREAMING_SCROLL_EARLY_TRIGGER_PX,
    input.promptClearance + STREAMING_SCROLL_PROMPT_BUFFER_PX,
  )
  const latestTurnNearPrompt =
    input.scrollViewportHeight > 0 &&
    input.latestVisibleTurnBoundary >
      input.scrollViewportHeight - earlyTriggerOffset

  let overflowPinnedTurnId = input.overflowPinnedTurnId

  // Regeneration reuses the user turn while replacing a potentially tall
  // response. Clear its old overflow pin when the replacement is short again.
  if (overflowPinnedTurnId === input.latestTurnId && !latestTurnNearPrompt) {
    overflowPinnedTurnId = null
  }
  if (input.isActiveTurnInProgress && latestTurnNearPrompt && input.latestTurnId) {
    overflowPinnedTurnId = input.latestTurnId
  }

  if (
    latestTurnNearPrompt &&
    input.latestTurnId !== null &&
    (input.isActiveTurnInProgress ||
      input.overflowPinnedTurnId === input.latestTurnId)
  ) {
    return {
      overflowPinnedTurnId,
      scrollTop: input.targetScrollTop,
    }
  }

  return {
    overflowPinnedTurnId,
    scrollTop: anchoredTarget,
  }
}

export function readLatestTurnScrollMetrics(
  contentElement: HTMLElement,
  scrollElement: HTMLElement,
  promptElement: HTMLElement | null,
) {
  const turnGroups = contentElement.querySelectorAll<HTMLElement>(
    '[data-message-group="turn"]',
  )
  const latestTurnGroup = turnGroups[turnGroups.length - 1]
  if (!latestTurnGroup) return null

  const latestVisibleTurnElement =
    latestTurnGroup.lastElementChild instanceof HTMLElement
      ? latestTurnGroup.lastElementChild
      : latestTurnGroup
  const latestTurnBox = latestTurnGroup.getBoundingClientRect()
  const scrollBox = scrollElement.getBoundingClientRect()
  const promptClearance = promptElement
    ? Math.max(0, scrollBox.bottom - promptElement.getBoundingClientRect().top)
    : 0

  return {
    currentScrollTop: scrollElement.scrollTop,
    latestAnchorTop: latestTurnBox.top,
    latestTurnId: latestTurnGroup.dataset.userMessageId || null,
    latestVisibleTurnBoundary:
      latestVisibleTurnElement.getBoundingClientRect().bottom - latestTurnBox.top,
    promptClearance,
    scrollViewportHeight: scrollBox.height,
    scrollViewportTop: scrollBox.top,
  }
}
