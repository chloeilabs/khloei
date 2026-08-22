'use client'

import { Paperclip, X } from 'lucide-react'

import { PromptGlass } from './prompt-glass'
import { ZoomImage } from './zoom-image'

type AttachmentBase = {
  exiting?: boolean
  file: File
  id: string
}

export type PromptAttachment =
  | (AttachmentBase & { kind: 'file' })
  | (AttachmentBase & { kind: 'image'; url: string })

export function PromptAttachments({
  attachments,
  onRemove,
}: {
  attachments: PromptAttachment[]
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null

  return (
    <div className="prompt-input-attachments">
      {attachments.map((attachment, index) =>
        attachment.kind === 'image' ? (
          <div
            className="prompt-input-attachment"
            data-exit={attachment.exiting || undefined}
            key={attachment.id}
          >
            <ZoomImage
              alt={`Selected image ${index + 1}`}
              className="prompt-input-attachment-image"
              src={attachment.url}
            />
            {attachment.exiting ? null : (
              <button
                aria-label={`Remove image ${index + 1}`}
                className="glass-surface prompt-glass prompt-input-attachment-remove"
                onClick={() => onRemove(attachment.id)}
                type="button"
              >
                <PromptGlass />
                <X aria-hidden size={11} strokeWidth={1.75} />
              </button>
            )}
          </div>
        ) : (
          <span
            className="prompt-input-file-chip"
            data-exit={attachment.exiting || undefined}
            key={attachment.id}
          >
            <span className="prompt-input-file-chip-icon">
              <Paperclip aria-hidden size={13} strokeWidth={1.75} />
            </span>
            <span className="prompt-input-file-chip-name">
              {attachment.file.name}
            </span>
            {attachment.exiting ? null : (
              <button
                aria-label={`Remove ${attachment.file.name}`}
                className="prompt-input-file-chip-remove"
                onClick={() => onRemove(attachment.id)}
                type="button"
              >
                <X aria-hidden size={11} strokeWidth={1.75} />
              </button>
            )}
          </span>
        ),
      )}
    </div>
  )
}
