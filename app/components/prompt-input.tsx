'use client'

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from 'react'
import {
  ArrowUp,
  BookOpen,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  MonitorCog,
  Paperclip,
  Plus,
  Square,
  Telescope,
} from 'lucide-react'

import { enhancePromptText } from '../lib/prompt-enhancement'
import {
  matchPromptSkills,
  PROMPT_SKILLS,
  type PromptSkillId,
} from '../lib/prompt-skills'
import {
  PromptAttachments,
  type PromptAttachment,
} from './prompt-attachments'
import { PromptGlass } from './prompt-glass'
import { ModelSelector } from './model-selector'
import type { ChatModelId } from '../lib/chat-models'

type Phase = 'idle' | 'enhancing' | 'enhanced'

export type PromptSubmission = {
  attachments: Array<{
    file: File
    kind: 'file' | 'image'
  }>
  text: string
}

type PromptInputProps = {
  docked?: boolean
  modelId: ChatModelId
  onNewChat?: () => void
  onModelChange: (modelId: ChatModelId) => void
  onStop?: () => void
  onSubmit?: (submission: PromptSubmission) => void
  shellRef?: Ref<HTMLDivElement>
  showNewChat?: boolean
  submitting?: boolean
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/jpg'
const FILE_ACCEPT =
  '.pdf,.doc,.docx,.pptx,.txt,.md,.markdown,.json,.js,.ts,.py,.html,.css,.c,.cpp,.cs,.go,.java,.php,.rb,.sh,.tex,text/plain,text/markdown,application/pdf,application/json'
const MAX_IMAGES = 4
const MAX_FILES = 4
const SKILLS_MENU_CLOSE_DELAY_MS = 300

const skillName = (id: PromptSkillId) =>
  PROMPT_SKILLS.find((skill) => skill.id === id)?.name ?? id

const PROMPT_SKILL_ICONS = {
  'computer-use': MonitorCog,
  'deep-research': Telescope,
} satisfies Record<PromptSkillId, typeof Telescope>

function PromptSkillIcon({ id }: { id: PromptSkillId }) {
  const Icon = PROMPT_SKILL_ICONS[id]
  return <Icon aria-hidden size={14} strokeWidth={1.75} />
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character,
  )

const promptSkillIds = new Set<PromptSkillId>(
  PROMPT_SKILLS.map((skill) => skill.id),
)

function promptSkillId(value: string | undefined) {
  return value && promptSkillIds.has(value as PromptSkillId)
    ? (value as PromptSkillId)
    : null
}

function removeSkillPill(pill: HTMLElement) {
  const separator = pill.nextSibling
  if (
    separator?.nodeType === Node.TEXT_NODE &&
    separator.textContent?.startsWith('\u00A0')
  ) {
    const rest = separator.textContent.slice(1)
    if (rest) separator.textContent = rest
    else separator.parentNode?.removeChild(separator)
  }
  pill.remove()
}

function editorMessageText(editor: HTMLElement) {
  const parts: string[] = []

  const appendNewline = () => {
    const last = parts.at(-1)
    if (parts.length > 0 && last && !last.endsWith('\n')) parts.push('\n')
  }

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '')
      return
    }
    if (!(node instanceof HTMLElement) || node.dataset.skill) return
    if (node.tagName === 'BR') {
      parts.push('\n')
      return
    }

    const block = node.tagName === 'DIV' || node.tagName === 'P'
    if (block) appendNewline()
    node.childNodes.forEach(visit)
    if (block) appendNewline()
  }

  editor.childNodes.forEach(visit)
  return parts
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildSkillPill(id: PromptSkillId) {
  const name = skillName(id)
  const element = document.createElement('span')
  element.className = 'prompt-input-skill-pill'
  element.setAttribute('contenteditable', 'false')
  element.dataset.skill = id
  element.innerHTML =
    '<span class="prompt-input-skill-pill-label">/' +
    escapeHtml(name) +
    '</span>' +
    '<button type="button" class="prompt-input-skill-pill-x" data-remove="1" aria-label="Remove ' +
    escapeHtml(name) +
    '"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
  return element
}

function attachmentId() {
  return crypto.randomUUID()
}

