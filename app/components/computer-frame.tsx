'use client'

import {
  ArrowRight,
  Eye,
  Globe2,
  Hand,
  KeyRound,
  Maximize2,
  Minimize2,
  Monitor,
  Plus,
  RotateCcw,
  Unplug,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
  type WheelEvent,
} from 'react'
import { createPortal } from 'react-dom'

import type { ChatComputerFrame } from '../lib/chat'
import type { ComputerTab, TabsResult } from '../lib/computer/schema'
import type { ComputerControlState } from '../lib/computer/surface-client'
import { PromptGlass } from './prompt-glass'

type LiveFrame = ChatComputerFrame & { url?: string }
type ConnectionState = 'connecting' | 'live' | 'offline'
type ComputerSurface = 'browser' | 'desktop'
type StreamMessage =
  | { data: string; height: number; type: 'frame'; url?: string; width: number }
  | { control: ComputerControlState; type: 'control' }
  | ({ type: 'tabs' } & TabsResult)
  | {
      height?: number
      label: string
      surface: ComputerSurface
      type: 'surface'
      width?: number
    }
  | { error: string; type: 'error' }

type HumanTabAction =
  | { action: 'open' }
  | { action: 'activate' | 'close'; tabId: string }
  | { action: 'navigate'; url: string }

const FRAME_STATE_SYNC_INTERVAL_MS = 1_000

function frameLocation(value: string | undefined) {
  if (!value) return 'Browser'
  try {
    const url = new URL(value)
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return value
  }
}

function tabLabel(tab: ComputerTab) {
  if (tab.title.trim()) return tab.title.trim()
  if (!tab.url || tab.url === 'about:blank') return 'New tab'
  return frameLocation(tab.url)
}

function tabAddress(value: string | undefined) {
  return value && value !== 'about:blank' ? value : ''
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null
  if (!response.ok) {
    throw new Error(body?.error || "Khloei's computer is unavailable.")
  }
  return body as T
}

function modifiers(event: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}) {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  )
}

function pointerButton(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'left'
}

function ComputerScreenImage({
  alt,
  imageRef,
  src,
}: {
  alt: string
  imageRef: Ref<HTMLImageElement>
  src?: string
}) {
  // A historical frame whose bytes have been swept by screenshot retention has
  // no source. Rendering an empty src would show a broken image, so the slot
  // keeps its geometry and says what happened. A live socket replaces this as
  // soon as the first frame arrives.
  if (!src) {
    return (
      <div className="computer-frame-image computer-frame-image-expired">
        <span>This screenshot is past its retention window.</span>
      </div>
    )
  }
  return (
    // Dynamic screencast frames intentionally bypass image optimization.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt}
      className="computer-frame-image"
      draggable={false}
      ref={imageRef}
      src={src}
    />
  )
}

