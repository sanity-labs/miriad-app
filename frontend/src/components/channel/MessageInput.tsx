import { useState, useCallback, useRef, useEffect, KeyboardEvent, useMemo } from 'react'
import {
  Send,
  Paperclip,
  AtSign,
  Bot,
  BotOff,
  Search,
  X,
  Loader2,
  Plus,
  Coffee,
  File as FileIcon,
  Image,
  FileText,
  FileCode,
  FileArchive,
  FileAudio,
  FileVideo,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { MentionAutocomplete, useMentionAutocomplete, type RosterAgent } from './MentionAutocomplete'
import { getSenderColor } from '../../utils'

/** Maximum file size for attachments (500 MB) */
const MAX_ATTACHMENT_SIZE = 500 * 1024 * 1024

interface StagedFile {
  id: string
  file: File
  preview?: string // Blob URL for image preview
  error?: string
}

interface MessageInputProps {
  onSend: (content: string, attachments?: File[]) => void
  disabled?: boolean
  placeholder?: string
  roster?: RosterAgent[]
  channelId?: string
  apiHost?: string
  onSummon?: () => void
  /** Set of callsigns for recently dismissed agents (to warn when mentioning) */
  dismissedAgents?: Set<string>
}

// localStorage key for message input drafts
const MESSAGE_DRAFT_KEY = 'miriad:messageDrafts'

interface MessageDraft {
  content: string
  cursorPosition: number
}

function getMessageDrafts(): Record<string, MessageDraft> {
  try {
    const stored = localStorage.getItem(MESSAGE_DRAFT_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

function saveMessageDraft(channelId: string, draft: MessageDraft): void {
  try {
    const drafts = getMessageDrafts()
    if (draft.content.trim()) {
      drafts[channelId] = draft
    } else {
      // Remove empty drafts
      delete drafts[channelId]
    }
    localStorage.setItem(MESSAGE_DRAFT_KEY, JSON.stringify(drafts))
  } catch {
    // Ignore storage errors
  }
}

function getMessageDraft(channelId: string): MessageDraft | null {
  try {
    const drafts = getMessageDrafts()
    return drafts[channelId] || null
  } catch {
    return null
  }
}

function clearMessageDraft(channelId: string): void {
  try {
    const drafts = getMessageDrafts()
    delete drafts[channelId]
    localStorage.setItem(MESSAGE_DRAFT_KEY, JSON.stringify(drafts))
  } catch {
    // Ignore storage errors
  }
}

// Slash commands configuration
const SLASH_COMMANDS = [
  { name: 'summon', description: 'Summon an agent to the channel', icon: Plus },
  { name: 'mute', description: 'Mute an agent', icon: BotOff },
  { name: 'unmute', description: 'Unmute an agent', icon: Bot },
  { name: 'mute-all', description: 'Mute all agents', icon: BotOff },
  { name: 'unmute-all', description: 'Unmute all agents', icon: Bot },
]

export function MessageInput({
  onSend,
  disabled,
  placeholder = 'Type a message...',
  roster = [],
  channelId,
  apiHost,
  onSummon,
  dismissedAgents = new Set(),
}: MessageInputProps) {
  const [content, setContent] = useState('')
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [autocompleteQuery, setAutocompleteQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mentionStart, setMentionStart] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Slash command state
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const slashMenuRef = useRef<HTMLDivElement>(null)

  // Agent action picker state (for /pause and /resume commands)
  const [showAgentPicker, setShowAgentPicker] = useState<'pause' | 'resume' | null>(null)
  const [agentPickerQuery, setAgentPickerQuery] = useState('')
  const [agentPickerIndex, setAgentPickerIndex] = useState(0)
  const [agentActionLoading, setAgentActionLoading] = useState(false)

  // Loading state for resume actions in dormant dialog
  const [dormantActionLoading, setDormantActionLoading] = useState<string | null>(null)
  // Loading state for re-summon actions for dismissed agents
  const [summonActionLoading, setSummonActionLoading] = useState<string | null>(null)

  // File attachment state
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { findMentionTrigger, getOptionsCount, getOptionAtIndex } = useMentionAutocomplete(roster)

  // Track previous channelId to save draft before switching
  const prevChannelIdRef = useRef<string | undefined>(channelId)

  // Load/save draft on channel switch
  useEffect(() => {
    const prevChannelId = prevChannelIdRef.current

    // Save draft for previous channel (if there was content)
    if (prevChannelId && prevChannelId !== channelId) {
      const cursorPos = textareaRef.current?.selectionStart ?? content.length
      saveMessageDraft(prevChannelId, { content, cursorPosition: cursorPos })
    }

    // Load draft for new channel
    if (channelId) {
      const draft = getMessageDraft(channelId)
      if (draft) {
        setContent(draft.content)
        // Restore cursor position after content is set
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.setSelectionRange(draft.cursorPosition, draft.cursorPosition)
          }
        })
      } else {
        setContent('')
      }
    } else {
      setContent('')
    }

    // Reset UI state on channel switch
    setShowAutocomplete(false)
    setShowSlashMenu(false)
    setShowAgentPicker(null)

    prevChannelIdRef.current = channelId
  }, [channelId]) // Note: intentionally not including 'content' to avoid infinite loop

  // Agents that can be paused (online and not paused)
  const pausableAgents = useMemo(() =>
    roster.filter(a => a.isOnline && !a.isPaused),
    [roster]
  )

  // Agents that can be resumed (paused)
  const resumableAgents = useMemo(() =>
    roster.filter(a => a.isPaused),
    [roster]
  )

  // Filter agents for picker based on query
  const getFilteredPickerAgents = useCallback((action: 'pause' | 'resume', query: string) => {
    const agents = action === 'pause' ? pausableAgents : resumableAgents
    if (!query) return agents
    return agents.filter(a => a.callsign.toLowerCase().includes(query.toLowerCase()))
  }, [pausableAgents, resumableAgents])

  // Extract the last @mention from content (for auto-mention after send)
  const extractLastMention = useCallback((text: string): string => {
    const mentions = text.match(/@(\w+)/g)
    if (!mentions) return ''
    // Find the last mention that isn't @channel
    for (let i = mentions.length - 1; i >= 0; i--) {
      if (mentions[i] !== '@channel') return mentions[i] + ' '
    }
    return ''
  }, [])

  // Extract @mentions from content
  const mentionedCallsigns = useMemo(() => {
    const mentionRegex = /@(\w+)/g
    const mentions: string[] = []
    let match
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1])
    }
    return mentions
  }, [content])

  // Paused agents mentioned in current content
  const dormantAgents = useMemo(() => {
    // Only include paused roster agents
    return roster.filter(a => a.isPaused && mentionedCallsigns.includes(a.callsign))
  }, [mentionedCallsigns, roster])

  // Dismissed agents mentioned in current content
  const mentionedDismissedAgents = useMemo(() => {
    return mentionedCallsigns.filter(callsign => dismissedAgents.has(callsign))
  }, [mentionedCallsigns, dismissedAgents])

  // Handle resume action for paused agent from dormant dialog
  const handleResumeDormant = useCallback(async (callsign: string) => {
    if (!apiHost || !channelId) return
    setDormantActionLoading(callsign)
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${callsign}/resume`,
        { method: 'POST', credentials: 'include' }
      )
      const data = await response.json()
      if (!response.ok) {
        console.error('Failed to resume agent:', data.error || response.status)
      }
    } catch (err) {
      console.error('Failed to resume agent:', err)
    } finally {
      setDormantActionLoading(null)
    }
  }, [apiHost, channelId])

  // Handle re-summon action for dismissed (archived) agent
  const handleResummonDismissed = useCallback(async (callsign: string) => {
    if (!apiHost || !channelId) return
    setSummonActionLoading(callsign)
    try {
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${callsign}/unarchive`,
        { method: 'POST', credentials: 'include' }
      )
      const data = await response.json()
      if (!response.ok) {
        console.error('Failed to re-summon agent:', data.error || response.status)
      }
    } catch (err) {
      console.error('Failed to re-summon agent:', err)
    } finally {
      setSummonActionLoading(null)
    }
  }, [apiHost, channelId])

  // Handle pause/resume action from agent picker
  const handleAgentAction = useCallback(async (action: 'pause' | 'resume', callsign: string) => {
    if (!apiHost || !channelId) return
    setAgentActionLoading(true)
    try {
      const endpoint = action === 'pause' ? 'pause' : 'resume'
      const response = await fetch(
        `${apiHost}/channels/${channelId}/agents/${callsign}/${endpoint}`,
        { method: 'POST' }
      )
      const data = await response.json()
      if (!response.ok) {
        console.error(`Failed to ${action} agent:`, data.error || response.status)
      }
    } catch (err) {
      console.error(`Failed to ${action} agent:`, err)
    } finally {
      setAgentActionLoading(false)
      setShowAgentPicker(null)
      setAgentPickerQuery('')
      setAgentPickerIndex(0)
    }
  }, [apiHost, channelId])

  // Handle bulk pause/resume actions
  const handleBulkAgentAction = useCallback(async (action: 'pause-all' | 'resume-all') => {
    if (!apiHost || !channelId) return
    const agents = action === 'pause-all' ? pausableAgents : resumableAgents
    const endpoint = action === 'pause-all' ? 'pause' : 'resume'

    await Promise.all(
      agents.map(async (agent) => {
        try {
          await fetch(
            `${apiHost}/channels/${channelId}/agents/${agent.callsign}/${endpoint}`,
            { method: 'POST' }
          )
        } catch (err) {
          console.error(`Failed to ${endpoint} agent ${agent.callsign}:`, err)
        }
      })
    )
  }, [apiHost, channelId, pausableAgents, resumableAgents])

  // File attachment handlers
  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files)
    const newStagedFiles: StagedFile[] = []

    for (const file of fileArray) {
      // Validate file size
      if (file.size > MAX_ATTACHMENT_SIZE) {
        newStagedFiles.push({
          id: crypto.randomUUID(),
          file,
          error: `File exceeds ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB limit`,
        })
        continue
      }

      const stagedFile: StagedFile = {
        id: crypto.randomUUID(),
        file,
      }

      // Create preview for images
      if (file.type.startsWith('image/')) {
        stagedFile.preview = URL.createObjectURL(file)
      }

      newStagedFiles.push(stagedFile)
    }

    setStagedFiles(prev => [...prev, ...newStagedFiles])
  }, [])

  const removeFile = useCallback((id: string) => {
    setStagedFiles(prev => {
      const file = prev.find(f => f.id === id)
      // Revoke blob URL to prevent memory leak
      if (file?.preview) {
        URL.revokeObjectURL(file.preview)
      }
      return prev.filter(f => f.id !== id)
    })
  }, [])

  const clearFiles = useCallback(() => {
    // Revoke all blob URLs
    stagedFiles.forEach(f => {
      if (f.preview) URL.revokeObjectURL(f.preview)
    })
    setStagedFiles([])
  }, [stagedFiles])

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      stagedFiles.forEach(f => {
        if (f.preview) URL.revokeObjectURL(f.preview)
      })
    }
  }, []) // Only on unmount

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files)
    }
    // Reset input so same file can be selected again
    e.target.value = ''
  }, [addFiles])

  const handlePaperclipClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set false if we're leaving the container (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  // Paste handler for clipboard images/files
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) {
          // Generate a name for pasted images (they often have generic names like "image.png")
          if (file.type.startsWith('image/') && file.name === 'image.png') {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const ext = file.type.split('/')[1] || 'png'
            const renamedFile = new File([file], `pasted-image-${timestamp}.${ext}`, { type: file.type })
            files.push(renamedFile)
          } else {
            files.push(file)
          }
        }
      }
    }

    if (files.length > 0) {
      // Don't prevent default if no files - let text paste through
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  // Filter slash commands based on query
  const filteredCommands = useMemo(() => {
    if (!slashQuery) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(cmd =>
      cmd.name.toLowerCase().includes(slashQuery.toLowerCase())
    )
  }, [slashQuery])

  // Execute slash command
  const executeSlashCommand = useCallback((command: string) => {
    setShowSlashMenu(false)
    setSlashQuery('')
    setContent('')

    if (command === 'summon') {
      onSummon?.()
    } else if (command === 'mute') {
      if (pausableAgents.length > 0) {
        setShowAgentPicker('pause')
      }
    } else if (command === 'unmute') {
      if (resumableAgents.length > 0) {
        setShowAgentPicker('resume')
      }
    } else if (command === 'mute-all') {
      handleBulkAgentAction('pause-all')
    } else if (command === 'unmute-all') {
      handleBulkAgentAction('resume-all')
    }
  }, [onSummon, pausableAgents, resumableAgents, handleBulkAgentAction])

  const handleSubmit = useCallback(() => {
    const trimmed = content.trim()
    const validFiles = stagedFiles.filter(f => !f.error).map(f => f.file)

    // Need either text or files to send
    if (!trimmed && validFiles.length === 0) return

    // Extract last @mention for auto-mention after send
    const lastMention = extractLastMention(trimmed)

    onSend(trimmed, validFiles.length > 0 ? validFiles : undefined)
    setContent(lastMention)
    setShowAutocomplete(false)
    setShowSlashMenu(false)
    clearFiles()

    // Clear draft after sending
    if (channelId) {
      clearMessageDraft(channelId)
    }
  }, [content, stagedFiles, onSend, extractLastMention, channelId, clearFiles])

  // Insert mention at the trigger position
  const insertMention = useCallback((mention: string) => {
    const before = content.slice(0, mentionStart)
    const after = content.slice(textareaRef.current?.selectionStart ?? content.length)
    const newContent = `${before}@${mention} ${after}`
    setContent(newContent)
    setShowAutocomplete(false)

    // Focus and set cursor position after the inserted mention
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const newPos = mentionStart + mention.length + 2 // +2 for @ and space
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newPos, newPos)
      }
    })
  }, [content, mentionStart])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Handle agent picker navigation
      if (showAgentPicker) {
        const agents = getFilteredPickerAgents(showAgentPicker, agentPickerQuery)

        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setAgentPickerIndex((prev) => (prev + 1) % agents.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setAgentPickerIndex((prev) => (prev - 1 + agents.length) % agents.length)
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          const selected = agents[agentPickerIndex]
          if (selected) {
            handleAgentAction(showAgentPicker, selected.callsign)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowAgentPicker(null)
          setAgentPickerQuery('')
          setAgentPickerIndex(0)
          return
        }
        return
      }

      // Handle slash menu navigation
      if (showSlashMenu) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const selected = filteredCommands[slashSelectedIndex]
          if (selected) {
            executeSlashCommand(selected.name)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowSlashMenu(false)
          return
        }
      }

      // Handle autocomplete navigation
      if (showAutocomplete) {
        const optionsCount = getOptionsCount(autocompleteQuery)

        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % optionsCount)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + optionsCount) % optionsCount)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const selected = getOptionAtIndex(autocompleteQuery, selectedIndex)
          if (selected) {
            insertMention(selected)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowAutocomplete(false)
          return
        }
      }

      // Submit on Enter (without Shift) when no menus are showing
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [
      showAgentPicker, agentPickerQuery, agentPickerIndex, getFilteredPickerAgents, handleAgentAction,
      showSlashMenu, filteredCommands, slashSelectedIndex, executeSlashCommand,
      showAutocomplete, autocompleteQuery, selectedIndex, getOptionsCount, getOptionAtIndex,
      insertMention, handleSubmit
    ]
  )

  // Handle input changes and detect triggers
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value
      const cursorPos = e.target.selectionStart

      setContent(newContent)

      // Check for slash command trigger at start of input
      if (newContent.startsWith('/')) {
        const query = newContent.slice(1)
        // Only show slash menu if no space yet (still typing command)
        if (!query.includes(' ')) {
          setShowSlashMenu(true)
          setSlashQuery(query)
          setSlashSelectedIndex(0)
          setShowAutocomplete(false)
          return
        }
      }
      setShowSlashMenu(false)

      // Check for mention trigger
      const trigger = findMentionTrigger(newContent, cursorPos)
      if (trigger) {
        setShowAutocomplete(true)
        setAutocompleteQuery(trigger.query)
        setMentionStart(trigger.start)
        setSelectedIndex(0)
      } else {
        setShowAutocomplete(false)
      }
    },
    [findMentionTrigger]
  )

  // Handle @ button click
  const handleAtButtonClick = useCallback(() => {
    if (textareaRef.current) {
      const cursorPos = textareaRef.current.selectionStart
      const before = content.slice(0, cursorPos)
      const after = content.slice(cursorPos)
      const newContent = `${before}@${after}`
      setContent(newContent)
      setMentionStart(cursorPos)
      setAutocompleteQuery('')
      setSelectedIndex(0)
      setShowAutocomplete(true)

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(cursorPos + 1, cursorPos + 1)
        }
      })
    }
  }, [content])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [content])

  // Save draft on blur
  const handleBlur = useCallback(() => {
    if (channelId) {
      const cursorPos = textareaRef.current?.selectionStart ?? content.length
      saveMessageDraft(channelId, { content, cursorPosition: cursorPos })
    }
  }, [channelId, content])

  // Debounced save on content change (every 1 second of typing pause)
  useEffect(() => {
    if (!channelId) return

    const timeoutId = setTimeout(() => {
      const cursorPos = textareaRef.current?.selectionStart ?? content.length
      saveMessageDraft(channelId, { content, cursorPosition: cursorPos })
    }, 1000)

    return () => clearTimeout(timeoutId)
  }, [channelId, content])

  // Save draft before page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (channelId && content.trim()) {
        const cursorPos = textareaRef.current?.selectionStart ?? content.length
        saveMessageDraft(channelId, { content, cursorPosition: cursorPos })
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [channelId, content])

  // Update agent picker query when typing in picker mode
  useEffect(() => {
    if (showAgentPicker) {
      setAgentPickerQuery(content)
      setAgentPickerIndex(0)
    }
  }, [content, showAgentPicker])

  // Close slash menu on click outside
  useEffect(() => {
    if (!showSlashMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) {
        setShowSlashMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSlashMenu])

  // Calculate autocomplete position (above the textarea)
  const getAutocompletePosition = () => {
    return { top: 8, left: 16 }
  }

  return (
    <div className="px-4 pt-0 pb-4 bg-card">
      <div className="relative">
        {/* Slash command menu */}
        {showSlashMenu && filteredCommands.length > 0 && (
          <div
            ref={slashMenuRef}
            className="absolute z-50 bg-card border border-[var(--cast-border-default)] shadow-sm py-1 min-w-[180px] max-h-[200px] overflow-y-auto"
            style={{ bottom: 8, left: 16 }}
          >
            {filteredCommands.map((cmd, index) => {
              const Icon = cmd.icon
              return (
                <button
                  key={cmd.name}
                  data-selected={index === slashSelectedIndex}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-base text-left",
                    "hover:bg-[var(--cast-bg-secondary)] transition-colors",
                    index === slashSelectedIndex && "bg-[var(--cast-bg-secondary)]"
                  )}
                  onClick={() => executeSlashCommand(cmd.name)}
                >
                  <Icon className="w-4 h-4 text-[var(--cast-text-muted)]" />
                  <span className="font-medium text-[var(--cast-text-primary)]">{cmd.name}</span>
                  <span className="text-[var(--cast-text-muted)] text-xs ml-auto">{cmd.description}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Agent action picker (for /pause and /resume) */}
        {showAgentPicker && (
          <AgentActionPicker
            action={showAgentPicker}
            agents={getFilteredPickerAgents(showAgentPicker, agentPickerQuery)}
            allAgents={showAgentPicker === 'pause' ? pausableAgents : resumableAgents}
            selectedIndex={agentPickerIndex}
            query={agentPickerQuery}
            loading={agentActionLoading}
            onQueryChange={(q) => {
              setAgentPickerQuery(q)
              setAgentPickerIndex(0)
            }}
            onSelectAgent={(callsign) => handleAgentAction(showAgentPicker, callsign)}
            onClose={() => {
              setShowAgentPicker(null)
              setAgentPickerQuery('')
              setAgentPickerIndex(0)
            }}
          />
        )}

        {/* Mention autocomplete */}
        {showAutocomplete && !showAgentPicker && (
          <MentionAutocomplete
            query={autocompleteQuery}
            roster={roster}
            selectedIndex={selectedIndex}
            onSelect={insertMention}
            onClose={() => setShowAutocomplete(false)}
            position={getAutocompletePosition()}
            channelId={channelId}
          />
        )}

        {/* Dormant/dismissed agents notice - superimposed over roster area */}
        {(dormantAgents.length > 0 || mentionedDismissedAgents.length > 0) && !showAgentPicker && !showSlashMenu && (
          <div
            className="absolute z-40 bg-card border border-border rounded-lg shadow-sm px-3 py-2 text-base"
            style={{ bottom: '100%', left: 0, marginBottom: 8 }}
          >
            <div className="flex items-center gap-2 flex-wrap">
              {/* Muted agents section */}
              {dormantAgents.length > 0 && (
                <>
                  <span className="text-muted-foreground">Muted:</span>
                  {dormantAgents.map((agent) => (
                    <span key={agent.callsign} className="flex items-center gap-1">
                      <span className={cn("font-medium", getSenderColor(agent.callsign))}>
                        @{agent.callsign}
                      </span>
                      <button
                        onClick={() => handleResumeDormant(agent.callsign)}
                        disabled={dormantActionLoading === agent.callsign}
                        className={cn(
                          "p-0.5 rounded hover:bg-secondary/50 transition-colors",
                          dormantActionLoading === agent.callsign && "opacity-50 cursor-not-allowed"
                        )}
                        title="Unmute agent"
                      >
                        {dormantActionLoading === agent.callsign ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <Coffee className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </span>
                  ))}
                </>
              )}
              {/* Separator if both sections present */}
              {dormantAgents.length > 0 && mentionedDismissedAgents.length > 0 && (
                <span className="text-muted-foreground mx-1">·</span>
              )}
              {/* Dismissed agents section */}
              {mentionedDismissedAgents.length > 0 && (
                <>
                  <span className="text-muted-foreground">Dismissed:</span>
                  {mentionedDismissedAgents.map((callsign) => (
                    <span key={callsign} className="flex items-center gap-1">
                      <span className={cn("font-medium", getSenderColor(callsign))}>
                        @{callsign}
                      </span>
                      <button
                        onClick={() => handleResummonDismissed(callsign)}
                        disabled={summonActionLoading === callsign}
                        className={cn(
                          "p-0.5 rounded hover:bg-secondary/50 transition-colors",
                          summonActionLoading === callsign && "opacity-50 cursor-not-allowed"
                        )}
                        title="Re-summon agent"
                      >
                        {summonActionLoading === callsign ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <Coffee className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </span>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />

        {/* Input box container with drag-drop */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "border transition-colors",
            isDragOver
              ? "border-primary bg-primary/5"
              : "border-[var(--cast-border-default)] focus-within:border-[var(--cast-text-primary)]"
          )}
        >
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={handleBlur}
            placeholder={showAgentPicker
              ? `Type to filter ${showAgentPicker === 'pause' ? 'active' : 'paused'} agents...`
              : placeholder
            }
            disabled={disabled}
            rows={1}
            className={cn(
              "w-full min-h-[44px] max-h-[200px] resize-none p-3",
              "bg-transparent border-none",
              "text-base text-foreground placeholder:text-[#a0a0a0]",
              "focus:outline-none focus:ring-0",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          />

          {/* Staged files display */}
          {stagedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pb-2">
              {stagedFiles.map((staged) => (
                <StagedFileChip
                  key={staged.id}
                  staged={staged}
                  onRemove={() => removeFile(staged.id)}
                />
              ))}
            </div>
          )}
          {/* Input actions row */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--cast-border-default)]">
            {/* Left side buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePaperclipClick}
                className="p-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors"
                title="Attach file"
              >
                <Paperclip className="w-[18px] h-[18px]" />
              </button>
              <button
                type="button"
                onClick={handleAtButtonClick}
                className="p-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors"
                title="Mention"
              >
                <AtSign className="w-[18px] h-[18px]" />
              </button>
              <button
                type="button"
                onClick={onSummon}
                className="flex items-center gap-1 px-1 text-[#8c8c8c] hover:text-[#1a1a1a] transition-colors text-base"
                title="Summon agent"
              >
                <Plus className="w-[18px] h-[18px]" />
                <span>Summon</span>
              </button>
            </div>
            {/* Send button */}
            <button
              onClick={handleSubmit}
              disabled={disabled || (!content.trim() && stagedFiles.filter(f => !f.error).length === 0)}
              className={cn(
                "p-1 transition-colors",
                (content.trim() || stagedFiles.filter(f => !f.error).length > 0) && !disabled
                  ? "text-[#8c8c8c] hover:text-[#1a1a1a]"
                  : "text-[#c0c0c0] cursor-not-allowed"
              )}
              title="Send message"
            >
              <Send className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Helper to get icon for file type
function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image
  if (mimeType.startsWith('video/')) return FileVideo
  if (mimeType.startsWith('audio/')) return FileAudio
  if (mimeType.includes('pdf')) return FileText
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return FileArchive
  if (mimeType.includes('javascript') || mimeType.includes('typescript') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('html') || mimeType.includes('css')) return FileCode
  if (mimeType.includes('text')) return FileText
  return FileIcon
}

// Staged file chip component
function StagedFileChip({ staged, onRemove }: { staged: StagedFile; onRemove: () => void }) {
  const Icon = getFileIcon(staged.file.type)
  const isImage = staged.file.type.startsWith('image/')

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded text-sm",
        staged.error
          ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
          : "bg-[var(--cast-bg-secondary)] text-[var(--cast-text-secondary)]"
      )}
    >
      {isImage && staged.preview ? (
        <img
          src={staged.preview}
          alt={staged.file.name}
          className="w-5 h-5 object-cover rounded"
        />
      ) : (
        <Icon className="w-4 h-4 flex-shrink-0" />
      )}
      <span className="truncate max-w-[120px]" title={staged.file.name}>
        {staged.file.name}
      </span>
      {staged.error && (
        <span className="text-xs truncate max-w-[100px]" title={staged.error}>
          ({staged.error})
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="p-0.5 hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors"
        title="Remove file"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// Agent action picker component for /pause and /resume commands
interface AgentActionPickerProps {
  action: 'pause' | 'resume'
  agents: RosterAgent[]
  allAgents: RosterAgent[]
  selectedIndex: number
  query: string
  loading: boolean
  onQueryChange: (query: string) => void
  onSelectAgent: (callsign: string) => void
  onClose: () => void
}

function AgentActionPicker({
  action,
  agents,
  allAgents,
  selectedIndex,
  query,
  loading,
  onQueryChange,
  onSelectAgent,
  onClose,
}: AgentActionPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Scroll selected item into view
  useEffect(() => {
    const selected = containerRef.current?.querySelector('[data-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // Handled by parent
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      // Handled by parent
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const selected = agents[selectedIndex]
      if (selected) {
        onSelectAgent(selected.callsign)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      ref={containerRef}
      className="absolute z-50 bg-card border border-border rounded-lg shadow-lg min-w-[280px] max-h-[300px] overflow-hidden"
      style={{ bottom: 8, left: 16 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-base font-medium">
          {action === 'pause' ? 'Pause Agent' : 'Resume Agent'}
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-secondary/50 transition-colors"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Search input */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 px-2 py-1.5 bg-secondary/30 rounded">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Search ${action === 'pause' ? 'active' : 'paused'} agents...`}
            className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* Agent list */}
      <div className="max-h-[180px] overflow-y-auto py-1">
        {agents.length === 0 ? (
          <div className="px-3 py-4 text-center text-base text-muted-foreground">
            {allAgents.length === 0
              ? `No ${action === 'pause' ? 'active' : 'paused'} agents`
              : 'No matching agents'
            }
          </div>
        ) : (
          agents.map((agent, index) => (
            <button
              key={agent.callsign}
              data-selected={index === selectedIndex}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-base text-left",
                "hover:bg-secondary/50 transition-colors",
                index === selectedIndex && "bg-secondary"
              )}
              onClick={() => onSelectAgent(agent.callsign)}
              disabled={loading}
            >
              <span className={cn(
                "w-2 h-2 rounded-full",
                agent.isPaused ? "bg-gray-400" : "bg-green-500"
              )} />
              <span className={cn("font-medium", getSenderColor(agent.callsign))}>
                {agent.callsign}
              </span>
              <span className="text-muted-foreground text-xs ml-auto">
                {agent.isPaused ? 'paused' : 'active'}
              </span>
              {loading && index === selectedIndex && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              )}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
