'use client'

import {
  Check,
  Copy,
  CornerDownRight,
  FileText,
  Image as ImageIcon,
  RefreshCcw,
} from 'lucide-react'
import Link from 'next/link'
import {
  isValidElement,
  memo,
  type ComponentProps,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { ThinkingOrb } from 'thinking-orbs'

import {
  Source,
  SourceContent,
  SourceTrigger,
} from '@/components/prompt-kit/source'

import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard'
import type {
  ChatFollowUpQuestion,
  ChatMessage as ChatMessageValue,
} from '../lib/chat'
import { ActivityPanel } from './activity-panel'
import { ComputerFrame } from './computer-frame'
import { PromptGlass } from './prompt-glass'
import { ZoomImage } from './zoom-image'

type MarkdownAnchorProps = ComponentProps<'a'> & {
  node?: unknown
}

type MarkdownTableProps = ComponentProps<'table'> & {
  node?: unknown
}

type MarkdownImageProps = ComponentProps<'img'> & {
  node?: unknown
}

function classNames(...names: Array<string | undefined>) {
  return names.filter(Boolean).join(' ')
}

function isInternalPath(href: string | undefined): href is string {
  return Boolean(href?.startsWith('/') && !href.startsWith('//'))
}

function isHttpUrl(href: string | undefined): href is string {
  if (!href) return false
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function getTextContent(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getTextContent).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getTextContent(node.props.children)
  }
  return ''
}

function sourceDomain(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return href
  }
}

function sourceDescription(href: string): string {
  try {
    const url = new URL(href)
    url.searchParams.delete('utm_source')
    url.searchParams.delete('utm_medium')
    url.searchParams.delete('utm_campaign')
    const path = `${url.pathname}${url.search}${url.hash}`
    return path && path !== '/' ? `${url.hostname}${path}` : url.hostname
  } catch {
    return href
  }
}

function MarkdownLink({
  href,
  children,
  className,
  title,
  node: _node,
  ...props
}: MarkdownAnchorProps) {
  void _node

  if (isInternalPath(href)) {
    return (
      <Link className={classNames('wrap-anywhere', className)} href={href}>
        {children}
      </Link>
    )
  }

  if (isHttpUrl(href)) {
    const label = getTextContent(children).replace(/\s+/g, ' ').trim()
    const domain = sourceDomain(href)
    const pageTitle = title?.replace(/\s+/g, ' ').trim()
    const contentTitle = pageTitle || label || domain
    const description = sourceDescription(href)

    return (
      <Source href={href}>
        <SourceTrigger
          className="align-text-bottom"
          label={label || domain}
          showFavicon
        />
        <SourceContent description={description} title={contentTitle} />
      </Source>
    )
  }

  return (
    <a
      {...props}
      className={classNames('wrap-anywhere', className)}
      href={href}
      rel="noreferrer"
      target="_blank"
      title={title}
    >
      {children}
    </a>
  )
}

function MarkdownTable({ children, node: _node, ...props }: MarkdownTableProps) {
  void _node
  return (
    <div className="chat-table-scroll">
      <table {...props}>{children}</table>
    </div>
  )
}

function imageDimension(value: number | string | undefined) {
  if (typeof value === 'number') return value
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function MarkdownImage({
  alt = '',
  className,
  height,
  node: _node,
  src,
  style,
  width,
}: MarkdownImageProps) {
  void _node
  if (typeof src !== 'string' || !src) return null

  return (
    <ZoomImage
      alt={alt}
      className={classNames('chat-message-image', className)}
      height={imageDimension(height)}
      src={src}
      style={style}
      width={imageDimension(width)}
    />
  )
}

const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
  table: MarkdownTable,
}

function FollowUpQuestions({
  onSelect,
  questions,
}: {
  onSelect: (question: string) => void
  questions: ChatFollowUpQuestion[]
}) {
  if (questions.length === 0) return null

  return (
    <div
      aria-label="Follow-up questions"
      className="chat-follow-ups"
      role="group"
    >
      {questions.map((question) => (
        <button
          className="chat-follow-up"
          key={question.id}
          onClick={() => onSelect(question.text)}
          type="button"
        >
          <CornerDownRight aria-hidden className="chat-follow-up-icon" />
          <span className="chat-follow-up-text">{question.text}</span>
        </button>
      ))}
    </div>
  )
}

function FollowUpQuestionsPending() {
  return (
    <div
      aria-busy="true"
      aria-label="Follow-up questions"
      className="chat-follow-ups"
      role="group"
    >
      {['18rem', '16rem', '20rem'].map((width) => (
        <div
          className="chat-follow-up chat-follow-up-pending"
          key={width}
        >
          <CornerDownRight aria-hidden className="chat-follow-up-icon" />
          <span className="chat-follow-up-skeleton" style={{ width }} />
        </div>
      ))}
    </div>
  )
}

