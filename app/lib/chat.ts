export type ChatSource = {
  title: string
  url: string
}

export type ChatAttachment = {
  kind: 'file' | 'image'
  name: string
  url?: string
}

export type ChatFollowUpQuestion = {
  id: string
  text: string
}

export type ChatWebSearchAction =
  | {
      queries?: string[]
      query?: string
      type: 'search'
    }
  | {
      type: 'open_page'
      url?: string | null
    }
  | {
      pattern: string
      type: 'find_in_page'
      url: string
    }

export type ChatActivityStatus =
  | 'in_progress'
  | 'searching'
  | 'completed'
  | 'failed'

export type ChatActivity = {
  action?: ChatWebSearchAction
  id: string
  kind: 'reasoning' | 'web_search'
  status: ChatActivityStatus
  summary?: string
}

export type ChatMessage = {
  activities?: ChatActivity[]
  attachments?: ChatAttachment[]
  content: string
  followUpQuestions?: ChatFollowUpQuestion[]
  followUpQuestionsPending?: boolean
  id: string
  responseId?: string
  role: 'assistant' | 'user'
  sources?: ChatSource[]
  status?: 'complete' | 'error' | 'stopped' | 'streaming'
}

export type ChatStreamEvent =
  | { activity: ChatActivity; type: 'activity' }
  | {
      responseId: string
      resumeToken: string
      sequenceNumber: number
      type: 'background'
    }
  | { sequenceNumber: number; type: 'cursor' }
  | { delta: string; type: 'text-delta' }
  | {
      content: string
      responseId: string
      sources: ChatSource[]
      type: 'message'
    }
  | { type: 'cancelled' }
  | { message: string; type: 'error' }
  | { type: 'reconnect' }
  | { type: 'done' }
