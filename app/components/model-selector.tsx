'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  Atom,
  Check,
  ChevronDown,
  Rocket,
  Telescope,
} from 'lucide-react'

import {
  CHAT_MODELS,
  chatModelById,
  type ChatModelId,
} from '../lib/chat-models'
import { PromptGlass } from './prompt-glass'

const MODEL_ICONS = {
  'z-ai/glm-5.3-flash': Atom,
  'x-ai/grok-4.6': Rocket,
} satisfies Record<ChatModelId, typeof Atom>

type ModelSelectorProps = {
  disabled?: boolean
  mode?: 'deep-research'
  onChange: (modelId: ChatModelId) => void
  value: ChatModelId
}

export function ModelSelector({
  disabled = false,
  mode,
  onChange,
  value,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selected = chatModelById(value)
  const forced = mode === 'deep-research'
  const modelName = forced ? 'GLM 5.3 Flash' : selected.name
  const SelectedIcon = forced ? Telescope : MODEL_ICONS[selected.id]

  const focusOption = (index: number) => {
    rootRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
      .item(index)
      ?.focus()
  }

  const openMenu = () => {
    if (disabled || forced) return
    setOpen(true)
    const selectedIndex = CHAT_MODELS.findIndex((model) => model.id === value)
    requestAnimationFrame(() => focusOption(Math.max(0, selectedIndex)))
  }

  useEffect(() => {
    if (!open) return

    const closeOutside = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      requestAnimationFrame(() => triggerRef.current?.focus())
    }

    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const options = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ) ?? [],
    )
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement)
    const direction = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + direction + options.length) % options.length
    options[nextIndex]?.focus()
  }

  return (
    <div className="prompt-input-model-selector" ref={rootRef}>
      <button
        aria-disabled={disabled || forced}
        aria-expanded={forced ? undefined : open}
        aria-haspopup={forced ? undefined : 'menu'}
        aria-label={`Model: ${modelName}`}
        className="prompt-input-pill prompt-input-model-trigger"
        data-forced={forced || undefined}
        data-open={open || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openMenu()
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="prompt-input-model-trigger-icon">
          <SelectedIcon aria-hidden size={13} strokeWidth={1.75} />
        </span>
        <span className="prompt-input-model-name">{modelName}</span>
        {forced ? null : (
          <span className="prompt-input-model-trigger-chevron">
            <ChevronDown aria-hidden size={12} strokeWidth={1.75} />
          </span>
        )}
      </button>

      {open && !forced ? (
        <div
          aria-label="Choose a model"
          className="prompt-input-menu prompt-input-model-menu"
          onKeyDown={handleMenuKeyDown}
          role="menu"
        >
          <PromptGlass />
          {CHAT_MODELS.map((model) => {
            const Icon = MODEL_ICONS[model.id]
            const checked = model.id === value
            return (
              <button
                aria-checked={checked}
                className="prompt-input-menu-item prompt-input-model-option"
                key={model.id}
                onClick={() => {
                  onChange(model.id)
                  setOpen(false)
                  requestAnimationFrame(() => triggerRef.current?.focus())
                }}
                role="menuitemradio"
                type="button"
              >
                <span className="prompt-input-menu-icon">
                  <Icon aria-hidden size={14} strokeWidth={1.75} />
                </span>
                <span className="prompt-input-model-title">{model.name}</span>
                {checked ? (
                  <span className="prompt-input-model-check">
                    <Check aria-hidden size={13} strokeWidth={2} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
