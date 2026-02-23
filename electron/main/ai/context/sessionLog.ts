import { randomUUID } from 'crypto'
import type { ChatMessage } from '../llm/types'

type SessionNodeRole = 'user' | 'assistant' | 'tool' | 'note'

interface SessionLogNode {
  id: string
  role: SessionNodeRole
  content: string
  createdAt: number
  tags: string[]
}

interface CheckoutRecord {
  id: string
  fromNodeId: string | null
  toNodeId: string
  summary: string
  createdAt: number
}

export interface SessionLogSnapshot {
  key: string
  headNodeId: string | null
  activeAnchorNodeId: string | null
  nodeCount: number
  tagCount: number
  checkoutCount: number
  segmentSize: number
  recentNodes: Array<{
    id: string
    role: SessionNodeRole
    preview: string
    tags: string[]
    createdAt: number
  }>
  checkouts: CheckoutRecord[]
}

interface UsageSnapshot {
  contextTokens: number
  contextWindow: number
  contextUsage: number
  totalUsage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

const MAX_PENDING_SYSTEM_NOTES = 8
const MAX_SESSION_LOG_INSTANCES = 256

function normalizeTag(tag: string): string {
  return tag.trim().replace(/\s+/g, '_').slice(0, 64)
}

function toPreview(content: string, maxLen: number = 120): string {
  const text = content.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}...`
}

export class AgentSessionLog {
  private readonly key: string
  private nodes: SessionLogNode[] = []
  private readonly tags = new Map<string, string>()
  private readonly checkouts: CheckoutRecord[] = []
  private readonly pendingSystemNotes: string[] = []
  private activeAnchorNodeId: string | null = null
  private bootstrapped = false
  private readonly maxNodes: number
  private readonly maxCheckouts: number

  constructor(key: string, maxNodes: number = 320, maxCheckouts: number = 64) {
    this.key = key
    this.maxNodes = maxNodes
    this.maxCheckouts = maxCheckouts
  }

  bootstrapFromHistoryIfEmpty(historyMessages: ChatMessage[]): void {
    if (this.bootstrapped || this.nodes.length > 0 || historyMessages.length === 0) {
      this.bootstrapped = true
      return
    }

    for (const message of historyMessages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue
      this.append(message.role, message.content)
    }
    this.bootstrapped = true
  }

  append(role: SessionNodeRole, content: string): SessionLogNode | null {
    const normalized = content.trim()
    if (!normalized) return null

    const node: SessionLogNode = {
      id: `ctx_${randomUUID()}`,
      role,
      content: normalized,
      createdAt: Date.now(),
      tags: [],
    }

    this.nodes.push(node)
    this.pruneOverflow()
    return node
  }

  getPromptHistory(limit: number = 48): ChatMessage[] {
    const conversationNodes = this.nodes.filter((node) => node.role === 'user' || node.role === 'assistant')

    let scoped = conversationNodes
    if (this.activeAnchorNodeId) {
      const anchorIndex = conversationNodes.findIndex((node) => node.id === this.activeAnchorNodeId)
      if (anchorIndex >= 0) {
        scoped = conversationNodes.slice(anchorIndex)
      }
    }

    if (limit > 0 && scoped.length > limit) {
      scoped = scoped.slice(-limit)
    }

    return scoped.map((node) => ({
      role: node.role === 'user' ? 'user' : 'assistant',
      content: node.content,
    }))
  }

  consumePendingSystemNotes(): string[] {
    if (this.pendingSystemNotes.length === 0) return []
    const notes = [...this.pendingSystemNotes]
    this.pendingSystemNotes.length = 0
    return notes
  }

  tag(tag: string, targetRef?: string, note?: string): { success: boolean; message: string; nodeId?: string } {
    const normalizedTag = normalizeTag(tag)
    if (!normalizedTag) {
      return { success: false, message: 'tag is required' }
    }

    const target = this.resolveTargetNode(targetRef)
    if (!target) {
      return { success: false, message: 'target node not found' }
    }

    if (!target.tags.includes(normalizedTag)) {
      target.tags.push(normalizedTag)
    }
    this.tags.set(normalizedTag, target.id)

    if (note?.trim()) {
      const noteContent = `Tag ${normalizedTag}: ${note.trim()}`
      this.append('note', noteContent)
    }

    return { success: true, message: `tag ${normalizedTag} -> ${target.id}`, nodeId: target.id }
  }

  checkout(
    targetRef: string,
    summary: string
  ): {
    success: boolean
    message: string
    fromNodeId?: string | null
    toNodeId?: string
  } {
    const target = this.resolveTargetNode(targetRef)
    if (!target) {
      return { success: false, message: 'target node not found' }
    }

    const compactSummary = summary.trim().slice(0, 800)
    if (!compactSummary) {
      return { success: false, message: 'summary is required' }
    }

    const fromNode = this.getHeadNode()
    const record: CheckoutRecord = {
      id: `jump_${randomUUID()}`,
      fromNodeId: fromNode?.id || null,
      toNodeId: target.id,
      summary: compactSummary,
      createdAt: Date.now(),
    }
    this.checkouts.push(record)
    if (this.checkouts.length > this.maxCheckouts) {
      this.checkouts.splice(0, this.checkouts.length - this.maxCheckouts)
    }

    this.activeAnchorNodeId = target.id
    this.pendingSystemNotes.push(
      `Context checkout applied. Anchor node: ${target.id}. Summary of previous branch: ${compactSummary}`
    )
    if (this.pendingSystemNotes.length > MAX_PENDING_SYSTEM_NOTES) {
      this.pendingSystemNotes.splice(0, this.pendingSystemNotes.length - MAX_PENDING_SYSTEM_NOTES)
    }
    this.append('note', `Checkout to ${target.id}: ${compactSummary}`)

    return {
      success: true,
      message: `checkout to ${target.id} will apply on next turn`,
      fromNodeId: fromNode?.id || null,
      toNodeId: target.id,
    }
  }

  getSnapshot(limit: number = 12): SessionLogSnapshot {
    const recent = this.nodes.slice(-Math.max(1, limit)).map((node) => ({
      id: node.id,
      role: node.role,
      preview: toPreview(node.content),
      tags: [...node.tags],
      createdAt: node.createdAt,
    }))

    return {
      key: this.key,
      headNodeId: this.getHeadNode()?.id || null,
      activeAnchorNodeId: this.activeAnchorNodeId,
      nodeCount: this.nodes.length,
      tagCount: this.tags.size,
      checkoutCount: this.checkouts.length,
      segmentSize: this.getSegmentSize(),
      recentNodes: recent,
      checkouts: this.checkouts.slice(-8),
    }
  }

  buildContextLogPayload(
    usage?: UsageSnapshot,
    limit: number = 12
  ): {
    dashboard: string
    snapshot: SessionLogSnapshot
  } {
    const snapshot = this.getSnapshot(limit)
    const usagePercent = usage ? Math.round(usage.contextUsage * 100) : null
    const usageText = usage
      ? `${usage.contextTokens}/${usage.contextWindow} (${usagePercent}%), total=${usage.totalUsage.totalTokens}`
      : 'n/a'

    const dashboard = [
      `context_key=${snapshot.key}`,
      `head=${snapshot.headNodeId || 'none'}`,
      `anchor=${snapshot.activeAnchorNodeId || 'none'}`,
      `nodes=${snapshot.nodeCount}, tags=${snapshot.tagCount}, checkouts=${snapshot.checkoutCount}`,
      `segment_since_last_tag=${snapshot.segmentSize}`,
      `usage=${usageText}`,
    ].join('\n')

    return { dashboard, snapshot }
  }

  private getHeadNode(): SessionLogNode | undefined {
    if (this.nodes.length === 0) return undefined
    return this.nodes[this.nodes.length - 1]
  }

  private resolveTargetNode(targetRef?: string): SessionLogNode | undefined {
    if (!targetRef?.trim()) {
      return this.getHeadNode()
    }

    const ref = targetRef.trim()
    const tagNodeId = this.tags.get(ref)
    if (tagNodeId) {
      const taggedNode = this.nodes.find((node) => node.id === tagNodeId)
      if (taggedNode) return taggedNode
    }

    return this.nodes.find((node) => node.id === ref || node.id.startsWith(ref))
  }

  private getSegmentSize(): number {
    if (this.nodes.length === 0) return 0

    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      if (this.nodes[i].tags.length > 0) {
        return this.nodes.length - i - 1
      }
    }
    return this.nodes.length
  }

  private pruneOverflow(): void {
    if (this.nodes.length <= this.maxNodes) return

    const removeCount = this.nodes.length - this.maxNodes
    const removed = this.nodes.splice(0, removeCount)
    if (removed.length === 0) return

    const removedIds = new Set(removed.map((node) => node.id))
    for (const [tag, nodeId] of this.tags.entries()) {
      if (removedIds.has(nodeId)) {
        this.tags.delete(tag)
      }
    }

    for (let i = this.checkouts.length - 1; i >= 0; i -= 1) {
      const checkout = this.checkouts[i]
      if (removedIds.has(checkout.toNodeId) || (checkout.fromNodeId ? removedIds.has(checkout.fromNodeId) : false)) {
        this.checkouts.splice(i, 1)
      }
    }

    if (this.activeAnchorNodeId && removedIds.has(this.activeAnchorNodeId)) {
      this.activeAnchorNodeId = this.nodes.find((node) => node.role === 'user' || node.role === 'assistant')?.id || null
    }
  }
}

const sessionLogs = new Map<string, AgentSessionLog>()

export function buildAgentSessionLogKey(sessionId: string, conversationId?: string): string {
  return `${sessionId}::${conversationId || 'draft'}`
}

export function getAgentSessionLog(sessionId: string, conversationId?: string): AgentSessionLog {
  const key = buildAgentSessionLogKey(sessionId, conversationId)
  const existing = sessionLogs.get(key)
  if (existing) return existing

  const created = new AgentSessionLog(key)
  sessionLogs.set(key, created)
  if (sessionLogs.size > MAX_SESSION_LOG_INSTANCES) {
    const staleKeys = [...sessionLogs.keys()].slice(0, sessionLogs.size - MAX_SESSION_LOG_INSTANCES)
    for (const staleKey of staleKeys) {
      sessionLogs.delete(staleKey)
    }
  }
  return created
}
