'use client'

import { ChevronRight } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'

import type { ChatActivity, ChatWebSearchAction } from '../lib/chat'

type ActivityPanelProps = {
  activities: ChatActivity[]
  isLive?: boolean
}

type ShimmerTextProps = {
  active?: boolean
  children: string
  className?: string
}

function classNames(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ')
}

function ShimmerText({
  active = false,
  children,
  className,
}: ShimmerTextProps) {
  return (
    <span className={classNames(className, active && 'activity-shimmer')}>
      {children}
    </span>
  )
}

function hostnameFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function isActiveStatus(status: ChatActivity['status']) {
  return status === 'in_progress' || status === 'searching'
}

function formatReasoningSummary(summary: string) {
  return summary
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function latestReasoningHeading(summary: string) {
  const headings: string[] = []
  const boldHeading = /(?:^|\n\n)\s*\*\*(.+?)\*\*/g

  for (const match of summary.matchAll(boldHeading)) {
    const heading = match[1]?.trim()
    if (heading) headings.push(formatReasoningSummary(heading))
  }

  if (headings.length > 0) return headings[headings.length - 1]!

  return (
    formatReasoningSummary(summary)
      .split(/\n+/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

function isWebSearchAction(
  action: ChatActivity['action'],
): action is ChatWebSearchAction {
  return Boolean(
    action &&
      (action.type === 'search' ||
        action.type === 'open_page' ||
        action.type === 'find_in_page'),
  )
}

function computerVerb(action: string) {
  switch (action) {
    case 'computer_navigate':
      return { active: 'Opening', complete: 'Opened', noun: 'open' }
    case 'computer_read':
      return { active: 'Reading', complete: 'Read', noun: 'read' }
    case 'computer_snapshot':
      return { active: 'Inspecting', complete: 'Inspected', noun: 'inspect' }
    case 'computer_click':
      return { active: 'Clicking', complete: 'Clicked', noun: 'click' }
    case 'computer_type':
      return { active: 'Typing in', complete: 'Typed in', noun: 'type in' }
    case 'computer_key':
      return { active: 'Pressing', complete: 'Pressed', noun: 'press' }
    case 'computer_scroll':
      return { active: 'Scrolling', complete: 'Scrolled', noun: 'scroll' }
    case 'computer_list_files':
      return { active: 'Listing', complete: 'Listed', noun: 'list' }
    case 'computer_read_file':
      return { active: 'Reading', complete: 'Read', noun: 'read' }
    case 'computer_write_file':
      return { active: 'Saving', complete: 'Saved', noun: 'save' }
    case 'computer_run_command':
      return { active: 'Running', complete: 'Ran', noun: 'run' }
    default:
      return { active: 'Using', complete: 'Used', noun: 'use' }
  }
}

function computerActivityLabel(activity: ChatActivity) {
  const computer = activity.computer
  if (!computer) return 'Using computer'
  const verb = computerVerb(computer.action)
  const target = computer.target ? ` ${computer.target}` : ''

  if (computer.stage === 'deciding') {
    return `Checking whether to ${verb.noun}${target}`
  }
  if (computer.stage === 'approved') {
    return `Approved · ${verb.active}${target}`
  }
  if (computer.stage === 'refused') {
    return `Refused to ${verb.noun}${target}`
  }
  if (computer.stage === 'failed') {
    return computer.detail
      ? `${verb.complete}${target} · ${computer.detail}`
      : `Could not ${verb.noun}${target}`
  }
  return `${verb.complete}${target}`
}

function activityLabel(activity: ChatActivity) {
  if (activity.kind === 'reasoning') {
    const summary = activity.summary?.trim()
    if (summary) return formatReasoningSummary(summary)
    return isActiveStatus(activity.status) ? 'Thinking' : 'Thought'
  }

  if (activity.kind === 'computer') return computerActivityLabel(activity)

  const action = isWebSearchAction(activity.action) ? activity.action : undefined
  if (!action) {
    if (activity.status === 'failed') return 'Could not search the web'
    return activity.status === 'completed'
      ? 'Searched the web'
      : 'Searching the web'
  }

  if (action.type === 'search') {
    const query = action.queries?.[0] ?? action.query
    if (activity.status === 'failed') {
      return query ? `Could not search for “${query}”` : 'Could not search the web'
    }
    if (activity.status === 'completed') {
      return query ? `Searched “${query}”` : 'Searched the web'
    }
    return query ? `Searching “${query}”` : 'Searching the web'
  }

  if (action.type === 'open_page') {
    const host = action.url ? hostnameFromUrl(action.url) : null
    if (activity.status === 'failed') {
      return host ? `Could not open ${host}` : 'Could not open a page'
    }
    if (activity.status === 'completed') {
      return host ? `Opened ${host}` : 'Opened a page'
    }
    return host ? `Opening ${host}` : 'Opening a page'
  }

  const host = hostnameFromUrl(action.url)
  if (activity.status === 'failed') {
    return `Could not find “${action.pattern}” on ${host}`
  }
  if (activity.status === 'completed') {
    return `Found “${action.pattern}” on ${host}`
  }
  return `Looking for “${action.pattern}” on ${host}`
}

function hasActionDetail(activity: ChatActivity) {
  if (activity.kind === 'computer') {
    return Boolean(activity.computer?.target || activity.computer?.detail)
  }
  const action = activity.action
  if (!isWebSearchAction(action)) return false
  if (action.type === 'search') return Boolean(action.queries?.[0] ?? action.query)
  if (action.type === 'open_page') return Boolean(action.url)
  return Boolean(action.pattern && action.url)
}

function hasSpecificCollapsedDetail(activity: ChatActivity) {
  if (activity.kind === 'reasoning') return Boolean(activity.summary?.trim())
  if (activity.kind === 'computer') return Boolean(activity.computer)
  return hasActionDetail(activity)
}

function shouldShowExpandedActivity(activity: ChatActivity, isLive: boolean) {
  if (activity.kind !== 'reasoning') return true
  if (activity.summary?.trim()) return true
  return isLive && isActiveStatus(activity.status)
}

function collapsedActivityLabel(activity: ChatActivity) {
  if (activity.kind === 'computer') return computerActivityLabel(activity)
  if (activity.kind !== 'reasoning') return activityLabel(activity)

  const summary = activity.summary?.trim()
  if (!summary) return isActiveStatus(activity.status) ? 'Thinking' : 'Thought'

  return (
    latestReasoningHeading(summary) ??
    (isActiveStatus(activity.status) ? 'Thinking' : 'Thought')
  )
}

function formatThoughtDuration(ms: number) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

function liveSummaryLabel(activities: ChatActivity[]) {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!
    if (hasSpecificCollapsedDetail(activity)) {
      return collapsedActivityLabel(activity)
    }
  }

  const latest = activities.at(-1)
  return latest ? collapsedActivityLabel(latest) : 'Thinking'
}

function summaryLabel(
  activities: ChatActivity[],
  isLive: boolean,
  durationMs: number | null,
) {
  if (!isLive && durationMs !== null) {
    return `Thought for ${formatThoughtDuration(durationMs)}`
  }
  return liveSummaryLabel(activities)
}

function panelOrbState(activities: ChatActivity[], isLive: boolean): OrbState {
  const hasActiveSearch = activities.some(
    (activity) =>
      activity.kind === 'web_search' && isActiveStatus(activity.status),
  )
  const hasActiveReasoning = activities.some(
    (activity) =>
      activity.kind === 'reasoning' && isActiveStatus(activity.status),
  )
  const hasSearch = activities.some(
    (activity) => activity.kind === 'web_search',
  )
  const hasComputer = activities.some(
    (activity) => activity.kind === 'computer',
  )

  if (isLive && hasActiveSearch) return 'searching'
  if (isLive && hasActiveReasoning) return 'composing'
  return hasSearch && !hasComputer ? 'searching' : 'composing'
}

export const ActivityPanel = memo(function ActivityPanel({
  activities,
  isLive = false,
}: ActivityPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const startedAtRef = useRef<number | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const hasActive = activities.some((activity) =>
    isActiveStatus(activity.status),
  )

  useEffect(() => {
    if (activities.length === 0) return

    if (startedAtRef.current === null) {
      startedAtRef.current = performance.now()
    }
    if (!hasActive) {
      setDurationMs(performance.now() - startedAtRef.current)
    }
  }, [activities, hasActive])

  if (activities.length === 0) return null

  const label = summaryLabel(activities, isLive, durationMs)
  const showPulse = isLive && hasActive
  const showShimmer = isLive && hasActive
  const orbState = panelOrbState(activities, isLive)

  return (
    <div className="activity-panel">
      <button
        aria-expanded={isOpen}
        className="activity-trigger"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <ThinkingOrb
          aria-label={orbState === 'searching' ? 'Searching' : 'Thinking'}
          className="activity-orb"
          paused={!showPulse}
          size={20}
          state={orbState}
        />
        <ShimmerText
          active={showShimmer}
          className={classNames(
            'activity-label',
            !showShimmer && 'activity-label-muted',
          )}
        >
          {label}
        </ShimmerText>
        <ChevronRight
          aria-hidden
          className={classNames(
            'activity-chevron',
            isOpen && 'activity-chevron-open',
          )}
          size={14}
        />
      </button>

      {isOpen ? (
        <ul className="activity-details">
          {activities
            .filter((activity) => shouldShowExpandedActivity(activity, isLive))
            .map((activity) => {
              const detail = activityLabel(activity)
              const isActive = isActiveStatus(activity.status)
              const isReasoning = activity.kind === 'reasoning'
              const shimmerActive = isActive && isLive

              return (
                <li className="activity-detail" key={activity.id}>
                  <ShimmerText
                    active={shimmerActive}
                    className={classNames(
                      'activity-detail-text',
                      isReasoning && 'activity-detail-reasoning',
                      !shimmerActive && 'activity-label-muted',
                    )}
                  >
                    {detail}
                  </ShimmerText>
                </li>
              )
            })}
        </ul>
      ) : null}
    </div>
  )
})