export function PromptInput({
  docked = false,
  modelId,
  onNewChat,
  onModelChange,
  onStop,
  onSubmit,
  shellRef,
  showNewChat = false,
  submitting = false,
}: PromptInputProps) {
  const [value, setValue] = useState('')
  const [messageText, setMessageText] = useState('')
  const [selectedSkill, setSelectedSkill] = useState<PromptSkillId | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [menuOpen, setMenuOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashKeyboard, setSlashKeyboard] = useState(false)
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])

  const editorRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLFormElement>(null)
  const plusRef = useRef<HTMLDivElement>(null)
  const plusButtonRef = useRef<HTMLButtonElement>(null)
  const skillsButtonRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const preEnhanceHTML = useRef('')
  const pendingHTML = useRef<string | null>(null)
  const flipFrom = useRef<number | null>(null)
  const savedRange = useRef<Range | null>(null)
  const slashQueryRef = useRef('')
  const slashTokenRef = useRef<{ node: Text; start: number; end: number } | null>(
    null,
  )
  const ignoreHoverRef = useRef(false)
  const slashKeyLock = useRef(false)
  const skillsCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachmentsRef = useRef<PromptAttachment[]>([])
  const removalTimersRef = useRef<Set<number>>(new Set())

  const hasEditorContent = value.trim().length > 0
  const hasMessageText = messageText.length > 0
  const enhancing = phase === 'enhancing'
  const activeAttachments = attachments.filter((attachment) => !attachment.exiting)
  const hasAttachment = activeAttachments.length > 0
  const canSubmit =
    !enhancing && !submitting && (hasMessageText || hasAttachment)
  const showPill = hasMessageText && !enhancing
  const slashResults = matchPromptSkills(slashQuery)
  const activeSlashIndex =
    slashResults.length === 0
      ? 0
      : Math.min(slashIndex, slashResults.length - 1)
  const imageCount = attachments.filter(
    (attachment) => attachment.kind === 'image' && !attachment.exiting,
  ).length
  const fileCount = attachments.filter(
    (attachment) => attachment.kind === 'file' && !attachment.exiting,
  ).length

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(
    () => () => {
      for (const timer of removalTimersRef.current) window.clearTimeout(timer)
      for (const attachment of attachmentsRef.current) {
        if (attachment.kind === 'image') URL.revokeObjectURL(attachment.url)
      }
    },
    [],
  )

  const focusEnd = () => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    savedRange.current = range.cloneRange()
  }

  const syncFromEditor = () => {
    const editor = editorRef.current
    if (!editor) return
    setValue(editor.innerText || editor.textContent || '')
    setMessageText(editorMessageText(editor))
    const pills = Array.from(
      editor.querySelectorAll<HTMLElement>('.prompt-input-skill-pill'),
    )
    setSelectedSkill(
      pills.map((pill) => promptSkillId(pill.dataset.skill)).find(Boolean) ??
        null,
    )
    pills.forEach((pill) => {
        let atStart = true
        for (let node = pill.previousSibling; node; node = node.previousSibling) {
          if (
            node.nodeType === Node.TEXT_NODE &&
            (node.textContent ?? '').trim() === ''
          ) {
            continue
          }
          atStart = false
          break
        }
        pill.toggleAttribute('data-start', atStart)
      })
  }

  const saveSelection = () => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (
      selection &&
      selection.rangeCount &&
      editor &&
      editor.contains(selection.anchorNode)
    ) {
      savedRange.current = selection.getRangeAt(0).cloneRange()
    }
  }

  const closeSlash = () => {
    setSlashOpen(false)
    setSlashQuery('')
    setSlashIndex(0)
    setSlashKeyboard(false)
    slashQueryRef.current = ''
    slashTokenRef.current = null
    ignoreHoverRef.current = false
  }

  const cancelSkillsClose = () => {
    if (skillsCloseTimerRef.current === null) return
    clearTimeout(skillsCloseTimerRef.current)
    skillsCloseTimerRef.current = null
  }

  const openSkillsMenu = () => {
    cancelSkillsClose()
    setSkillsOpen(true)
  }

  const scheduleSkillsClose = () => {
    cancelSkillsClose()
    skillsCloseTimerRef.current = setTimeout(() => {
      skillsCloseTimerRef.current = null
      setSkillsOpen(false)
    }, SKILLS_MENU_CLOSE_DELAY_MS)
  }

  const closeMenu = () => {
    cancelSkillsClose()
    setMenuOpen(false)
    setSkillsOpen(false)
  }

  const closeMenuFromEffect = useEffectEvent(closeMenu)
  const closeSkillsMenuFromEffect = useEffectEvent(() => {
    cancelSkillsClose()
    setSkillsOpen(false)
    requestAnimationFrame(() => skillsButtonRef.current?.focus())
  })

  const insertPillOverRange = (range: Range, id: PromptSkillId) => {
    const editor = editorRef.current
    if (!editor) return
    range.deleteContents()
    const pill = buildSkillPill(id)
    range.insertNode(pill)
    editor
      .querySelectorAll<HTMLElement>('.prompt-input-skill-pill')
      .forEach((current) => {
        if (current !== pill) removeSkillPill(current)
      })
    const space = document.createTextNode('\u00A0')
    pill.after(space)
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(after)
    editor.focus()
    savedRange.current = after.cloneRange()
    syncFromEditor()
    if (phase === 'enhanced') setPhase('idle')
  }

  const addSkillFromMenu = (id: PromptSkillId) => {
    const editor = editorRef.current
    if (!editor) return
    const selection = window.getSelection()
    let range: Range | null = null
    if (selection && selection.rangeCount && editor.contains(selection.anchorNode)) {
      range = selection.getRangeAt(0).cloneRange()
    } else if (
      savedRange.current &&
      editor.contains(savedRange.current.startContainer)
    ) {
      range = savedRange.current.cloneRange()
    }
    if (!range) {
      range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    insertPillOverRange(range, id)
    closeMenu()
  }

  const applySlash = (id: PromptSkillId) => {
    const editor = editorRef.current
    if (!editor) {
      closeSlash()
      return
    }
    let range: Range | null = null
    const token = slashTokenRef.current
    if (
      token &&
      token.node.isConnected &&
      editor.contains(token.node) &&
      token.end <= (token.node.textContent?.length ?? 0)
    ) {
      range = document.createRange()
      range.setStart(token.node, token.start)
      range.setEnd(token.node, token.end)
    } else {
      const selection = window.getSelection()
      if (selection && selection.rangeCount) {
        const caret = selection.getRangeAt(0)
        range = caret.cloneRange()
        const node = caret.startContainer
        if (node.nodeType === Node.TEXT_NODE && editor.contains(node)) {
          const before = (node.textContent ?? '').slice(0, caret.startOffset)
          const match = before.match(/\/([^\s/]*)$/)
          if (match) {
            range = document.createRange()
            range.setStart(node, caret.startOffset - match[0].length)
            range.setEnd(node, caret.startOffset)
          }
        }
      }
    }
    if (!range) {
      closeSlash()
      return
    }
    insertPillOverRange(range, id)
    closeSlash()
  }

  const detectSlash = () => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || !selection.rangeCount || !selection.isCollapsed) {
      closeSlash()
      return
    }
    const range = selection.getRangeAt(0)
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) {
      closeSlash()
      return
    }
    const before = (node.textContent ?? '').slice(0, range.startOffset)
    const match = before.match(/(?:^|\s)\/([^\s/]*)$/)
    if (!match) {
      closeSlash()
      return
    }
    const query = match[1] ?? ''
    const slashStart = before.length - query.length - 1
    slashTokenRef.current = {
      node: node as Text,
      start: slashStart,
      end: range.startOffset,
    }
    if (query !== slashQueryRef.current) {
      slashQueryRef.current = query
      setSlashIndex(0)
    }
    setSlashQuery(query)
    setSlashOpen(true)
  }

  const onEditorInput = () => {
    syncFromEditor()
    if (phase === 'enhanced') setPhase('idle')
    detectSlash()
  }

  const handleSlashKey = (event: {
    key: string
    preventDefault: () => void
    stopPropagation?: () => void
  }) => {
    if (!slashOpen) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation?.()
      closeSlash()
      return true
    }
    if (!slashResults.length) return false
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Enter' &&
      event.key !== 'Tab'
    ) {
      return false
    }
    event.preventDefault()
    event.stopPropagation?.()
    if (slashKeyLock.current) return true
    slashKeyLock.current = true
    queueMicrotask(() => {
      slashKeyLock.current = false
    })
    if (event.key === 'ArrowDown') {
      ignoreHoverRef.current = true
      setSlashKeyboard(true)
      setSlashIndex(
        (index) =>
          (Math.min(index, slashResults.length - 1) + 1) % slashResults.length,
      )
      return true
    }
    if (event.key === 'ArrowUp') {
      ignoreHoverRef.current = true
      setSlashKeyboard(true)
      setSlashIndex(
        (index) =>
          (Math.min(index, slashResults.length - 1) - 1 + slashResults.length) %
          slashResults.length,
      )
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      applySlash((slashResults[activeSlashIndex] ?? slashResults[0])!.id)
      return true
    }
    return false
  }

  const onWindowPromptKey = useEffectEvent((event: KeyboardEvent) => {
    handleSlashKey(event)
  })

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (handleSlashKey(event)) return
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault()
      if (canSubmit) submitPrompt()
    }
  }

  useEffect(() => {
    if (!slashOpen) return
    const onKey = (event: KeyboardEvent) => onWindowPromptKey(event)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [slashOpen])

  const onEditorClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const remove = (event.target as HTMLElement).closest('[data-remove]')
    if (remove) {
      event.preventDefault()
      const pill = remove.closest<HTMLElement>('[data-skill]')
      if (pill) {
        const width = pill.getBoundingClientRect().width
        pill.style.maxWidth = `${width}px`
        pill.style.overflow = 'hidden'
        pill.style.whiteSpace = 'nowrap'
        void pill.offsetWidth
        pill.style.transition =
          'max-width 180ms cubic-bezier(0.22,1,0.36,1), margin 180ms cubic-bezier(0.22,1,0.36,1), padding 180ms cubic-bezier(0.22,1,0.36,1)'
        pill.setAttribute('data-exit', '')
        pill.style.maxWidth = '0px'
        pill.style.marginLeft = '0px'
        pill.style.marginRight = '0px'
        pill.style.paddingLeft = '0px'
        pill.style.paddingRight = '0px'
        let done = false
        const finish = () => {
          if (done) return
          done = true
          removeSkillPill(pill)
          syncFromEditor()
          if (phase === 'enhanced') setPhase('idle')
          editorRef.current?.focus()
        }
        pill.addEventListener('animationend', finish, { once: true })
        window.setTimeout(finish, 220)
      }
      return
    }
    saveSelection()
  }

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: PointerEvent) => {
      if (!plusRef.current?.contains(event.target as Node)) closeMenuFromEffect()
    }
    const onKey = (event: KeyboardEvent) => {
      const skillsFlyout = plusRef.current?.querySelector(
        '.prompt-input-menu-flyout',
      )
      if (
        (event.key === 'Escape' || event.key === 'ArrowLeft') &&
        skillsFlyout?.contains(document.activeElement)
      ) {
        event.preventDefault()
        closeSkillsMenuFromEffect()
        return
      }
      if (event.key === 'Escape') {
        closeMenuFromEffect()
        requestAnimationFrame(() => plusButtonRef.current?.focus())
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => () => cancelSkillsClose(), [])

  useLayoutEffect(() => {
    if (enhancing || pendingHTML.current === null) return
    const editor = editorRef.current
    if (!editor) return
    editor.innerHTML = pendingHTML.current
    pendingHTML.current = null
    syncFromEditor()
    const focusFrame = requestAnimationFrame(focusEnd)

    const frame = frameRef.current
    const from = flipFrom.current
    flipFrom.current = null
    if (!frame || from === null) {
      return () => cancelAnimationFrame(focusFrame)
    }
    const to = frame.offsetHeight
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || from === to) {
      return () => cancelAnimationFrame(focusFrame)
    }
    frame.style.height = `${from}px`
    frame.style.overflow = 'hidden'
    void frame.offsetHeight
    frame.style.transition = 'height 200ms cubic-bezier(0.22, 1, 0.36, 1)'
    frame.style.height = `${to}px`
    let done = false
    const finish = () => {
      if (done) return
      done = true
      frame.style.transition = ''
      frame.style.height = ''
      frame.style.overflow = ''
      frame.removeEventListener('transitionend', finish)
    }
    frame.addEventListener('transitionend', finish)
    const timeout = window.setTimeout(finish, 260)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.clearTimeout(timeout)
      finish()
    }
  }, [phase, enhancing])

  const runEnhance = async () => {
    if (!hasMessageText || enhancing) return
    preEnhanceHTML.current = editorRef.current?.innerHTML ?? ''
    setPhase('enhancing')
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    const result = enhancePromptText(messageText)
    const skillPrefix = selectedSkill
      ? `${buildSkillPill(selectedSkill).outerHTML}&nbsp;`
      : ''
    pendingHTML.current =
      skillPrefix + escapeHtml(result).replace(/\n/g, '<br>')
    flipFrom.current = frameRef.current?.offsetHeight ?? null
    setPhase('enhanced')
  }

  const revert = () => {
    pendingHTML.current = preEnhanceHTML.current
    flipFrom.current = frameRef.current?.offsetHeight ?? null
    setPhase('idle')
  }

  const revokeAttachments = (items: PromptAttachment[]) => {
    for (const attachment of items) {
      if (attachment.kind === 'image') URL.revokeObjectURL(attachment.url)
    }
  }

  const clearAttachments = () => {
    setAttachments((current) => {
      revokeAttachments(current)
      return []
    })
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.id === id ? { ...attachment, exiting: true } : attachment,
      ),
    )
    const timer = window.setTimeout(() => {
      setAttachments((current) => {
        const removed = current.filter((attachment) => attachment.id === id)
        revokeAttachments(removed)
        return current.filter((attachment) => attachment.id !== id)
      })
      removalTimersRef.current.delete(timer)
    }, 180)
    removalTimersRef.current.add(timer)
  }

  const addAttachments = (kind: 'image' | 'file', files: File[]) => {
    setAttachments((current) => {
      const activeImages = current.filter(
        (attachment) => attachment.kind === 'image' && !attachment.exiting,
      ).length
      const activeFiles = current.filter(
        (attachment) => attachment.kind === 'file' && !attachment.exiting,
      ).length
      const available =
        kind === 'image' ? MAX_IMAGES - activeImages : MAX_FILES - activeFiles
      const additions = files.slice(0, Math.max(0, available)).map((file) =>
        kind === 'image'
          ? ({
              file,
              id: attachmentId(),
              kind: 'image' as const,
              url: URL.createObjectURL(file),
            } satisfies PromptAttachment)
          : ({
              file,
              id: attachmentId(),
              kind: 'file' as const,
            } satisfies PromptAttachment),
      )
      return [...current, ...additions]
    })
  }

  function clearComposer() {
    const editor = editorRef.current
    if (editor) editor.innerHTML = ''
    setValue('')
    setMessageText('')
    setSelectedSkill(null)
    setPhase('idle')
    clearAttachments()
    closeMenu()
    closeSlash()
    requestAnimationFrame(() => editorRef.current?.focus())
  }

  function startNewChat() {
    onNewChat?.()
    clearComposer()
  }

  function submitPrompt(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!canSubmit) return
    onSubmit?.({
      attachments: activeAttachments.map((attachment) => ({
        file: attachment.file,
        kind: attachment.kind,
      })),
      text: [
        selectedSkill ? `/${skillName(selectedSkill)}` : '',
        messageText,
      ]
        .filter(Boolean)
        .join('\n'),
    })
    clearComposer()
  }

  function openPicker(kind: 'image' | 'file') {
    const input = fileRef.current
    if (!input) return
    input.accept = kind === 'image' ? IMAGE_ACCEPT : FILE_ACCEPT
    input.value = ''
    input.dataset.kind = kind
    input.click()
    closeMenu()
  }

  return (
      <div
        className="prompt-input-shell"
        data-docked={docked || undefined}
        data-prompt-form=""
        ref={shellRef}
      >
        <form
          aria-busy={enhancing || submitting}
          aria-label="Khloei prompt"
          className="glass-surface prompt-glass prompt-input"
          data-enhancing={enhancing || undefined}
          onSubmit={submitPrompt}
          ref={frameRef}
        >
          <PromptGlass />
          <input
            aria-label="Choose files"
            className="prompt-input-file-input"
            disabled={enhancing}
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              const kind =
                (event.target.dataset.kind as 'image' | 'file') ?? 'file'
              event.target.value = ''
              if (!files.length) return

              if (kind === 'image') {
                addAttachments('image', files)
              } else {
                const images = files.filter((file) => file.type.startsWith('image/'))
                const documents = files.filter(
                  (file) => !file.type.startsWith('image/'),
                )
                if (images.length) addAttachments('image', images)
                if (documents.length) addAttachments('file', documents)
              }
              requestAnimationFrame(() => editorRef.current?.focus())
            }}
            ref={fileRef}
            tabIndex={-1}
            type="file"
          />

          <PromptAttachments
            attachments={attachments}
            onRemove={removeAttachment}
          />

          <div className="prompt-input-editor">
            {enhancing ? (
              <div aria-live="polite" className="prompt-input-enhancing-text">
                {value}
              </div>
            ) : (
              <div
                aria-label="Message"
                aria-multiline="true"
                className="prompt-input-field"
                contentEditable
                data-empty={!hasEditorContent || undefined}
                data-placeholder="Ask anything"
                onBlur={saveSelection}
                onClick={onEditorClick}
                onInput={onEditorInput}
                onKeyDown={onEditorKeyDown}
                onKeyUp={saveSelection}
                onMouseUp={saveSelection}
                ref={editorRef}
                role="textbox"
                suppressContentEditableWarning
              />
            )}

            {slashOpen && !enhancing ? (
              <div
                aria-label="Skills"
                className="prompt-input-slash-menu"
                data-keyboard={slashKeyboard || undefined}
                onMouseMove={() => {
                  ignoreHoverRef.current = false
                  if (slashKeyboard) setSlashKeyboard(false)
                }}
                role="listbox"
              >
                <PromptGlass />
                <div className="prompt-input-slash-label">Skills</div>
                {slashResults.length ? (
                  slashResults.map((skill, index) => (
                    <button
                      aria-selected={index === activeSlashIndex}
                      className="prompt-input-menu-item"
                      data-active={index === activeSlashIndex || undefined}
                      key={skill.id}
                      onClick={() => applySlash(skill.id)}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => {
                        if (ignoreHoverRef.current) return
                        setSlashIndex(index)
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="prompt-input-menu-icon">
                        <PromptSkillIcon id={skill.id} />
                      </span>
                      <span className="prompt-input-menu-name">{skill.name}</span>
                    </button>
                  ))
                ) : (
                  <div className="prompt-input-slash-empty">No matching skills</div>
                )}
              </div>
            ) : null}
          </div>

          <div className="prompt-input-row">
            <div className="prompt-input-left">
              <div
                className="prompt-input-plus-wrap"
                onBlur={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node)) {
                    return
                  }
                  closeMenu()
                }}
                ref={plusRef}
              >
                <button
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  aria-label="Add attachment or skill"
                  className="prompt-input-icon-btn prompt-input-plus"
                  data-open={menuOpen || undefined}
                  disabled={enhancing}
                  onClick={() => setMenuOpen((open) => !open)}
                  ref={plusButtonRef}
                  type="button"
                >
                  <span className="prompt-input-plus-icon">
                    <Plus aria-hidden size={14} strokeWidth={1.75} />
                  </span>
                </button>

                {menuOpen ? (
                  <div
                    aria-label="Add attachment or skill"
                    className="prompt-input-menu"
                    role="menu"
                  >
                    <PromptGlass />
                  <button
                    className="prompt-input-menu-item"
                    disabled={imageCount >= MAX_IMAGES}
                    onClick={() => openPicker('image')}
                    role="menuitem"
                    type="button"
                  >
                    <span className="prompt-input-menu-icon">
                      <ImageIcon aria-hidden size={14} strokeWidth={1.75} />
                    </span>
                    <span className="prompt-input-menu-name">Add photos</span>
                  </button>
                  <button
                    className="prompt-input-menu-item"
                    disabled={fileCount >= MAX_FILES}
                    onClick={() => openPicker('file')}
                    role="menuitem"
                    type="button"
                  >
                    <span className="prompt-input-menu-icon">
                      <Paperclip aria-hidden size={14} strokeWidth={1.75} />
                    </span>
                    <span className="prompt-input-menu-name">Attach files</span>
                  </button>
                  <div aria-hidden className="prompt-input-menu-divider" />
                  <div
                    className="prompt-input-menu-sub prompt-input-menu-skills"
                    data-open={skillsOpen || undefined}
                    onPointerEnter={openSkillsMenu}
                    onPointerLeave={scheduleSkillsClose}
                  >
                    <button
                      aria-controls={
                        skillsOpen ? 'prompt-input-skills-menu' : undefined
                      }
                      aria-expanded={skillsOpen}
                      aria-haspopup="menu"
                      className="prompt-input-menu-item"
                      onClick={openSkillsMenu}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft' && skillsOpen) {
                          event.preventDefault()
                          setSkillsOpen(false)
                          return
                        }
                        if (event.key !== 'ArrowRight') return
                        event.preventDefault()
                        openSkillsMenu()
                        requestAnimationFrame(() => {
                          plusRef.current
                            ?.querySelector<HTMLButtonElement>(
                              '.prompt-input-menu-flyout .prompt-input-menu-item',
                            )
                            ?.focus()
                        })
                      }}
                      ref={skillsButtonRef}
                      role="menuitem"
                      type="button"
                    >
                      <span className="prompt-input-menu-icon">
                        <BookOpen aria-hidden size={14} strokeWidth={1.75} />
                      </span>
                      <span className="prompt-input-menu-name">Skills</span>
                      <span className="prompt-input-menu-chevron">
                        <ChevronRight aria-hidden size={14} strokeWidth={1.75} />
                      </span>
                    </button>
                    {skillsOpen ? (
                      <div
                        className="prompt-input-menu-flyout-slot"
                        onPointerEnter={openSkillsMenu}
                      >
                        <div
                          aria-label="Skills"
                          className="prompt-input-menu-flyout"
                          id="prompt-input-skills-menu"
                          role="menu"
                        >
                          <PromptGlass />
                          {PROMPT_SKILLS.map((skill) => (
                            <button
                              className="prompt-input-menu-item"
                              key={skill.id}
                              onClick={() => addSkillFromMenu(skill.id)}
                              role="menuitem"
                              type="button"
                            >
                              <span className="prompt-input-menu-icon">
                                <PromptSkillIcon id={skill.id} />
                              </span>
                              <span className="prompt-input-menu-name">
                                {skill.name}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  </div>
                ) : null}
              </div>
              <ModelSelector
                disabled={enhancing || submitting}
                mode={selectedSkill === 'deep-research' ? 'deep-research' : undefined}
                onChange={onModelChange}
                value={modelId}
              />
            </div>

            <div className="prompt-input-right">
              {showNewChat ? (
                <button
                  aria-label="Start a new chat"
                  className="prompt-input-pill"
                  onClick={startNewChat}
                  type="button"
                >
                  <span>New Chat</span>
                </button>
              ) : null}
              {enhancing ? (
                <span
                  aria-label="Enhancing prompt"
                  className="prompt-input-icon-btn prompt-input-spinner-btn"
                >
                  <Loader2
                    aria-hidden
                    className="prompt-input-spinner"
                    size={14}
                  />
                </span>
              ) : showPill ? (
                <button
                  className="prompt-input-pill"
                  onClick={phase === 'enhanced' ? revert : () => void runEnhance()}
                  type="button"
                >
                  <span>{phase === 'enhanced' ? 'Revert' : 'Enhance Prompt'}</span>
                </button>
              ) : null}
              <button
                aria-label={submitting ? 'Stop response' : 'Send'}
                className="prompt-input-icon-btn prompt-input-send"
                data-active={canSubmit || submitting || undefined}
                disabled={submitting ? !onStop : !canSubmit}
                onClick={submitting ? onStop : () => submitPrompt()}
                type="button"
              >
                {submitting ? (
                  <Square aria-hidden fill="currentColor" size={8} strokeWidth={0} />
                ) : (
                  <ArrowUp aria-hidden size={14} strokeWidth={1.75} />
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
  )
}
