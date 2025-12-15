<script setup lang="ts">
/**
 * 当前激活的筛选条件显示
 * 以标签形式展示，支持单个删除和全部清除
 */
import dayjs from 'dayjs'
import type { ChatRecordQuery } from './types'

const props = defineProps<{
  /** 当前查询条件 */
  query: ChatRecordQuery
}>()

const emit = defineEmits<{
  /** 移除单个筛选条件 */
  (e: 'remove', key: keyof ChatRecordQuery): void
  /** 清除所有筛选条件 */
  (e: 'clear-all'): void
}>()

// 格式化时间
function formatDate(ts?: number): string {
  if (!ts) return ''
  return dayjs.unix(ts).format('MM-DD')
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
    <span class="text-xs text-gray-500">当前筛选:</span>

    <!-- 定位消息 -->
    <span
      v-if="query.scrollToMessageId"
      class="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
    >
      <UIcon name="i-heroicons-hashtag" class="h-3 w-3" />
      消息 #{{ query.scrollToMessageId }}
      <button
        class="ml-0.5 hover:text-blue-900 dark:hover:text-blue-200"
        @click="emit('remove', 'scrollToMessageId')"
      >
        <UIcon name="i-heroicons-x-mark" class="h-3 w-3" />
      </button>
    </span>

    <!-- 成员筛选 -->
    <span
      v-if="query.memberId || query.memberName"
      class="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-400"
    >
      <UIcon name="i-heroicons-user" class="h-3 w-3" />
      {{ query.memberName || `ID: ${query.memberId}` }}
      <button
        class="ml-0.5 hover:text-green-900 dark:hover:text-green-200"
        @click="emit('remove', 'memberId')"
      >
        <UIcon name="i-heroicons-x-mark" class="h-3 w-3" />
      </button>
    </span>

    <!-- 时间范围 -->
    <span
      v-if="query.startTs || query.endTs"
      class="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
    >
      <UIcon name="i-heroicons-calendar" class="h-3 w-3" />
      {{ formatDate(query.startTs) || '开始' }} ~ {{ formatDate(query.endTs) || '现在' }}
      <button
        class="ml-0.5 hover:text-orange-900 dark:hover:text-orange-200"
        @click="(emit('remove', 'startTs'), emit('remove', 'endTs'))"
      >
        <UIcon name="i-heroicons-x-mark" class="h-3 w-3" />
      </button>
    </span>

    <!-- 关键词 -->
    <span
      v-for="kw in query.keywords"
      :key="kw"
      class="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
    >
      <UIcon name="i-heroicons-magnifying-glass" class="h-3 w-3" />
      {{ kw }}
    </span>
    <button
      v-if="query.keywords?.length"
      class="text-xs text-gray-400 hover:text-gray-600"
      @click="emit('remove', 'keywords')"
    >
      清除关键词
    </button>

    <!-- 清除全部 -->
    <button
      class="ml-auto text-xs text-gray-400 hover:text-red-500"
      @click="emit('clear-all')"
    >
      清除全部
    </button>
  </div>
</template>

