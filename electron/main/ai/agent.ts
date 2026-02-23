/**
 * AI Agent 执行器
 * 处理 Function Calling 循环，支持多轮工具调用
 */

import type { ChatMessage, ChatOptions, ToolCall } from './llm/types'
import { chatStream } from './llm'
import { getAllToolDefinitions, executeToolCalls } from './tools'
import type { ToolContext, OwnerInfo } from './tools/types'
import { aiLogger } from './logger'
import { randomUUID } from 'crypto'
import { t as i18nT } from '../i18n'
import {
  Agent as PiAgentCore,
  type AgentEvent as PiAgentEvent,
  type AgentTool as PiAgentTool,
} from '@mariozechner/pi-agent-core'
import {
  EventStream as PiEventStream,
  Type as PiType,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent as PiAssistantMessageEvent,
  type AssistantMessageEventStream as PiAssistantMessageEventStream,
  type Context as PiContext,
  type Message as PiMessage,
  type Model as PiModel,
  type StopReason as PiStopReason,
  type Tool as PiToolSchema,
  type ToolCall as PiToolCall,
  type Usage as PiUsage,
} from '@mariozechner/pi-ai'
import { getAgentSessionLog, type AgentSessionLog } from './context/sessionLog'

// 思考类标签列表（可按需扩展）
const THINK_TAGS = ['think', 'analysis', 'reasoning', 'reflection', 'thought', 'thinking']
const THINK_START_TAGS = THINK_TAGS.map((tag) => `<${tag}>`)
const TOOL_CALL_START_TAG = '<tool_call>'
const TOOL_CALL_END_TAG = '</tool_call>'

// ==================== Fallback 解析器 ====================

/**
 * 从文本内容中提取思考类标签内容
 */
function extractThinkingContent(content: string): { thinking: string; cleanContent: string } {
  if (!content) {
    return { thinking: '', cleanContent: '' }
  }

  const tagPattern = THINK_TAGS.join('|')
  const thinkRegex = new RegExp(`<(${tagPattern})>([\\s\\S]*?)<\\/\\1>`, 'gi')
  const thinkingParts: string[] = []
  let cleanContent = content

  const matches = content.matchAll(thinkRegex)
  for (const match of matches) {
    const thinkText = match[2].trim()
    if (thinkText) {
      thinkingParts.push(thinkText)
    }
    cleanContent = cleanContent.replace(match[0], '')
  }

  return { thinking: thinkingParts.join('\n').trim(), cleanContent: cleanContent.trim() }
}

/**
 * 从文本内容中解析 <tool_call> 标签并转换为标准 ToolCall 格式
 */
