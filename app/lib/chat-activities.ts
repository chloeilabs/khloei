import type { ChatActivity } from './chat'

export function upsertChatActivity(
  activities: ChatActivity[] | undefined,
  next: ChatActivity,
): ChatActivity[] {
  const current = activities ?? []
  const index = current.findIndex((activity) => activity.id === next.id)
  if (index === -1) return [...current, next]

  const previous = current[index]!
  const merged: ChatActivity = { ...previous, ...next }
  if (next.action === undefined && previous.action !== undefined) {
    merged.action = previous.action
  }
  if (next.summary === undefined && previous.summary !== undefined) {
    merged.summary = previous.summary
  }

  return [...current.slice(0, index), merged, ...current.slice(index + 1)]
}

export function failActiveChatActivities(
  activities: ChatActivity[] | undefined,
): ChatActivity[] | undefined {
  return activities?.map((activity) =>
    activity.status === 'in_progress' || activity.status === 'searching'
      ? { ...activity, status: 'failed' }
      : activity,
  )
}
