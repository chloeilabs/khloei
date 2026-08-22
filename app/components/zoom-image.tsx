'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react'
import { createPortal } from 'react-dom'

const VIEWPORT_PADDING = 32

type CloseReason = 'escape' | 'overlay' | 'viewport'

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function imageSize(image: HTMLImageElement, width?: number, height?: number) {
  return {
    height: height || image.naturalHeight || image.clientHeight || 1,
    width: width || image.naturalWidth || image.clientWidth || 1,
  }
}

export type ZoomImageProps = {
  alt: string
  className?: string
  height?: number
  src: string
  style?: CSSProperties
  width?: number
}

export function ZoomImage({
  alt,
  className,
  height,
  src,
  style,
  width,
}: ZoomImageProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<{
    from: string
    intrinsic: { height: number; width: number }
    target: { height: number; left: number; top: number; width: number }
  } | null>(null)
  const [state, setState] = useState<'closing' | 'open' | 'opening'>(
    'opening',
  )
  const stateRef = useRef(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const open = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const image = triggerRef.current?.querySelector('img')
      if (!image) return

      const rect = image.getBoundingClientRect()
      const intrinsic = imageSize(image, width, height)
      const maxWidth = Math.min(
        window.innerWidth - VIEWPORT_PADDING * 2,
        intrinsic.width,
      )
      const maxHeight = Math.min(
        window.innerHeight - VIEWPORT_PADDING * 2,
        intrinsic.height,
      )
      const scale = Math.min(
        maxWidth / intrinsic.width,
        maxHeight / intrinsic.height,
        1,
      )
      const targetWidth = Math.max(1, Math.round(intrinsic.width * scale))
      const targetHeight = Math.max(1, Math.round(intrinsic.height * scale))
      const target = {
        height: targetHeight,
        left: Math.round((window.innerWidth - targetWidth) / 2),
        top: Math.round((window.innerHeight - targetHeight) / 2),
        width: targetWidth,
      }

      const inlineScale = rect.width / targetWidth
      const translateX =
        rect.left +
        rect.width / 2 -
        (target.left + targetWidth / 2)
      const translateY =
        rect.top +
        rect.height / 2 -
        (target.top + targetHeight / 2)

      setZoom({
        from: `translate(${translateX}px, ${translateY}px) scale(${inlineScale})`,
        intrinsic,
        target,
      })
      setState(
        event.detail === 0 || prefersReducedMotion() ? 'open' : 'opening',
      )
    },
    [height, width],
  )

  const unmount = useCallback(() => {
    setZoom(null)
    setState('opening')
    triggerRef.current?.focus({ preventScroll: true })
  }, [])

  const close = useCallback(
    (reason: CloseReason) => {
      if (
        reason === 'escape' ||
        prefersReducedMotion() ||
        stateRef.current === 'opening'
      ) {
        unmount()
        return
      }
      if (stateRef.current !== 'open') return

      const image = triggerRef.current?.querySelector('img')
      if (image) {
        const rect = image.getBoundingClientRect()
        setZoom((current) => {
          if (!current) return current
          const inlineScale = rect.width / current.target.width
          const translateX =
            rect.left +
            rect.width / 2 -
            (current.target.left + current.target.width / 2)
          const translateY =
            rect.top +
            rect.height / 2 -
            (current.target.top + current.target.height / 2)

          return {
            ...current,
            from: `translate(${translateX}px, ${translateY}px) scale(${inlineScale})`,
          }
        })
      }
      setState('closing')
    },
    [unmount],
  )

  useEffect(() => {
    if (!zoom || state !== 'opening') return
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => setState('open')),
    )
    return () => cancelAnimationFrame(frame)
  }, [state, zoom])

  useEffect(() => {
    if (zoom && state === 'open') {
      overlayRef.current?.focus({ preventScroll: true })
    }
    if (state !== 'closing') return

    const timeout = setTimeout(unmount, 450)
    return () => clearTimeout(timeout)
  }, [state, unmount, zoom])

  useEffect(() => {
    if (!zoom) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close('escape')
      }
      if (event.key === 'Tab') event.preventDefault()
    }
    const onGesture = (event: Event) => {
      event.preventDefault()
      close('viewport')
    }
    const onViewportChange = () => close('viewport')

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('wheel', onGesture, { passive: false })
    window.addEventListener('touchmove', onGesture, { passive: false })
    window.addEventListener('scroll', onViewportChange)
    window.addEventListener('resize', onViewportChange)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('wheel', onGesture)
      window.removeEventListener('touchmove', onGesture)
      window.removeEventListener('scroll', onViewportChange)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [close, zoom])

  const settle = () => {
    if (stateRef.current === 'closing') unmount()
  }
  const floating = state === 'open'

  return (
    <>
      <button
        aria-label={alt ? `Zoom image: ${alt}` : 'Zoom image'}
        className="zoom-trigger"
        data-zoomed={zoom ? '' : undefined}
        onClick={open}
        ref={triggerRef}
        style={style}
        type="button"
      >
        {/* Dynamic chat images intentionally bypass Next image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt={alt} className={className} src={src} />
      </button>

      {zoom
        ? createPortal(
            <div
              aria-label={alt || 'Image'}
              aria-modal="true"
              className="zoom-overlay"
              data-state={floating ? 'open' : state}
              onClick={() => close('overlay')}
              ref={overlayRef}
              role="dialog"
              tabIndex={-1}
            >
              <div className="zoom-overlay-backdrop" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={alt}
                height={zoom.intrinsic.height}
                onTransitionEnd={settle}
                src={src}
                style={{
                  height: zoom.target.height,
                  left: zoom.target.left,
                  top: zoom.target.top,
                  transform: floating ? 'none' : zoom.from,
                  width: zoom.target.width,
                }}
                width={zoom.intrinsic.width}
              />
              <div
                aria-hidden
                className="zoom-overlay-marks"
                style={
                  {
                    '--zoom-corner-arm': '11px',
                    height: zoom.target.height + 20,
                    left: zoom.target.left - 10,
                    top: zoom.target.top - 10,
                    width: zoom.target.width + 20,
                  } as CSSProperties
                }
              />
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
