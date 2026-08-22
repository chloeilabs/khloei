'use client'

import type { CSSProperties } from 'react'

const FROSTED_GLASS_STYLE: CSSProperties = {
  backdropFilter: 'blur(12px) saturate(1.25)',
  WebkitBackdropFilter: 'blur(12px) saturate(1.25)',
}

export function PromptGlass() {
  return (
    <span
      aria-hidden
      className="prompt-glass-layer"
      style={FROSTED_GLASS_STYLE}
    />
  )
}