function parseToolCallTags(content: string): ToolCall[] | null {
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  const toolCalls: ToolCall[] = []

  const matches = content.matchAll(toolCallRegex)
  for (const match of matches) {
    try {
      const jsonStr = match[1].trim()
      const parsed = JSON.parse(jsonStr)

      if (parsed.name && parsed.arguments) {
        toolCalls.push({
          id: `fallback-${randomUUID()}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments),
          },
        })
      }
    } catch (e) {
      aiLogger.warn('Agent', 'Failed to parse tool_call tag', { content: match[1], error: String(e) })
    }
  }

  return toolCalls.length > 0 ? toolCalls : null
}

/**
 * 检测内容是否包含工具调用标签（用于判断是否需要 fallback 解析）
 */
function hasToolCallTags(content: string): boolean {
  return /<tool_call>/i.test(content)
}

/**
 * 清理 <tool_call> 标签内容，避免将工具调用文本展示给用户
 */
function stripToolCallTags(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
}

type StreamMode = 'text' | 'think' | 'tool_call'

/**
 * 创建流式解析器：将文本按 content/think/tool_call 分流
 */
function createStreamParser(handlers: {
  onText: (text: string) => void
  onThink: (text: string, tag: string) => void
  onThinkStart?: (tag: string) => void
  onThinkEnd?: (tag: string) => void
}): { push: (text: string) => void; flush: () => void } {
  let buffer = ''
  let mode: StreamMode = 'text'
  let currentThinkTag = ''

  const startTags = [...THINK_START_TAGS, TOOL_CALL_START_TAG]
  const startTagsLower = startTags.map((tag) => tag.toLowerCase())
  const toolCallStartLower = TOOL_CALL_START_TAG.toLowerCase()
  const toolCallEndLower = TOOL_CALL_END_TAG.toLowerCase()
  const maxStartTagLength = Math.max(...startTags.map((tag) => tag.length))

  const findNextTagIndex = (lowerBuffer: string): { index: number; tag: string } | null => {
    let hitIndex = -1
    let hitTag = ''
    for (const tag of startTagsLower) {
      const index = lowerBuffer.indexOf(tag)
      if (index !== -1 && (hitIndex === -1 || index < hitIndex)) {
        hitIndex = index
        hitTag = tag
      }
    }
    return hitIndex === -1 ? null : { index: hitIndex, tag: hitTag }
  }

  const emitText = (text: string) => {
    if (text) {
      handlers.onText(text)
    }
  }

  const emitThink = (text: string) => {
    if (text) {
      handlers.onThink(text, currentThinkTag || 'think')
    }
  }

  const processBuffer = () => {
    let safety = 0
    while (buffer && safety < 10000) {
      safety += 1
      if (mode === 'text') {
        const lowerBuffer = buffer.toLowerCase()
        const hit = findNextTagIndex(lowerBuffer)
        if (!hit) {
          // 保留一段尾部，避免标签被截断
          const keepLength = Math.max(1, maxStartTagLength - 1)
          if (buffer.length > keepLength) {
            emitText(buffer.slice(0, buffer.length - keepLength))
            buffer = buffer.slice(buffer.length - keepLength)
          }
          break
        }

        if (hit.index > 0) {
          emitText(buffer.slice(0, hit.index))
          buffer = buffer.slice(hit.index)
        }

        const lowerHead = buffer.toLowerCase()
        if (lowerHead.startsWith(hit.tag)) {
          if (hit.tag === toolCallStartLower) {
            mode = 'tool_call'
            buffer = buffer.slice(TOOL_CALL_START_TAG.length)
            continue
          }

          // 进入思考模式
          currentThinkTag = hit.tag.slice(1, -1)
          mode = 'think'
          handlers.onThinkStart?.(currentThinkTag)
          buffer = buffer.slice(startTags[startTagsLower.indexOf(hit.tag)].length)
          continue
        }

        // 未识别的 < 视为普通文本
        emitText(buffer.slice(0, 1))
        buffer = buffer.slice(1)
        continue
      }

      if (mode === 'think') {
        const endTag = `</${currentThinkTag}>`
        const lowerBuffer = buffer.toLowerCase()
        const endIndex = lowerBuffer.indexOf(endTag)
        if (endIndex === -1) {
          const keepLength = Math.max(1, endTag.length - 1)
          if (buffer.length > keepLength) {
            emitThink(buffer.slice(0, buffer.length - keepLength))
            buffer = buffer.slice(buffer.length - keepLength)
          }
          break
        }

        if (endIndex > 0) {
          emitThink(buffer.slice(0, endIndex))
        }

        buffer = buffer.slice(endIndex + endTag.length)
        mode = 'text'
        handlers.onThinkEnd?.(currentThinkTag)
        currentThinkTag = ''
        continue
      }

      if (mode === 'tool_call') {
        const lowerBuffer = buffer.toLowerCase()
        const endIndex = lowerBuffer.indexOf(toolCallEndLower)
        if (endIndex === -1) {
          const keepLength = Math.max(1, TOOL_CALL_END_TAG.length - 1)
          if (buffer.length > keepLength) {
            buffer = buffer.slice(buffer.length - keepLength)
          }
          break
        }

        buffer = buffer.slice(endIndex + TOOL_CALL_END_TAG.length)
        mode = 'text'
        continue
      }
    }
  }

  return {
    push(text: string) {
      if (!text) return
      buffer += text
      processBuffer()
    },
    flush() {
      if (!buffer) return
      if (mode === 'text') {
        emitText(buffer)
      } else if (mode === 'think') {
        emitThink(buffer)
      }
      buffer = ''
    },
  }
}

/**
 * Agent 配置
 */
export interface AgentConfig {
  /** 最大工具调用轮数（防止无限循环） */
  maxToolRounds?: number
  /** 注入模型的历史消息上限（user+assistant） */
  contextHistoryLimit?: number
  /** LLM 选项 */
  llmOptions?: ChatOptions
  /** 中止信号，用于取消执行 */
  abortSignal?: AbortSignal
}

/**
 * Token 使用量
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * Agent 运行状态（用于前端状态栏展示）
 */
export interface AgentRuntimeStatus {
  /** 当前阶段 */
  phase: 'preparing' | 'thinking' | 'tool_running' | 'responding' | 'completed' | 'aborted' | 'error'
  /** 当前工具调用轮次 */
  round: number
  /** 累计调用工具次数 */
  toolsUsed: number
  /** 当前执行中的工具 */
  currentTool?: string
  /** 当前上下文 Token 估算值 */
  contextTokens: number
  /** 模型上下文窗口 */
  contextWindow: number
  /** 上下文占用比例（0-1） */
  contextUsage: number
  /** 当前运行累计 Token 使用量 */
  totalUsage: TokenUsage
  /** SessionLog 中的节点总数 */
  nodeCount: number
  /** SessionLog 中的标签数量 */
  tagCount: number
  /** 距离最近标签的步数 */
  segmentSize: number
  /** checkout 记录数量 */
  checkoutCount: number
  /** 当前锚点节点 ID */
  activeAnchorNodeId?: string | null
  /** 状态更新时间（毫秒时间戳） */
  updatedAt: number
}

/**
 * Agent 流式响应 chunk
 */
export interface AgentStreamChunk {
  /** chunk 类型 */
  type: 'content' | 'think' | 'tool_start' | 'tool_result' | 'status' | 'done' | 'error'
  /** 文本内容（type=content 时） */
  content?: string
  /** 思考标签名称（type=think 时） */
  thinkTag?: string
  /** 思考耗时（毫秒，type=think 时可选） */
  thinkDurationMs?: number
  /** 工具名称（type=tool_start/tool_result 时） */
  toolName?: string
  /** 工具调用参数（type=tool_start 时） */
  toolParams?: Record<string, unknown>
  /** 工具执行结果（type=tool_result 时） */
  toolResult?: unknown
  /** 错误信息（type=error 时） */
  error?: string
  /** 是否完成 */
  isFinished?: boolean
  /** Token 使用量（type=done 时返回累计值） */
  usage?: TokenUsage
  /** 运行状态（type=status 时返回） */
  status?: AgentRuntimeStatus
}

/**
 * Agent 执行结果
 */
export interface AgentResult {
  /** 最终文本响应 */
  content: string
  /** 使用的工具列表 */
  toolsUsed: string[]
  /** 工具调用轮数 */
  toolRounds: number
  /** 总 Token 使用量（累计所有 LLM 调用） */
  totalUsage?: TokenUsage
}

// ==================== 提示词配置类型 ====================

/**
 * 用户自定义提示词配置
 */
export interface PromptConfig {
  /** 角色定义（可编辑区） */
  roleDefinition: string
  /** 回答要求（可编辑区） */
  responseRules: string
}

// ==================== 国际化辅助（使用 i18next） ====================

/** 获取 Agent 翻译，根据传入的 locale 参数 */
function agentT(key: string, locale: string, options?: Record<string, unknown>): string {
  return i18nT(key, { lng: locale, ...options })
}

/**
 * 获取系统锁定部分的提示词（策略说明、时间处理等）
 *
 * 注意：工具定义通过 Function Calling 的 tools 参数传递给 LLM，
 * 无需在 System Prompt 中重复描述，以节省 Token。
 *
 * @param chatType 聊天类型 ('group' | 'private')
 * @param ownerInfo Owner 信息（当前用户在对话中的身份）
 * @param locale 语言设置
 */
function getLockedPromptSection(
  chatType: 'group' | 'private',
  ownerInfo?: OwnerInfo,
  locale: string = 'zh-CN'
): string {
  const now = new Date()
  const dateLocale = locale.startsWith('zh') ? 'zh-CN' : 'en-US'
  const currentDate = now.toLocaleDateString(dateLocale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })

  const isPrivate = chatType === 'private'
  const chatContext = agentT(`ai.agent.chatContext.${chatType}`, locale)

  // Owner 说明（当用户设置了"我是谁"时）
  const ownerNote = ownerInfo
    ? agentT('ai.agent.ownerNote', locale, {
        displayName: ownerInfo.displayName,
        platformId: ownerInfo.platformId,
        chatContext,
      })
    : ''

  // 成员说明（私聊只有2人）
  const memberNote = isPrivate
    ? agentT('ai.agent.memberNotePrivate', locale)
    : agentT('ai.agent.memberNoteGroup', locale)

  const year = now.getFullYear()
  const prevYear = year - 1
  const contextToolGuidance = locale.startsWith('zh')
    ? `\n上下文管理约定：
- 关键节点请调用 context_tag 打标签
- 需要检查上下文状态时调用 context_log
- 任务分叉或上下文噪音变大时调用 context_checkout
- context_checkout 从下一轮开始生效，需给出简短分支摘要`
    : `\nContext management protocol:
- Use context_tag to mark milestones
- Use context_log to inspect the context timeline
- Use context_checkout when branching or when context gets noisy
- context_checkout takes effect from the next turn, include a concise branch summary`

  return `${agentT('ai.agent.currentDateIs', locale)} ${currentDate}。
${ownerNote}
${memberNote}
${agentT('ai.agent.timeParamsIntro', locale)}
- ${agentT('ai.agent.timeParamExample1', locale, { year })}
- ${agentT('ai.agent.timeParamExample2', locale, { year })}
- ${agentT('ai.agent.timeParamExample3', locale, { year })}
${agentT('ai.agent.defaultYearNote', locale, { year, prevYear })}
${contextToolGuidance}

${agentT('ai.agent.responseInstruction', locale)}`
}

/**
 * 获取 Fallback 角色定义（主要配置来自前端 src/config/prompts.ts）
 * 仅在前端未传递 promptConfig 时使用
 */
function getFallbackRoleDefinition(chatType: 'group' | 'private', locale: string = 'zh-CN'): string {
  return agentT(`ai.agent.fallbackRoleDefinition.${chatType}`, locale)
}

/**
 * 获取 Fallback 回答要求（主要配置来自前端 src/config/prompts.ts）
 * 仅在前端未传递 promptConfig 时使用
 */
function getFallbackResponseRules(locale: string = 'zh-CN'): string {
  return agentT('ai.agent.fallbackResponseRules', locale)
}

/**
 * 构建完整的系统提示词
 *
 * 提示词配置主要来自前端 src/config/prompts.ts，通过 promptConfig 参数传递。
 * Fallback 仅在前端未传递配置时使用（一般不会发生）。
 *
 * @param chatType 聊天类型 ('group' | 'private')
 * @param promptConfig 用户自定义提示词配置（来自前端激活的预设）
 * @param ownerInfo Owner 信息（当前用户在对话中的身份）
 * @param locale 语言设置
 */
function buildSystemPrompt(
  chatType: 'group' | 'private' = 'group',
  promptConfig?: PromptConfig,
  ownerInfo?: OwnerInfo,
  locale: string = 'zh-CN'
): string {
  // 使用用户配置或 fallback
  const roleDefinition = promptConfig?.roleDefinition || getFallbackRoleDefinition(chatType, locale)
  const responseRules = promptConfig?.responseRules || getFallbackResponseRules(locale)

  // 获取锁定的系统部分（包含动态日期、工具说明和 Owner 信息）
  const lockedSection = getLockedPromptSection(chatType, ownerInfo, locale)

  // 组合完整提示词
  return `${roleDefinition}

${lockedSection}

${agentT('ai.agent.responseRulesTitle', locale)}
${responseRules}`
}

/**
 * Agent 执行器类
 * 处理带 Function Calling 的对话流程
 */
export class Agent {
  private context: ToolContext
  private config: AgentConfig
  private toolsUsed: string[] = []
  private toolRounds: number = 0
  private abortSignal?: AbortSignal
  private historyMessages: ChatMessage[] = []
  private chatType: 'group' | 'private' = 'group'
  private promptConfig?: PromptConfig
  private locale: string = 'zh-CN'
  /** 累计 Token 使用量 */
  private totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  /** Agentic Context Session Log */
  private sessionLog: AgentSessionLog
  /** 最近一次发送给前端的状态 */
  private latestRuntimeStatus: AgentRuntimeStatus | null = null
  /** 模型上下文窗口 */
  private readonly contextWindow = 128000
  /** 状态事件节流时间戳 */
  private lastStatusAt = 0

  constructor(
    context: ToolContext,
    config: AgentConfig = {},
    historyMessages: ChatMessage[] = [],
    chatType: 'group' | 'private' = 'group',
    promptConfig?: PromptConfig,
    locale: string = 'zh-CN'
  ) {
    this.context = context
    this.abortSignal = config.abortSignal
    this.historyMessages = historyMessages
    this.chatType = chatType
    this.promptConfig = promptConfig
    this.locale = locale
    this.config = {
      maxToolRounds: config.maxToolRounds ?? 5,
      contextHistoryLimit: config.contextHistoryLimit ?? 48,
      llmOptions: config.llmOptions ?? { temperature: 0.7, maxTokens: 2048 },
    }
    this.sessionLog = getAgentSessionLog(this.context.sessionId, this.context.conversationId)
  }

  /**
   * 检查是否已中止
   */
  private isAborted(): boolean {
    return this.abortSignal?.aborted ?? false
  }

  private addPiUsage(usage?: PiUsage): void {
    if (!usage) return
    this.totalUsage.promptTokens += usage.input || 0
    this.totalUsage.completionTokens += usage.output || 0
    this.totalUsage.totalTokens += usage.totalTokens || usage.input + usage.output || 0
  }

  private resetRunState(): void {
    this.toolsUsed = []
    this.toolRounds = 0
    this.totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    this.lastStatusAt = 0
    this.latestRuntimeStatus = null
  }

  private cloneUsage(): TokenUsage {
    return {
      promptTokens: this.totalUsage.promptTokens,
      completionTokens: this.totalUsage.completionTokens,
      totalTokens: this.totalUsage.totalTokens,
    }
  }

  private estimateTokensFromText(text: string): number {
    if (!text) return 0

    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) return 0

    const cjkCount = (normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
    const latinCount = normalized.length - cjkCount
    return Math.max(1, Math.ceil(cjkCount * 1.15 + latinCount / 4))
  }

  private extractMessageText(message: PiMessage): string {
    if (message.role === 'user') {
      if (typeof message.content === 'string') return message.content
      return message.content
        .map((item) => {
          if (item.type === 'text') return item.text
          if (item.type === 'image') return '[image]'
          return ''
        })
        .join('\n')
    }

    if (message.role === 'assistant') {
      return message.content
        .map((item) => {
          if (item.type === 'text') return item.text
          if (item.type === 'thinking') return item.thinking
          if (item.type === 'toolCall') return `${item.name} ${JSON.stringify(item.arguments || {})}`
          return ''
        })
        .join('\n')
    }

    if (message.role === 'toolResult') {
      return message.content
        .map((item) => {
          if (item.type === 'text') return item.text
          return '[binary]'
        })
        .join('\n')
    }

    return ''
  }

  private estimateContextTokens(systemPrompt: string, messages: PiMessage[], pendingUserMessage?: string): number {
    let tokens = this.estimateTokensFromText(systemPrompt)

    for (const message of messages) {
      tokens += this.estimateTokensFromText(this.extractMessageText(message))
    }

    if (pendingUserMessage) {
      tokens += this.estimateTokensFromText(pendingUserMessage)
    }

    return tokens
  }

  private buildSystemPromptWithContextNotes(baseSystemPrompt: string): string {
    const notes = this.sessionLog.consumePendingSystemNotes()
    if (notes.length === 0) return baseSystemPrompt

    return `${baseSystemPrompt}

[Context Checkout Notes]
${notes.map((note, index) => `${index + 1}. ${note}`).join('\n')}`
  }

  private toCompactText(value: unknown, maxLen: number = 260): string {
    let text = ''
    if (typeof value === 'string') {
      text = value
    } else {
      try {
        text = JSON.stringify(value)
      } catch {
        text = String(value)
      }
    }

    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLen) return normalized
    return `${normalized.slice(0, maxLen)}...`
  }

  private emitStatus(
    onChunk: (chunk: AgentStreamChunk) => void,
    phase: AgentRuntimeStatus['phase'],
    systemPrompt: string,
    messages: PiMessage[],
    options?: {
      pendingUserMessage?: string
      currentTool?: string
      force?: boolean
    }
  ): void {
    const now = Date.now()
    if (!options?.force && now - this.lastStatusAt < 240) {
      return
    }
    this.lastStatusAt = now

    const contextTokens = this.estimateContextTokens(systemPrompt, messages, options?.pendingUserMessage)
    const contextUsage = this.contextWindow > 0 ? Math.min(1, Math.max(0, contextTokens / this.contextWindow)) : 0
    const snapshot = this.sessionLog.getSnapshot(6)

    const status: AgentRuntimeStatus = {
      phase,
      round: this.toolRounds,
      toolsUsed: this.toolsUsed.length,
      currentTool: options?.currentTool,
      contextTokens,
      contextWindow: this.contextWindow,
      contextUsage,
      totalUsage: this.cloneUsage(),
      nodeCount: snapshot.nodeCount,
      tagCount: snapshot.tagCount,
      segmentSize: snapshot.segmentSize,
      checkoutCount: snapshot.checkoutCount,
      activeAnchorNodeId: snapshot.activeAnchorNodeId,
      updatedAt: now,
    }
    this.latestRuntimeStatus = status

    onChunk({
      type: 'status',
      status,
    })
  }

  private createEmptyPiUsage(): PiUsage {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    }
  }

  private toPiUsage(usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): PiUsage {
    if (!usage) return this.createEmptyPiUsage()
    return {
      input: usage.promptTokens,
      output: usage.completionTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.totalTokens,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    }
  }

  private normalizeToolParams(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
    const normalized = { ...params }

    const toolsWithLimit = ['search_messages', 'get_recent_messages', 'get_conversation_between']
    if (this.context.maxMessagesLimit && toolsWithLimit.includes(toolName)) {
      normalized.limit = this.context.maxMessagesLimit
    }

    if (this.context.timeFilter && (toolName === 'search_messages' || toolName === 'get_recent_messages')) {
      normalized._timeFilter = this.context.timeFilter
    }

    return normalized
  }

  private toPiHistoryMessages(messages: ChatMessage[]): PiMessage[] {
    return messages
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg): PiMessage => {
        if (msg.role === 'user') {
          return {
            role: 'user',
            content: [{ type: 'text', text: msg.content || '' }],
            timestamp: Date.now(),
          }
        }

        return {
          role: 'assistant',
          content: [{ type: 'text', text: msg.content || '' }],
          api: 'openai-completions',
          provider: 'chatlab',
          model: 'chatlab-bridge',
          usage: this.createEmptyPiUsage(),
          stopReason: 'stop',
          timestamp: Date.now(),
        }
      })
  }

  private piMessageToChatMessage(message: PiMessage): ChatMessage | null {
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((item) => item.type === 'text')
              .map((item) => item.text)
              .join('\n')

      return { role: 'user', content }
    }

    if (message.role === 'assistant') {
      const textContent = message.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')

      const toolCalls = message.content
        .filter((item): item is PiToolCall => item.type === 'toolCall')
        .map(
          (item): ToolCall => ({
            id: item.id,
            type: 'function',
            function: {
              name: item.name,
              arguments: JSON.stringify(item.arguments ?? {}),
            },
            thoughtSignature: item.thoughtSignature,
          })
        )

      return {
        role: 'assistant',
        content: textContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      }
    }

    if (message.role === 'toolResult') {
      const content = message.content
        .map((item) => {
          if (item.type === 'text') return item.text
          return '[image]'
        })
        .join('\n')

      return {
        role: 'tool',
        content,
        tool_call_id: message.toolCallId,
      }
    }

    return null
  }

  private toChatMessages(context: PiContext): ChatMessage[] {
    const result: ChatMessage[] = []

    if (context.systemPrompt?.trim()) {
      result.push({ role: 'system', content: context.systemPrompt })
    }

    for (const message of context.messages) {
      const mapped = this.piMessageToChatMessage(message)
      if (mapped) result.push(mapped)
    }

    return result
  }

  private toChatToolDefinitions(tools?: PiToolSchema[]): Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: {
        type: 'object'
        properties: Record<
          string,
          {
            type: string
            description: string
            enum?: string[]
            items?: { type: string }
          }
        >
        required?: string[]
      }
    }
  }> {
    if (!tools || tools.length === 0) return []

    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as {
          type: 'object'
          properties: Record<
            string,
            {
              type: string
              description: string
              enum?: string[]
              items?: { type: string }
            }
          >
          required?: string[]
        },
      },
    }))
  }

  private createBridgeModel(): PiModel<any> {
    return {
      id: 'chatlab-bridge',
      name: 'ChatLab Bridge',
      api: 'openai-completions',
      provider: 'chatlab',
      baseUrl: 'https://chatlab.local',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: this.contextWindow,
      maxTokens: this.config.llmOptions?.maxTokens ?? 4096,
    }
  }

  private createPiStreamFn() {
    return (_model: PiModel<any>, context: PiContext, options?: { signal?: AbortSignal; maxTokens?: number }) => {
      const stream = new PiEventStream<PiAssistantMessageEvent, PiAssistantMessage>(
        (event) => event.type === 'done' || event.type === 'error',
        (event) => {
          if (event.type === 'done') return event.message
          if (event.type === 'error') return event.error
          return event.partial
        }
      ) as unknown as PiAssistantMessageEventStream

      ;(async () => {
        const partial: PiAssistantMessage = {
          role: 'assistant',
          content: [],
          api: 'openai-completions',
          provider: 'chatlab',
          model: 'chatlab-bridge',
          usage: this.createEmptyPiUsage(),
          stopReason: 'stop',
          timestamp: Date.now(),
        }

        const clonePartial = (): PiAssistantMessage => structuredClone(partial)
        stream.push({ type: 'start', partial: clonePartial() })

        let accumulatedContent = ''
        let finishReason: 'stop' | 'length' | 'error' | 'tool_calls' = 'stop'
        let hasToolCalls = false
        let activeTextIndex: number | null = null
        let activeThinkingIndex: number | null = null

        const appendText = (text: string) => {
          if (!text) return

          if (activeTextIndex === null) {
            activeTextIndex = partial.content.push({ type: 'text', text: '' }) - 1
            stream.push({ type: 'text_start', contentIndex: activeTextIndex, partial: clonePartial() })
          }

          const target = partial.content[activeTextIndex]
          if (target.type !== 'text') return
          target.text += text
          stream.push({
            type: 'text_delta',
            contentIndex: activeTextIndex,
            delta: text,
            partial: clonePartial(),
          })
        }

        const appendThinking = (text: string) => {
          if (activeThinkingIndex === null) {
            activeThinkingIndex = partial.content.push({ type: 'thinking', thinking: '' }) - 1
            stream.push({ type: 'thinking_start', contentIndex: activeThinkingIndex, partial: clonePartial() })
          }

          const target = partial.content[activeThinkingIndex]
          if (target.type !== 'thinking') return
          target.thinking += text
          stream.push({
            type: 'thinking_delta',
            contentIndex: activeThinkingIndex,
            delta: text,
            partial: clonePartial(),
          })
        }

        const closeThinking = () => {
          if (activeThinkingIndex === null) return
          const target = partial.content[activeThinkingIndex]
          if (target.type === 'thinking') {
            stream.push({
              type: 'thinking_end',
              contentIndex: activeThinkingIndex,
              content: target.thinking,
              partial: clonePartial(),
            })
          }
          activeThinkingIndex = null
        }

        const parser = createStreamParser({
          onText: (text) => appendText(text),
          onThink: (text) => appendThinking(text),
          onThinkEnd: () => closeThinking(),
        })

        const appendToolCalls = (toolCalls: ToolCall[]) => {
          for (const toolCall of toolCalls) {
            let parsedArgs: Record<string, unknown> = {}
            try {
              parsedArgs = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>
            } catch {
              parsedArgs = {}
            }

            const piToolCall: PiToolCall = {
              type: 'toolCall',
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: parsedArgs,
              thoughtSignature: toolCall.thoughtSignature,
            }

            const index = partial.content.push(piToolCall) - 1
            hasToolCalls = true
            stream.push({ type: 'toolcall_start', contentIndex: index, partial: clonePartial() })
            stream.push({
              type: 'toolcall_delta',
              contentIndex: index,
              delta: JSON.stringify(piToolCall.arguments || {}),
              partial: clonePartial(),
            })
            stream.push({
              type: 'toolcall_end',
              contentIndex: index,
              toolCall: piToolCall,
              partial: clonePartial(),
            })
          }
        }

        try {
          const llmMessages = this.toChatMessages(context)
          const llmTools = this.toChatToolDefinitions(context.tools)

          for await (const chunk of chatStream(llmMessages, {
            ...this.config.llmOptions,
            maxTokens: options?.maxTokens ?? this.config.llmOptions?.maxTokens,
            tools: llmTools,
            abortSignal: options?.signal,
          })) {
            if (chunk.content) {
              accumulatedContent += chunk.content
              parser.push(chunk.content)
            }

            if (chunk.tool_calls && chunk.tool_calls.length > 0) {
              appendToolCalls(chunk.tool_calls)
            }

            if (chunk.usage) {
              partial.usage = this.toPiUsage(chunk.usage)
            }

            if (chunk.isFinished) {
              finishReason = chunk.finishReason || 'stop'
            }
          }

          parser.flush()
          closeThinking()

          if (!hasToolCalls && hasToolCallTags(accumulatedContent)) {
            const fallbackToolCalls = parseToolCallTags(accumulatedContent)
            if (fallbackToolCalls && fallbackToolCalls.length > 0) {
              appendToolCalls(fallbackToolCalls)
              hasToolCalls = true
            }
          }

          if (activeTextIndex !== null) {
            const target = partial.content[activeTextIndex]
            if (target.type === 'text') {
              stream.push({
                type: 'text_end',
                contentIndex: activeTextIndex,
                content: target.text,
                partial: clonePartial(),
              })
            }
            activeTextIndex = null
          }

          const doneReason: Extract<PiStopReason, 'stop' | 'length' | 'toolUse'> = hasToolCalls
            ? 'toolUse'
            : finishReason === 'length'
              ? 'length'
              : 'stop'

          partial.stopReason = doneReason
          const message = clonePartial()
          stream.push({ type: 'done', reason: doneReason, message })
          stream.end(message)
        } catch (error) {
          const isAbort = options?.signal?.aborted === true
          const reason: Extract<PiStopReason, 'error' | 'aborted'> = isAbort ? 'aborted' : 'error'
          const errorMessage: PiAssistantMessage = {
            ...partial,
            stopReason: reason,
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          }
          stream.push({ type: 'error', reason, error: errorMessage })
          stream.end(errorMessage)
        }
      })()

      return stream
    }
  }

  private async createPiTools(): Promise<PiAgentTool[]> {
    const toolDefinitions = await getAllToolDefinitions()
    const businessTools = toolDefinitions.map(
      (definition) =>
        ({
          name: definition.function.name,
          label: definition.function.name,
          description: definition.function.description,
          parameters: (definition.function.parameters || PiType.Any()) as any,
          execute: async (toolCallId: string, params: any) => {
            const toolCall: ToolCall = {
              id: toolCallId,
              type: 'function',
              function: {
                name: definition.function.name,
                arguments: JSON.stringify(params ?? {}),
              },
            }

            const [result] = await executeToolCalls([toolCall], { ...this.context, locale: this.locale })
            const contentText = result.success
              ? JSON.stringify(result.result)
              : agentT('ai.agent.toolError', this.locale, { error: result.error })

            return {
              content: [{ type: 'text', text: contentText }],
              details: result.success ? result.result : result.error,
            }
          },
        }) as PiAgentTool<any>
    )

    const contextTools: PiAgentTool[] = [
      {
        name: 'context_log',
        label: 'context_log',
        description: this.locale.startsWith('zh')
          ? '查看当前上下文管理状态，返回节点、标签、checkout 和上下文占用。'
          : 'Inspect context manager state and return nodes, tags, checkouts, and context usage.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: this.locale.startsWith('zh')
                ? '返回最近节点数量，默认 12，最大 40。'
                : 'Recent node count, default 12, max 40.',
            },
          },
          required: [],
        } as any,
        execute: async (_toolCallId: string, params: any) => {
          const limit = typeof params?.limit === 'number' ? Math.max(4, Math.min(40, Math.floor(params.limit))) : 12

          const usage = this.latestRuntimeStatus
            ? {
                contextTokens: this.latestRuntimeStatus.contextTokens,
                contextWindow: this.latestRuntimeStatus.contextWindow,
                contextUsage: this.latestRuntimeStatus.contextUsage,
                totalUsage: this.latestRuntimeStatus.totalUsage,
              }
            : undefined

          const payload = this.sessionLog.buildContextLogPayload(usage, limit)
          return {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            details: payload,
          }
        },
      } as PiAgentTool<any>,
      {
        name: 'context_tag',
        label: 'context_tag',
        description: this.locale.startsWith('zh')
          ? '为关键节点打标签，便于后续 context_checkout 回溯。'
          : 'Tag important context nodes for later context_checkout.',
        parameters: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
              description: this.locale.startsWith('zh') ? '标签名，例如 phase1_done。' : 'Tag name, e.g. phase1_done.',
            },
            target: {
              type: 'string',
              description: this.locale.startsWith('zh')
                ? '可选，节点 ID 或已有标签。默认当前 head。'
                : 'Optional node id or existing tag. Defaults to current head.',
            },
            note: {
              type: 'string',
              description: this.locale.startsWith('zh') ? '可选，记录标签备注。' : 'Optional note for the tag.',
            },
          },
          required: ['tag'],
        } as any,
        execute: async (_toolCallId: string, params: any) => {
          const result = this.sessionLog.tag(String(params?.tag || ''), params?.target, params?.note)
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          }
        },
      } as PiAgentTool<any>,
      {
        name: 'context_checkout',
        label: 'context_checkout',
        description: this.locale.startsWith('zh')
          ? '切换上下文锚点并记录分支摘要，下一轮对话将基于该锚点组织历史。'
          : 'Switch context anchor and store a branch summary. Applied on next turn.',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: this.locale.startsWith('zh') ? '目标节点 ID 或标签名。' : 'Target node id or tag name.',
            },
            summary: {
              type: 'string',
              description: this.locale.startsWith('zh')
                ? '对当前分支的短摘要，供下一轮系统提示引用。'
                : 'Concise summary of the current branch for next-turn system notes.',
            },
          },
          required: ['target', 'summary'],
        } as any,
        execute: async (_toolCallId: string, params: any) => {
          const result = this.sessionLog.checkout(String(params?.target || ''), String(params?.summary || ''))
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          }
        },
      } as PiAgentTool<any>,
    ]

    return [...businessTools, ...contextTools]
  }

  /**
   * 执行对话（非流式）
   * @param userMessage 用户消息
   */
  async execute(userMessage: string): Promise<AgentResult> {
    return this.executeStream(userMessage, () => {})
  }

  /**
   * 执行对话（流式）
   * @param userMessage 用户消息
   * @param onChunk 流式回调
   */
  async executeStream(userMessage: string, onChunk: (chunk: AgentStreamChunk) => void): Promise<AgentResult> {
    aiLogger.info('Agent', 'User question', userMessage)
    this.resetRunState()

    if (this.isAborted()) {
      const snapshot = this.sessionLog.getSnapshot(6)
      onChunk({
        type: 'status',
        status: {
          phase: 'aborted',
          round: 0,
          toolsUsed: 0,
          contextTokens: 0,
          contextWindow: this.contextWindow,
          contextUsage: 0,
          totalUsage: this.cloneUsage(),
          nodeCount: snapshot.nodeCount,
          tagCount: snapshot.tagCount,
          segmentSize: snapshot.segmentSize,
          checkoutCount: snapshot.checkoutCount,
          activeAnchorNodeId: snapshot.activeAnchorNodeId,
          updatedAt: Date.now(),
        },
      })
      onChunk({ type: 'done', isFinished: true, usage: this.totalUsage })
      return { content: '', toolsUsed: [], toolRounds: 0, totalUsage: this.totalUsage }
    }

    const coreAgent = new PiAgentCore({
      initialState: {
        model: this.createBridgeModel(),
        thinkingLevel: 'off',
      },
      streamFn: this.createPiStreamFn(),
      convertToLlm: (messages) =>
        messages.filter(
          (msg): msg is PiMessage => msg.role === 'user' || msg.role === 'assistant' || msg.role === 'toolResult'
        ),
    })

    this.sessionLog.bootstrapFromHistoryIfEmpty(this.historyMessages)
    const historyForPrompt = this.sessionLog.getPromptHistory(this.config.contextHistoryLimit)
    const baseSystemPrompt = buildSystemPrompt(this.chatType, this.promptConfig, this.context.ownerInfo, this.locale)
    const systemPrompt = this.buildSystemPromptWithContextNotes(baseSystemPrompt)
    coreAgent.setSystemPrompt(systemPrompt)
    coreAgent.setTools(await this.createPiTools())
    coreAgent.replaceMessages(this.toPiHistoryMessages(historyForPrompt))
    this.emitStatus(onChunk, 'preparing', systemPrompt, coreAgent.state.messages, {
      pendingUserMessage: userMessage,
      force: true,
    })
    this.sessionLog.append('user', userMessage)

    const thinkingStartTime = new Map<number, number>()
    const unsubscribe = coreAgent.subscribe((event: PiAgentEvent) => {
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent
        if (update.type === 'text_delta') {
          onChunk({ type: 'content', content: update.delta })
          this.emitStatus(onChunk, 'responding', systemPrompt, coreAgent.state.messages)
        } else if (update.type === 'thinking_start') {
          thinkingStartTime.set(update.contentIndex, Date.now())
          this.emitStatus(onChunk, 'thinking', systemPrompt, coreAgent.state.messages, { force: true })
        } else if (update.type === 'thinking_delta') {
          onChunk({ type: 'think', content: update.delta, thinkTag: 'thinking' })
          this.emitStatus(onChunk, 'thinking', systemPrompt, coreAgent.state.messages)
        } else if (update.type === 'thinking_end') {
          const startedAt = thinkingStartTime.get(update.contentIndex)
          const durationMs = startedAt ? Date.now() - startedAt : undefined
          onChunk({
            type: 'think',
            content: '',
            thinkTag: 'thinking',
            thinkDurationMs: durationMs,
          })
          thinkingStartTime.delete(update.contentIndex)
          this.emitStatus(onChunk, 'responding', systemPrompt, coreAgent.state.messages, { force: true })
        }
      } else if (event.type === 'tool_execution_start') {
        const params = this.normalizeToolParams(event.toolName, (event.args || {}) as Record<string, unknown>)
        this.toolsUsed.push(event.toolName)
        onChunk({
          type: 'tool_start',
          toolName: event.toolName,
          toolParams: params,
        })
        this.emitStatus(onChunk, 'tool_running', systemPrompt, coreAgent.state.messages, {
          currentTool: event.toolName,
          force: true,
        })
      } else if (event.type === 'tool_execution_end') {
        onChunk({
          type: 'tool_result',
          toolName: event.toolName,
          toolResult: event.result,
        })
        this.sessionLog.append('tool', `${event.toolName}: ${this.toCompactText(event.result)}`)
        this.emitStatus(onChunk, 'thinking', systemPrompt, coreAgent.state.messages, { force: true })
      } else if (event.type === 'turn_end') {
        if (event.toolResults.length > 0) {
          this.toolRounds += 1
        }
        this.emitStatus(onChunk, 'thinking', systemPrompt, coreAgent.state.messages, { force: true })
      } else if (event.type === 'message_end') {
        if (event.message.role === 'assistant') {
          this.addPiUsage(event.message.usage)
          this.emitStatus(onChunk, 'responding', systemPrompt, coreAgent.state.messages, { force: true })
        }
      }
    })

    const forwardAbort = () => coreAgent.abort()
    if (this.abortSignal) {
      this.abortSignal.addEventListener('abort', forwardAbort, { once: true })
    }

    try {
      await coreAgent.prompt(userMessage)

      if (this.isAborted()) {
        this.emitStatus(onChunk, 'aborted', systemPrompt, coreAgent.state.messages, { force: true })
        onChunk({ type: 'done', isFinished: true, usage: this.totalUsage })
        return {
          content: '',
          toolsUsed: this.toolsUsed,
          toolRounds: this.toolRounds,
          totalUsage: this.totalUsage,
        }
      }

      if (coreAgent.state.error) {
        throw new Error(coreAgent.state.error)
      }

      const finalAssistant = [...coreAgent.state.messages]
        .reverse()
        .find((msg): msg is PiAssistantMessage => msg.role === 'assistant')

      const finalRawContent =
        finalAssistant?.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('') || ''

      const finalContent = stripToolCallTags(extractThinkingContent(finalRawContent).cleanContent)
      this.sessionLog.append('assistant', finalContent)
      this.emitStatus(onChunk, 'completed', systemPrompt, coreAgent.state.messages, { force: true })
      onChunk({ type: 'done', isFinished: true, usage: this.totalUsage })

      return {
        content: finalContent,
        toolsUsed: this.toolsUsed,
        toolRounds: this.toolRounds,
        totalUsage: this.totalUsage,
      }
    } catch (error) {
      this.sessionLog.append('note', `Run failed: ${this.toCompactText(error)}`)
      const phase: AgentRuntimeStatus['phase'] = this.isAborted() ? 'aborted' : 'error'
      this.emitStatus(onChunk, phase, systemPrompt, coreAgent.state.messages, { force: true })
      throw error
    } finally {
      unsubscribe()
      if (this.abortSignal) {
        this.abortSignal.removeEventListener('abort', forwardAbort)
      }
    }
  }
}

/**
 * 创建 Agent 并执行对话（便捷函数）
 */
export async function runAgent(
  userMessage: string,
  context: ToolContext,
  config?: AgentConfig,
  historyMessages?: ChatMessage[],
  chatType?: 'group' | 'private'
): Promise<AgentResult> {
  const agent = new Agent(context, config, historyMessages, chatType)
  return agent.execute(userMessage)
}

/**
 * 创建 Agent 并流式执行对话（便捷函数）
 */
export async function runAgentStream(
  userMessage: string,
  context: ToolContext,
  onChunk: (chunk: AgentStreamChunk) => void,
  config?: AgentConfig,
  historyMessages?: ChatMessage[],
  chatType?: 'group' | 'private'
): Promise<AgentResult> {
  const agent = new Agent(context, config, historyMessages, chatType)
  return agent.executeStream(userMessage, onChunk)
}
