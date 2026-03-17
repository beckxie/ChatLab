/**
 * Skype 官方导出 JSON 格式解析器
 * 适配 Microsoft Skype 数据导出中的 messages.json
 *
 * 格式特征：
 * - 根级包含 userId / exportDate / conversations
 * - conversations[] 中每个对象包含 MessageList
 *
 * 导入流程（多聊天选择器）：
 * 1. 用户选择 messages.json → 格式识别
 * 2. scanChats() 扫描 conversations 列表
 * 3. 用户选择要导入的对话
 * 4. parser 使用 formatOptions.chatIndex 定位并解析选定对话
 */

import * as fs from 'fs'
import { chain } from 'stream-chain'
import { parser } from 'stream-json'
import { pick } from 'stream-json/filters/Pick'
import { streamValues } from 'stream-json/streamers/StreamValues'

import { KNOWN_PLATFORMS, ChatType, MessageType } from '../../../../src/types/base'
import type {
  FormatFeature,
  FormatModule,
  Parser,
  ParseOptions,
  ParseEvent,
  ParsedMeta,
  ParsedMember,
  ParsedMessage,
} from '../types'
import { createProgress, getFileSize, parseTimestamp, readFileHeadBytes } from '../utils'

// ==================== 类型定义 ====================

interface SkypeHistoryRoot {
  userId?: string
  exportDate?: string
  conversations?: SkypeConversation[]
}

interface SkypeConversation {
  id?: string
  displayName?: string
  version?: number
  threadProperties?: {
    membercount?: number
    topic?: string
  }
  MessageList?: SkypeMessage[]
}

interface SkypeMessage {
  id?: string
  displayName?: string
  content?: string
  originalarrivaltime?: string
  messagetype?: string
  from?: string
  conversationid?: string
  version?: number
  properties?: {
    urlpreviews?: string
  }
  amsreferences?: string[]
}

// ==================== 特征定义 ====================

export const feature: FormatFeature = {
  id: 'skype-native',
  name: 'Skype 官方导出 (JSON)',
  platform: KNOWN_PLATFORMS.SKYPE,
  priority: 24,
  extensions: ['.json'],
  signatures: {
    requiredFields: ['userId', 'exportDate', 'conversations'],
  },
  multiChat: true,
}

// ==================== 工具函数 ====================

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i
const ANCHOR_RE = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi
const TAG_RE = /<[^>]+>/g
const URL_RE = /https?:\/\/[^\s)]+/gi

function getOwnerIdFromHead(filePath: string): string | null {
  const head = readFileHeadBytes(filePath, 64 * 1024)
  const match = head.match(/"userId"\s*:\s*"([^"]+)"/)
  return match ? match[1] : null
}

function mapChatType(conversation: SkypeConversation): ChatType {
  const id = conversation.id || ''
  const memberCount = conversation.threadProperties?.membercount ?? 0
  if (id.includes('@thread.skype') || memberCount > 2) return ChatType.GROUP
  return ChatType.PRIVATE
}

function getConversationName(conversation: SkypeConversation): string {
  return conversation.displayName || conversation.threadProperties?.topic || conversation.id || 'Skype Chat'
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  }

  return input.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code.startsWith('#x')) {
      const value = parseInt(code.slice(2), 16)
      return Number.isNaN(value) ? m : String.fromCharCode(value)
    }
    if (code.startsWith('#')) {
      const value = parseInt(code.slice(1), 10)
      return Number.isNaN(value) ? m : String.fromCharCode(value)
    }
    const key = `&${code};`
    return named[key] ?? m
  })
}

function sanitizeContent(raw?: string): string | null {
  if (!raw) return null
  const withLinks = raw.replace(ANCHOR_RE, (_match, href, text) => {
    const cleanedText = text.replace(TAG_RE, '').trim()
    if (!cleanedText) return href
    return `${cleanedText} (${href})`
  })
  const noTags = withLinks.replace(TAG_RE, ' ')
  const decoded = decodeEntities(noTags)
  const cleaned = decoded.replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned : null
}

function extractUrlsFromPreviews(previewsRaw?: string): string[] {
  if (!previewsRaw) return []
  try {
    const parsed = JSON.parse(previewsRaw)
    if (!Array.isArray(parsed)) return []
    const urls: string[] = []
    for (const item of parsed) {
      if (typeof item?.url === 'string') urls.push(item.url)
      if (typeof item?.value?.url === 'string') urls.push(item.value.url)
    }
    return urls
  } catch {
    return []
  }
}

function extractUrlsFromContent(content?: string): string[] {
  if (!content) return []
  const matches = content.match(URL_RE)
  return matches ? matches : []
}

function isImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url)
}

function detectMessageType(msg: SkypeMessage): MessageType {
  const messageType = msg.messagetype || ''

  if (messageType.includes('ThreadActivity') || messageType.includes('Control')) return MessageType.SYSTEM
  if (messageType.startsWith('Event/Call')) return MessageType.CALL
  if (messageType.startsWith('RichText/Media_GenericFile')) return MessageType.FILE
  if (messageType.startsWith('RichText/Media_Video')) return MessageType.VIDEO
  if (messageType.startsWith('RichText/Media_Audio') || messageType.startsWith('RichText/Media_AudioMsg')) {
    return MessageType.VOICE
  }
  if (messageType.startsWith('RichText/Media_Image') || messageType.startsWith('RichText/Media_Picture')) {
    return MessageType.IMAGE
  }
  if (messageType.startsWith('RichText/UriObject')) {
    const urls = [
      ...extractUrlsFromPreviews(msg.properties?.urlpreviews),
      ...extractUrlsFromContent(msg.content),
    ]
    if (urls.some(isImageUrl)) return MessageType.IMAGE
    return MessageType.LINK
  }
  if (messageType === 'RichText' || messageType === 'Text') return MessageType.TEXT
  return MessageType.OTHER
}

