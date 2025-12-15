<script setup lang="ts">
/**
 * 单条消息展示组件
 */
import dayjs from 'dayjs'
import type { ChatRecordMessage } from './types'

const props = defineProps<{
  /** 消息数据 */
  message: ChatRecordMessage
  /** 是否为目标消息（需要高亮） */
  isTarget?: boolean
  /** 高亮关键词 */
  highlightKeywords?: string[]
}>()

// 格式化时间
function formatTime(timestamp: number): string {
  return dayjs.unix(timestamp).format('MM-DD HH:mm:ss')
}

function formatFullTime(timestamp: number): string {
  return dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm:ss')
}

// 高亮关键词
function highlightContent(content: string): string {
  if (!props.highlightKeywords?.length || !content) return content

  const pattern = props.highlightKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const regex = new RegExp(`(${pattern})`, 'gi')
  return content.replace(regex, '<mark class="bg-yellow-200 dark:bg-yellow-800/50 px-0.5 rounded">$1</mark>')
}
</script>

<template>
  <div
    class="px-4 py-3 transition-colors"
    :class="{
      'bg-yellow-50 ring-2 ring-inset ring-yellow-400 dark:bg-yellow-900/20 dark:ring-yellow-600': isTarget,
    }"
  >
    <!-- 消息头部 -->
    <div class="mb-1 flex items-center justify-between">
      <span class="text-sm font-medium text-gray-900 dark:text-white">
        {{ message.senderName }}
      </span>
      <span class="text-xs text-gray-400" :title="formatFullTime(message.timestamp)">
        {{ formatTime(message.timestamp) }}
      </span>
    </div>

    <!-- 消息内容 -->
    <p
      class="whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-400"
      v-html="highlightContent(message.content || '')"
    />
  </div>
</template>