export function ComputerFrame({
  frame,
  interactive = false,
}: {
  frame: ChatComputerFrame
  interactive?: boolean
}) {
  const [streamFrame, setStreamFrame] = useState<LiveFrame>(frame)
  const [connection, setConnection] =
    useState<ConnectionState>('connecting')
  const [control, setControl] = useState<ComputerControlState | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [surface, setSurface] = useState<ComputerSurface>('browser')
  const [surfaceLabel, setSurfaceLabel] = useState('Khloei browser')
  const [tabsState, setTabsState] = useState<TabsResult | null>(null)
  const [tabBusy, setTabBusy] = useState(false)
  const streamFrameRef = useRef<LiveFrame>(frame)
  const screenImageRef = useRef<HTMLImageElement>(null)
  const lastFrameStateSyncRef = useRef(0)
  const socketRef = useRef<WebSocket | null>(null)
  const binaryFrameUrlRef = useRef<string | null>(null)
  const controlRef = useRef<ComputerControlState | null>(null)
  const frameRef = useRef<HTMLElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const expandButtonRef = useRef<HTMLButtonElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const secretRef = useRef<HTMLInputElement>(null)
  const moveFrameRef = useRef<number | null>(null)
  const pendingMoveRef = useRef<Record<string, unknown> | null>(null)
  const isExpanded = expanded && interactive

  useEffect(() => {
    controlRef.current = control
  }, [control])

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current
    if (
      controlRef.current?.holder !== 'human' ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return
    }
    socket.send(JSON.stringify(message))
  }, [])

  const applyTabs = useCallback((next: TabsResult) => {
    setTabsState(next)
    const active = next.tabs.find((tab) => tab.id === next.activeTabId)
    const input = addressRef.current
    if (input && document.activeElement !== input) {
      input.value = tabAddress(active?.url)
    }
  }, [])

  const releaseIfHeld = useCallback(() => {
    const current = controlRef.current
    if (current?.holder !== 'human') return
    const released: ComputerControlState = {
      ...current,
      holder: 'bot',
      reason: undefined,
      requested: false,
      requestedAt: undefined,
      secretWanted: undefined,
    }
    controlRef.current = released
    setControl(released)
    void fetch('/api/computer/control', {
      body: JSON.stringify({ action: 'release' }),
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      method: 'POST',
    }).catch(() => undefined)
  }, [])

  const collapse = useCallback(() => {
    releaseIfHeld()
    setExpanded(false)
  }, [releaseIfHeld])

  const restoreExpandFocus = useCallback(() => {
    requestAnimationFrame(() =>
      expandButtonRef.current?.focus({ preventScroll: true }),
    )
  }, [])

  useEffect(() => {
    if (!isExpanded) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    expandButtonRef.current?.focus({ preventScroll: true })

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        collapse()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(
        frameRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable.at(-1)
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !frameRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault()
        last?.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !frameRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown, true)
      restoreExpandFocus()
    }
  }, [collapse, isExpanded, restoreExpandFocus])

  useEffect(() => {
    if (!interactive) return

    let active = true
    let attempt = 0
    let reconnectTimer: number | undefined
    let socket: WebSocket | undefined
    let sessionController: AbortController | undefined

    const connect = async () => {
      setConnection('connecting')
      const controller = new AbortController()
      sessionController = controller
      const sessionTimeout = window.setTimeout(() => controller.abort(), 20_000)
      try {
        const session = await responseJson<{ streamUrl: string }>(
          await fetch('/api/computer/session', {
            method: 'POST',
            cache: 'no-store',
            signal: controller.signal,
          }),
        )
        if (!active) return
        socket = new WebSocket(session.streamUrl)
        socket.binaryType = 'arraybuffer'
        socketRef.current = socket
        socket.addEventListener('open', () => {
          if (!active) return
          attempt = 0
          setConnection('live')
          setNotice('')
        })
        socket.addEventListener('message', (event) => {
          if (!active) return
          if (event.data instanceof ArrayBuffer) {
            const nextUrl = URL.createObjectURL(
              new Blob([event.data], { type: 'image/jpeg' }),
            )
            const previousUrl = binaryFrameUrlRef.current
            binaryFrameUrlRef.current = nextUrl
            if (screenImageRef.current) screenImageRef.current.src = nextUrl
            if (previousUrl) URL.revokeObjectURL(previousUrl)
            return
          }
          let message: StreamMessage
          try {
            message = JSON.parse(String(event.data)) as StreamMessage
          } catch {
            return
          }
          if (message.type === 'frame') {
            if (
              !message.data ||
              !Number.isFinite(message.height) ||
              !Number.isFinite(message.width) ||
              message.height <= 0 ||
              message.width <= 0
            ) {
              return
            }
            const current = streamFrameRef.current
            const dataUrl = `data:image/jpeg;base64,${message.data}`
            const next: LiveFrame = {
              ...current,
              dataUrl,
              height: message.height,
              screenshotUnavailable: false,
              url: message.url ?? current.url,
              width: message.width,
            }
            streamFrameRef.current = next
            if (screenImageRef.current) screenImageRef.current.src = dataUrl

            const now = Date.now()
            const metadataChanged =
              current.height !== next.height ||
              current.width !== next.width ||
              current.url !== next.url
            if (
              metadataChanged ||
              now - lastFrameStateSyncRef.current >=
                FRAME_STATE_SYNC_INTERVAL_MS
            ) {
              lastFrameStateSyncRef.current = now
              setStreamFrame(next)
            }
          } else if (message.type === 'control') {
            controlRef.current = message.control
            setControl(message.control)
          } else if (message.type === 'tabs') {
            applyTabs({
              activeTabId: message.activeTabId,
              maxTabs: message.maxTabs,
              tabs: message.tabs,
            })
          } else if (message.type === 'surface') {
            setSurface(message.surface)
            setSurfaceLabel(message.label)
            if (
              Number.isFinite(message.height) &&
              Number.isFinite(message.width) &&
              (message.height ?? 0) > 0 &&
              (message.width ?? 0) > 0
            ) {
              const current = streamFrameRef.current
              const next = {
                ...current,
                height: message.height as number,
                width: message.width as number,
              }
              streamFrameRef.current = next
              setStreamFrame(next)
            }
          } else {
            setNotice(message.error)
          }
        })
        socket.addEventListener('close', () => {
          if (!active) return
          socketRef.current = null
          setConnection('offline')
          const delay = Math.min(1_000 * 2 ** attempt, 8_000)
          attempt += 1
          reconnectTimer = window.setTimeout(() => void connect(), delay)
        })
      } catch (error) {
        if (!active) return
        setConnection('offline')
        setNotice(
          error instanceof DOMException && error.name === 'AbortError'
            ? 'The computer connection timed out. Retrying…'
            : error instanceof Error
            ? error.message
            : "Khloei's computer is unavailable.",
        )
        const delay = Math.min(1_000 * 2 ** attempt, 8_000)
        attempt += 1
        reconnectTimer = window.setTimeout(() => void connect(), delay)
      } finally {
        window.clearTimeout(sessionTimeout)
        if (sessionController === controller) sessionController = undefined
      }
    }

    void connect()
    window.addEventListener('pagehide', releaseIfHeld)
    return () => {
      active = false
      sessionController?.abort()
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (moveFrameRef.current !== null) {
        cancelAnimationFrame(moveFrameRef.current)
      }
      socket?.close()
      if (socketRef.current === socket) socketRef.current = null
      if (binaryFrameUrlRef.current) {
        URL.revokeObjectURL(binaryFrameUrlRef.current)
        binaryFrameUrlRef.current = null
      }
      window.removeEventListener('pagehide', releaseIfHeld)
      releaseIfHeld()
    }
  }, [applyTabs, interactive, releaseIfHeld])

  useEffect(() => {
    if (!interactive) return
    let active = true

    const refresh = async () => {
      try {
        const next = await responseJson<ComputerControlState>(
          await fetch('/api/computer/control', { cache: 'no-store' }),
        )
        if (active) {
          controlRef.current = next
          setControl(next)
        }
      } catch (error) {
        if (active) {
          setNotice(
            error instanceof Error
              ? error.message
              : 'Control status is unavailable.',
          )
        }
      }
    }

    void refresh()
    const interval = window.setInterval(() => void refresh(), 30_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [interactive])

  const liveFrame = connection === 'live' ? streamFrame : frame

  const changeControl = async (action: 'release' | 'take') => {
    setBusy(true)
    setNotice('')
    try {
      const next = await responseJson<ComputerControlState>(
        await fetch('/api/computer/control', {
          body: JSON.stringify({ action }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      )
      controlRef.current = next
      setControl(next)
      if (action === 'take') screenRef.current?.focus()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Control failed.')
    } finally {
      setBusy(false)
    }
  }

  const changeTab = async (input: HumanTabAction) => {
    setTabBusy(true)
    setNotice('')
    try {
      const next = await responseJson<TabsResult>(
        await fetch('/api/computer/tabs', {
          body: JSON.stringify(input),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      )
      applyTabs(next)
      if (input.action === 'open') {
        requestAnimationFrame(() => addressRef.current?.focus())
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'That tab action failed.',
      )
    } finally {
      setTabBusy(false)
    }
  }

  const submitAddress = (event: FormEvent) => {
    event.preventDefault()
    const url = addressRef.current?.value.trim()
    if (url) void changeTab({ action: 'navigate', url })
  }

  const point = (
    event: Pick<PointerEvent<HTMLDivElement>, 'clientX' | 'clientY'> | WheelEvent,
  ) => {
    const rect = screenRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: Math.min(
        liveFrame.width - 1,
        Math.max(0, ((event.clientX - rect.left) / rect.width) * liveFrame.width),
      ),
      y: Math.min(
        liveFrame.height - 1,
        Math.max(
          0,
          ((event.clientY - rect.top) / rect.height) * liveFrame.height,
        ),
      ),
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (control?.holder !== 'human') return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    send({
      type: 'mouse',
      event: 'pressed',
      ...point(event),
      button: pointerButton(event.button),
      clickCount: event.detail || 1,
      modifiers: modifiers(event),
    })
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (control?.holder !== 'human') return
    pendingMoveRef.current = {
      type: 'mouse',
      event: 'moved',
      ...point(event),
      button: pointerButton(event.button),
      modifiers: modifiers(event),
    }
    if (moveFrameRef.current !== null) return
    moveFrameRef.current = requestAnimationFrame(() => {
      moveFrameRef.current = null
      if (pendingMoveRef.current) send(pendingMoveRef.current)
      pendingMoveRef.current = null
    })
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (control?.holder !== 'human') return
    event.preventDefault()
    send({
      type: 'mouse',
      event: 'released',
      ...point(event),
      button: pointerButton(event.button),
      clickCount: event.detail || 1,
      modifiers: modifiers(event),
    })
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>, phase: 'down' | 'up') => {
    if (control?.holder !== 'human') return
    event.preventDefault()
    const producesText =
      phase === 'down' &&
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    send({
      type: 'key',
      event: phase,
      key: event.key,
      code: event.code,
      ...(producesText ? { text: event.key } : {}),
      modifiers: modifiers(event),
    })
  }

  const submitSecret = async (event: FormEvent) => {
    event.preventDefault()
    const input = secretRef.current
    const text = input?.value ?? ''
    if (!text) return
    if (input) input.value = ''
    setBusy(true)
    setNotice('')
    try {
      await responseJson(
        await fetch('/api/computer/secret', {
          body: JSON.stringify({ text }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      )
      setNotice('The value was entered without sharing it with the model.')
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The value was not entered.',
      )
    } finally {
      setBusy(false)
    }
  }

  const humanHasControl = control?.holder === 'human'
  const activeTab = tabsState?.tabs.find(
    (tab) => tab.id === tabsState.activeTabId,
  )
  const locationUrl =
    surface === 'desktop' ? surfaceLabel : activeTab?.url ?? liveFrame.url
  const tabsDisabled =
    !humanHasControl || tabBusy || connection !== 'live'
  const statusLabel =
    connection === 'live'
      ? humanHasControl
        ? 'You have control'
        : 'Live'
      : connection === 'connecting'
        ? 'Connecting'
        : 'Reconnecting'

  const computer = (
    <figure
      aria-label={isExpanded ? "Khloei's expanded computer" : undefined}
      aria-modal={isExpanded ? 'true' : undefined}
      className={`glass-surface prompt-glass computer-frame${
        isExpanded ? ' computer-frame-expanded' : ''
      }`}
      ref={frameRef}
      role={isExpanded ? 'dialog' : undefined}
      style={
        {
          '--computer-frame-ratio': liveFrame.width / liveFrame.height,
        } as CSSProperties
      }
    >
        <PromptGlass />
        <figcaption className="computer-frame-header">
          <span className="computer-frame-title">
            <Monitor aria-hidden size={14} strokeWidth={1.75} />
            Khloei&apos;s computer
          </span>
          <span
            className="computer-frame-location"
            title={
              surface === 'desktop' ? surfaceLabel : frameLocation(locationUrl)
            }
          >
            {surface === 'desktop' ? surfaceLabel : frameLocation(locationUrl)}
          </span>
        </figcaption>

        {interactive ? (
          <div className="computer-frame-toolbar">
            <span className="computer-frame-status" data-state={connection}>
              {connection === 'offline' ? (
                <Unplug aria-hidden size={12} />
              ) : (
                <Eye aria-hidden size={12} />
              )}
              {statusLabel}
            </span>
            <span className="computer-frame-toolbar-actions">
              <button
                className="computer-frame-control glass-surface prompt-glass"
                disabled={busy || connection !== 'live'}
                onClick={() =>
                  void changeControl(humanHasControl ? 'release' : 'take')
                }
                type="button"
              >
                <PromptGlass />
                <span className="computer-frame-control-label">
                  {humanHasControl ? (
                    <RotateCcw aria-hidden size={12} />
                  ) : (
                    <Hand aria-hidden size={12} />
                  )}
                  {humanHasControl ? 'Hand back' : 'Take control'}
                </span>
              </button>
              <button
                aria-label={
                  isExpanded
                    ? "Collapse Khloei's computer"
                    : "Expand Khloei's computer to interact"
                }
                className="computer-frame-control glass-surface prompt-glass"
                onClick={() => (isExpanded ? collapse() : setExpanded(true))}
                ref={expandButtonRef}
                type="button"
              >
                <PromptGlass />
                <span className="computer-frame-control-label">
                  {isExpanded ? (
                    <Minimize2 aria-hidden size={12} />
                  ) : (
                    <Maximize2 aria-hidden size={12} />
                  )}
                  {isExpanded ? 'Collapse' : 'Expand'}
                </span>
              </button>
            </span>
          </div>
        ) : null}

        {isExpanded && surface === 'browser' && tabsState ? (
          <div className="computer-frame-browser-chrome">
            <nav aria-label="Browser tabs" className="computer-frame-tabs">
              <div className="computer-frame-tab-list">
                {tabsState.tabs.map((tab) => {
                  const label = tabLabel(tab)
                  return (
                    <span
                      className="computer-frame-tab"
                      data-active={tab.active || undefined}
                      key={tab.id}
                    >
                      <button
                        aria-current={tab.active ? 'page' : undefined}
                        className="computer-frame-tab-select"
                        disabled={tabsDisabled || tab.active}
                        onClick={() =>
                          void changeTab({
                            action: 'activate',
                            tabId: tab.id,
                          })
                        }
                        title={tab.url}
                        type="button"
                      >
                        <span>{label}</span>
                      </button>
                      <button
                        aria-label={`Close ${label}`}
                        className="computer-frame-tab-close"
                        disabled={
                          tabsDisabled || tabsState.tabs.length === 1
                        }
                        onClick={() =>
                          void changeTab({ action: 'close', tabId: tab.id })
                        }
                        title={`Close ${label}`}
                        type="button"
                      >
                        <X aria-hidden size={12} strokeWidth={1.8} />
                      </button>
                    </span>
                  )
                })}
              </div>
              <button
                aria-label="Open new tab"
                className="computer-frame-new-tab"
                disabled={
                  tabsDisabled || tabsState.tabs.length >= tabsState.maxTabs
                }
                onClick={() => void changeTab({ action: 'open' })}
                title="Open new tab"
                type="button"
              >
                <Plus aria-hidden size={14} strokeWidth={1.7} />
              </button>
            </nav>

            <form
              className="computer-frame-address glass-surface prompt-glass"
              onSubmit={submitAddress}
            >
              <PromptGlass />
              <Globe2 aria-hidden size={13} strokeWidth={1.7} />
              <input
                aria-label="Browser address"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                defaultValue={tabAddress(activeTab?.url)}
                disabled={tabsDisabled}
                placeholder={
                  humanHasControl ? 'Enter a URL' : 'Take control to navigate'
                }
                ref={addressRef}
                spellCheck={false}
                type="text"
              />
              <button
                aria-label="Open address"
                disabled={tabsDisabled}
                title="Open address"
                type="submit"
              >
                <ArrowRight aria-hidden size={14} strokeWidth={1.8} />
              </button>
            </form>
          </div>
        ) : null}

        <div
          aria-label={
            humanHasControl
              ? `Khloei's interactive ${surface}. Mouse and keyboard input go to the ${surface}.`
              : undefined
          }
          className="computer-frame-screen"
          data-interactive={humanHasControl || undefined}
          onContextMenu={(event) => humanHasControl && event.preventDefault()}
          onKeyDown={(event) => onKey(event, 'down')}
          onKeyUp={(event) => onKey(event, 'up')}
          onPaste={(event) => {
            if (!humanHasControl) return
            event.preventDefault()
            send({
              type: 'text',
              text: event.clipboardData.getData('text/plain'),
            })
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={(event) => {
            if (!humanHasControl) return
            event.preventDefault()
            send({
              type: 'wheel',
              ...point(event),
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              modifiers: modifiers(event),
            })
          }}
          ref={screenRef}
          role={humanHasControl ? 'application' : undefined}
          style={{ aspectRatio: `${liveFrame.width} / ${liveFrame.height}` }}
          tabIndex={humanHasControl ? 0 : undefined}
        >
          <ComputerScreenImage
            alt="Khloei computer screen"
            imageRef={screenImageRef}
            src={liveFrame.dataUrl}
          />
        </div>

        {interactive && control?.secretWanted ? (
          <form className="computer-frame-secret" onSubmit={submitSecret}>
            <label
              htmlFor={`computer-secret-${liveFrame.width}-${liveFrame.height}`}
            >
              <KeyRound aria-hidden size={13} />
              Enter {control.secretWanted}
            </label>
            <div className="computer-frame-secret-row">
              <input
                autoComplete="off"
                id={`computer-secret-${liveFrame.width}-${liveFrame.height}`}
                ref={secretRef}
                type="password"
              />
              <button disabled={busy} type="submit">
                Enter privately
              </button>
            </div>
          </form>
        ) : null}

        {interactive && (notice || control?.reason) ? (
          <p aria-live="polite" className="computer-frame-notice">
            {notice || control?.reason}
          </p>
        ) : null}
    </figure>
  )

  return isExpanded
    ? createPortal(
        <>
          <button
            aria-label="Collapse Khloei's computer"
            className="computer-frame-backdrop"
            onClick={collapse}
            tabIndex={-1}
            type="button"
          />
          {computer}
        </>,
        document.body,
      )
    : computer
}