// ==================== 扫描函数 ====================

export async function scanChats(filePath: string) {
  const chats: {
    index: number
    name: string
    type: string
    id: number
    messageCount: number
  }[] = []

  return new Promise<typeof chats>((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const pipeline = chain([readStream, parser(), pick({ filter: /^conversations\.\d+$/ }), streamValues()])

    pipeline.on('data', ({ value }: { value: SkypeConversation }) => {
      const index = chats.length
      const name = getConversationName(value)
      const chatType = mapChatType(value)
      const messageCount = Array.isArray(value.MessageList) ? value.MessageList.length : 0
      chats.push({
        index,
        name,
        type: chatType,
        id: index,
        messageCount,
      })
    })

    pipeline.on('end', () => resolve(chats))
    pipeline.on('error', (err: Error) => reject(new Error(`扫描 Skype 文件失败: ${err.message}`)))
  })
}

// ==================== 解析器实现 ====================

async function* parseSkype(options: ParseOptions): AsyncGenerator<ParseEvent, void, unknown> {
  const { filePath, batchSize = 5000, formatOptions, onProgress, onLog } = options

  const chatIndex = (formatOptions?.chatIndex as number) ?? 0
  const totalBytes = getFileSize(filePath)
  let bytesRead = 0
  let messagesProcessed = 0

  const initialProgress = createProgress('parsing', 0, totalBytes, 0, '')
  yield { type: 'progress', data: initialProgress }
  onProgress?.(initialProgress)

  onLog?.('info', `开始解析 Skype JSON 文件，大小: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
  onLog?.('info', `目标对话索引: ${chatIndex}`)

  const ownerId = getOwnerIdFromHead(filePath)

  const conversation = await new Promise<SkypeConversation | null>((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, { encoding: 'utf-8' })

    readStream.on('data', (chunk: string | Buffer) => {
      bytesRead += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    })

    const pipeline = chain([
      readStream,
      parser(),
      pick({ filter: new RegExp(`^conversations\\.${chatIndex}$`) }),
      streamValues(),
    ])

    let found = false

    pipeline.on('data', ({ value }: { value: SkypeConversation }) => {
      found = true
      resolve(value)
    })

    pipeline.on('end', () => {
      if (!found) resolve(null)
    })

    pipeline.on('error', reject)
  })

  if (!conversation) {
    onLog?.('error', `未找到索引 ${chatIndex} 对应的对话`)
    yield { type: 'error', data: new Error(`未找到索引 ${chatIndex} 对应的对话`) }
    return
  }

  const chatType = mapChatType(conversation)
  const meta: ParsedMeta = {
    name: getConversationName(conversation),
    platform: KNOWN_PLATFORMS.SKYPE,
    type: chatType,
    groupId: chatType === ChatType.GROUP ? conversation.id : undefined,
    ownerId: ownerId || undefined,
  }
  yield { type: 'meta', data: meta }

  const memberMap = new Map<string, ParsedMember>()
  const messageBatch: ParsedMessage[] = []
  const messages = conversation.MessageList || []

  for (const msg of messages) {
    const senderPlatformId = msg.from || 'unknown'
    const senderName = msg.displayName || senderPlatformId

    if (!memberMap.has(senderPlatformId)) {
      memberMap.set(senderPlatformId, {
        platformId: senderPlatformId,
        accountName: senderName,
      })
    }

    const timestamp =
      parseTimestamp(msg.originalarrivaltime ?? '') ?? parseTimestamp(typeof msg.version === 'number' ? msg.version : '')
    if (!timestamp) continue

    const parsedMessage: ParsedMessage = {
      platformMessageId: msg.id,
      senderPlatformId,
      senderAccountName: senderName,
      timestamp,
      type: detectMessageType(msg),
      content: sanitizeContent(msg.content),
    }

    messageBatch.push(parsedMessage)
    messagesProcessed += 1

    if (messageBatch.length >= batchSize) {
      yield { type: 'messages', data: messageBatch.splice(0, messageBatch.length) }
      const progress = createProgress('parsing', bytesRead, totalBytes, messagesProcessed, '')
      yield { type: 'progress', data: progress }
      onProgress?.(progress)
    }
  }

  if (messageBatch.length > 0) {
    yield { type: 'messages', data: messageBatch }
  }

  yield { type: 'members', data: Array.from(memberMap.values()) }

  const doneProgress = createProgress('done', totalBytes, totalBytes, messagesProcessed, '')
  yield { type: 'progress', data: doneProgress }
  onProgress?.(doneProgress)

  yield { type: 'done', data: { messageCount: messagesProcessed, memberCount: memberMap.size } }
}

export const parser_: Parser = {
  feature,
  parse: parseSkype,
}

const module_: FormatModule = {
  feature,
  parser: parser_,
  scanChats,
}

export default module_
