/**
 * AI Tools 模块入口
 * 工具创建、预处理管道与管理
 *
 * 架构：工具返回结构化数据（rawMessages） → 处理层执行预处理 + 格式化 → 生成 LLM 内容
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { ToolContext } from './types'
import {
  createSearchMessages,
  createGetRecentMessages,
  createGetMemberStats,
  createGetTimeStats,
  createGetGroupMembers,
  createGetMemberNameHistory,
  createGetConversationBetween,
  createGetMessageContext,
  createSearchSessions,
  createGetSessionMessages,
  createGetSessionSummaries,
  createSemanticSearchMessages,
} from './definitions'
import { isEmbeddingEnabled } from '../rag'
import { t as i18nT } from '../../i18n'
import { preprocessMessages, type PreprocessableMessage } from '../preprocessor'
import { formatMessageCompact } from './utils/format'

// 导出类型
export * from './types'

type ToolFactory = (context: ToolContext) => AgentTool<any>

const coreFactories: ToolFactory[] = [
  createSearchMessages,
  createGetRecentMessages,
  createGetMemberStats,
  createGetTimeStats,
  createGetGroupMembers,
  createGetMemberNameHistory,
  createGetConversationBetween,
  createGetMessageContext,
  createSearchSessions,
  createGetSessionMessages,
  createGetSessionSummaries,
]

/**
 * 将工具返回的结构化数据格式化为 LLM 友好的纯文本
 *
 * 从 JSON.stringify 改为纯文本，节省 token 且更易于 LLM 理解。
 * 元数据作为头部，消息逐行排列。
 */
function formatToolResultAsText(details: Record<string, unknown>): string {
  const lines: string[] = []
  const messages = details.messages as string[] | undefined

  for (const [key, value] of Object.entries(details)) {
    if (key === 'messages') continue
    if (value === undefined || value === null) continue

    if (typeof value === 'object') {
      if ('start' in (value as Record<string, unknown>) && 'end' in (value as Record<string, unknown>)) {
        const range = value as { start: string; end: string }
        lines.push(`${key}: ${range.start} ~ ${range.end}`)
      } else if (Array.isArray(value)) {
        lines.push(`${key}: ${value.join(', ')}`)
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`)
      }
    } else {
      lines.push(`${key}: ${value}`)
    }
  }

  if (messages && messages.length > 0) {
    lines.push('')
    let lastDate = ''
    for (const msg of messages) {
      const spaceIdx = msg.indexOf(' ')
      const secondSpaceIdx = msg.indexOf(' ', spaceIdx + 1)
      if (spaceIdx > 0 && secondSpaceIdx > 0) {
        const date = msg.slice(0, spaceIdx)
        const rest = msg.slice(spaceIdx + 1)
        if (date !== lastDate) {
          lines.push(`--- ${date} ---`)
          lastDate = date
        }
        lines.push(rest)
      } else {
        lines.push(msg)
      }
    }
  }

  return lines.join('\n')
}

/**
 * 翻译 AgentTool 的描述（工具级 + 参数级）
 *
 * i18n 键命名规则：
 * - 工具描述：ai.tools.{toolName}.desc
 * - 参数描述：ai.tools.{toolName}.params.{paramName}
 */
function translateTool(tool: AgentTool<any>): AgentTool<any> {
  const name = tool.name

  const descKey = `ai.tools.${name}.desc`
  const translatedDesc = i18nT(descKey)

  const params = tool.parameters as Record<string, unknown>
  if (params?.properties && typeof params.properties === 'object') {
    for (const [paramName, param] of Object.entries(params.properties as Record<string, Record<string, unknown>>)) {
      const paramKey = `ai.tools.${name}.params.${paramName}`
      const translated = i18nT(paramKey)
      if (translated !== paramKey) {
        param.description = translated
      }
    }
  }

  return {
    ...tool,
    description: translatedDesc !== descKey ? translatedDesc : tool.description,
  }
}

/**
 * 预处理包装层
 * 拦截工具的 execute 结果：如果 details 中包含 rawMessages，
 * 则执行预处理管道 + 格式化，替换为最终的 LLM 内容
 *
 * 工具约定：返回消息的工具在 details 中放置 rawMessages 字段（结构化消息数组），
 * 处理层负责 preprocess + formatMessageCompact，工具无需感知预处理逻辑。
 */
function wrapWithPreprocessing(tool: AgentTool<any>, context: ToolContext): AgentTool<any> {
  const originalExecute = tool.execute
  return {
    ...tool,
    execute: async (toolCallId: string, params: any) => {
      const result = await originalExecute(toolCallId, params)

      const details = result.details as Record<string, unknown> | undefined
      if (!details?.rawMessages || !Array.isArray(details.rawMessages)) {
        return result
      }

      const raw = details.rawMessages as PreprocessableMessage[]
      const processed = preprocessMessages(raw, context.preprocessConfig)

      let nameMapLine = ''
      if (context.preprocessConfig?.anonymizeNames) {
        nameMapLine = anonymizeMessageNames(processed, context.ownerInfo?.platformId)
      }

      const formatted = processed.map((m) => formatMessageCompact(m, context.locale))

      const finalDetails = { ...details, messages: formatted, returned: processed.length }
      delete finalDetails.rawMessages

      let textContent = formatToolResultAsText(finalDetails)
      if (nameMapLine) {
        textContent = nameMapLine + '\n' + textContent
      }

      return {
        content: [{ type: 'text' as const, text: textContent }],
        details: finalDetails,
      }
    },
  }
}

/**
 * 昵称匿名化：用 U{senderId} 替代真实昵称
 * 就地修改 messages 的 senderName，返回映射表文本行
 */
function anonymizeMessageNames(messages: PreprocessableMessage[], ownerPlatformId?: string): string {
  const nameMap = new Map<number, { name: string; platformId?: string }>()
  for (const msg of messages) {
    if (msg.senderId != null && !nameMap.has(msg.senderId)) {
      nameMap.set(msg.senderId, { name: msg.senderName, platformId: msg.senderPlatformId })
    }
  }

  if (nameMap.size === 0) return ''

  for (const msg of messages) {
    if (msg.senderId != null) {
      msg.senderName = `U${msg.senderId}`
    }
  }

  const entries: string[] = []
  for (const [id, { name, platformId }] of nameMap) {
    const isOwner = ownerPlatformId && platformId === ownerPlatformId
    entries.push(`U${id}=${name}${isOwner ? '(owner)' : ''}`)
  }

  return `[Name Map] ${entries.join(' | ')}`
}

/**
 * 获取所有可用的 AgentTool
 *
 * 根据配置动态过滤工具（如：语义搜索工具仅在启用 Embedding 时可用）
 * 根据当前 locale 动态翻译工具描述
 * 统一包装预处理层
 */
export function getAllTools(context: ToolContext): AgentTool<any>[] {
  const tools: AgentTool<any>[] = coreFactories.map((f) => f(context))

  if (isEmbeddingEnabled()) {
    tools.push(createSemanticSearchMessages(context))
  }

  return tools.map(translateTool).map((t) => wrapWithPreprocessing(t, context))
}