export const ChatMessage = memo(function ChatMessage({
  computerInteractive,
  message,
  onFollowUpQuestionClick,
  onRegenerate,
}: {
  computerInteractive?: boolean
  message: ChatMessageValue
  onFollowUpQuestionClick?: (question: string) => void
  onRegenerate?: (assistantMessageId: string) => void
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard()

  if (message.role === 'user') {
    const imageAttachments = (message.attachments ?? []).flatMap(
      (attachment) =>
        attachment.kind === 'image' && attachment.url
          ? [{ ...attachment, url: attachment.url }]
          : [],
    )
    const bubbleAttachments = (message.attachments ?? []).filter(
      (attachment) => !(attachment.kind === 'image' && attachment.url),
    )
    const hasBubble = Boolean(message.content || bubbleAttachments.length)

    return (
      <article
        aria-label="You"
        className="chat-message chat-message-user"
        data-message-role="user"
      >
        <div className="chat-user-turn">
          {imageAttachments.length ? (
            <div className="chat-message-images chat-user-images">
              {imageAttachments.map((attachment, index) => (
                <ZoomImage
                  alt={`Attachment ${index + 1}`}
                  className="chat-message-image"
                  key={`${message.id}-${attachment.url}`}
                  src={attachment.url}
                />
              ))}
            </div>
          ) : null}

          {hasBubble ? (
            <div className="glass-surface prompt-glass chat-user-bubble">
              <PromptGlass />
              {message.content ? (
                <div className="chat-user-text">{message.content}</div>
              ) : null}
              {bubbleAttachments.length ? (
                <div className="chat-user-attachments">
                  {bubbleAttachments.map((attachment, index) => (
                    <span
                      className="chat-user-attachment"
                      key={`${attachment.name}-${index}`}
                    >
                      {attachment.kind === 'image' ? (
                        <ImageIcon aria-hidden size={13} strokeWidth={1.75} />
                      ) : (
                        <FileText aria-hidden size={13} strokeWidth={1.75} />
                      )}
                      <span>{attachment.name}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    )
  }

  const hasContent = message.content.trim().length > 0
  const activities = message.activities ?? []
  const hasActivities = activities.length > 0
  const isLive = message.status === 'streaming'
  const followUpQuestions = isLive ? [] : (message.followUpQuestions ?? [])
  const followUpQuestionsPending =
    !isLive &&
    message.followUpQuestionsPending === true &&
    followUpQuestions.length === 0

  return (
    <article
      aria-busy={isLive}
      aria-label="Khloei"
      className="chat-message chat-message-assistant"
      data-message-role="assistant"
      data-streaming={isLive || undefined}
    >
      {hasActivities ? (
        <ActivityPanel activities={activities} isLive={isLive} />
      ) : null}

      {message.computerFrame ? (
        <ComputerFrame
          frame={message.computerFrame}
          interactive={computerInteractive}
        />
      ) : null}

      {hasContent ? (
        <div className="chat-markdown">
          <ReactMarkdown
            components={MARKDOWN_COMPONENTS}
            rehypePlugins={[rehypeHighlight]}
            remarkPlugins={[remarkGfm]}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      ) : isLive && !hasActivities ? (
        <ThinkingOrb
          aria-label="Khloei is thinking"
          className="chat-thinking-orb"
          size={20}
          state="listening"
        />
      ) : null}

      {message.status === 'stopped' ? (
        <div className="chat-message-state">Stopped</div>
      ) : null}

      {hasContent && !isLive ? (
        <div className="chat-message-actions">
          <button
            aria-label={isCopied ? 'Response copied' : 'Copy response'}
            className="chat-message-action"
            onClick={() => {
              void copyToClipboard(message.content)
            }}
            title="Copy response"
            type="button"
          >
            {isCopied ? (
              <Check aria-hidden size={14} />
            ) : (
              <Copy aria-hidden size={14} />
            )}
          </button>
          {onRegenerate ? (
            <button
              aria-label="Regenerate response"
              className="chat-message-action"
              onClick={() => onRegenerate(message.id)}
              title="Regenerate response"
              type="button"
            >
              <RefreshCcw aria-hidden size={14} />
            </button>
          ) : null}
        </div>
      ) : null}

      {hasContent && !isLive && onFollowUpQuestionClick ? (
        followUpQuestionsPending ? (
          <FollowUpQuestionsPending />
        ) : (
          <FollowUpQuestions
            onSelect={onFollowUpQuestionClick}
            questions={followUpQuestions}
          />
        )
      ) : null}
    </article>
  )
})
