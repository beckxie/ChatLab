/**
 * AI Tools 模块入口
 * 工具创建与管理
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
 * 获取所有可用的 AgentTool
 *
 * 根据配置动态过滤工具（如：语义搜索工具仅在启用 Embedding 时可用）
 * 根据当前 locale 动态翻译工具描述
 */
export function getAllTools(context: ToolContext): AgentTool<any>[] {
  const tools: AgentTool<any>[] = coreFactories.map((f) => f(context))

  if (isEmbeddingEnabled()) {
    tools.push(createSemanticSearchMessages(context))
  }

  return tools.map(translateTool)
}
