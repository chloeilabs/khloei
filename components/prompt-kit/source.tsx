'use client'

import { createContext, useContext } from 'react'

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { PromptGlass } from '@/app/components/prompt-glass'
import { cn } from '@/lib/utils'

const SourceContext = createContext<{
  href: string
  domain: string
  faviconHref: string
} | null>(null)

function useSourceContext() {
  const ctx = useContext(SourceContext)
  if (!ctx) throw new Error('Source.* must be used inside <Source>')
  return ctx
}

function sourceFaviconHref(href: string): string {
  try {
    // Only share the origin with the favicon service, never the path or query.
    return new URL(href).origin
  } catch {
    return href
  }
}

export type SourceProps = {
  href: string
  children: React.ReactNode
}

export function Source({ href, children }: SourceProps) {
  let domain = ''
  try {
    domain = new URL(href).hostname
  } catch {
    domain = href.split('/').pop() || href
  }

  return (
    <SourceContext.Provider
      value={{ href, domain, faviconHref: sourceFaviconHref(href) }}
    >
      <HoverCard closeDelay={160} openDelay={0}>
        {children}
      </HoverCard>
    </SourceContext.Provider>
  )
}

export type SourceTriggerProps = {
  label?: string | number
  showFavicon?: boolean
  className?: string
}

export function SourceTrigger({
  label,
  showFavicon = false,
  className,
}: SourceTriggerProps) {
  const { href, domain, faviconHref } = useSourceContext()
  const labelToShow = label ?? domain.replace('www.', '')

  return (
    <HoverCardTrigger asChild>
      <a
        className={cn(
          'inline-flex h-5 max-w-32 items-center gap-1 overflow-hidden rounded-full bg-muted py-0 text-xs text-muted-foreground no-underline transition-colors duration-150 hover:bg-muted-foreground/30 hover:text-primary',
          showFavicon ? 'pr-2 pl-1' : 'px-1',
          className,
        )}
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {showFavicon ? (
          // Favicons are third-party bitmaps; next/image is unnecessary here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt=""
            className="size-3.5 rounded-full"
            height={14}
            src={`https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(
              faviconHref,
            )}`}
            width={14}
          />
        ) : null}
        <span className="truncate text-center font-normal tabular-nums">
          {labelToShow}
        </span>
      </a>
    </HoverCardTrigger>
  )
}

export type SourceContentProps = {
  title: string
  description: string
  className?: string
}

export function SourceContent({
  title,
  description,
  className,
}: SourceContentProps) {
  const { href, domain, faviconHref } = useSourceContext()

  return (
    <HoverCardContent
      className={cn(
        'glass-surface prompt-glass khloei-source-card w-80 border-0 bg-transparent p-0 shadow-none data-[state=closed]:animate-none data-[state=open]:animate-none',
        className,
      )}
    >
      <PromptGlass />
      <a
        className="flex flex-col gap-2 p-3"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        <div className="flex items-center gap-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            className="size-4 rounded-full"
            height={16}
            src={`https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(
              faviconHref,
            )}`}
            width={16}
          />
          <div className="truncate text-sm text-primary">
            {domain.replace('www.', '')}
          </div>
        </div>
        <div className="line-clamp-2 text-sm font-medium">{title}</div>
        <div className="line-clamp-2 text-sm text-muted-foreground">
          {description}
        </div>
      </a>
    </HoverCardContent>
  )
}
