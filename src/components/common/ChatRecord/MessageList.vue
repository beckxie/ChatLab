<script setup lang="ts">
/**
 * 消息列表组件
 * 支持无限滚动加载
 */
import { ref, watch, nextTick, toRaw } from 'vue'
import { useChatStore } from '@/stores/chat'
import MessageItem from './MessageItem.vue'
import type { ChatRecordMessage, ChatRecordQuery } from './types'

const props = defineProps<{
  /** 当前查询条件 */
  query: ChatRecordQuery
}>()

const emit = defineEmits<{
  /** 消息数量变化 */
  (e: 'count-change', count: number): void
}>()

const chatStore = useChatStore()

// 消息列表
const messages = ref<ChatRecordMessage[]>([])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const hasMoreBefore = ref(false)
const hasMoreAfter = ref(false)

// 滚动容器引用
const scrollContainerRef = ref<HTMLElement | null>(null)

// 构建筛选参数
function buildFilterParams(query: ChatRecordQuery) {
  return {
    filter: query.startTs || query.endTs ? { startTs: query.startTs, endTs: query.endTs } : undefined,
    senderId: query.memberId,
    keywords: query.keywords ? [...toRaw(query.keywords)] : undefined,
  }
}

// 初始加载消息
async function loadInitialMessages() {
  const sessionId = chatStore.currentSessionId
  if (!sessionId) {
    messages.value = []
    emit('count-change', 0)
    return
  }

  isLoading.value = true
  messages.value = []

  try {
    const query = toRaw(props.query)
    const { filter, senderId, keywords } = buildFilterParams(query)
    const targetId = query.scrollToMessageId

    if (targetId) {
      // 以目标消息为中心，加载前后各 50 条
      const [beforeResult, afterResult] = await Promise.all([
        window.aiApi.getMessagesBefore(sessionId, targetId, 50, filter, senderId, keywords),
        window.aiApi.getMessagesAfter(sessionId, targetId, 50, filter, senderId, keywords),
      ])

      // 获取目标消息本身
      const targetMessages = await window.aiApi.getMessageContext(sessionId, targetId, 0)

      // 合并消息列表
      messages.value = [...beforeResult.messages, ...targetMessages, ...afterResult.messages]

      hasMoreBefore.value = beforeResult.hasMore
      hasMoreAfter.value = afterResult.hasMore

      // 滚动到目标消息（延时确保 DOM 完全渲染）
      await nextTick()
      setTimeout(() => {
        scrollToMessage(targetId)
      }, 100)
    } else {
      // 没有目标消息，加载最新的 100 条
      const result = await window.aiApi.getRecentMessages(sessionId, filter, 100)
      messages.value = result.messages
      hasMoreBefore.value = result.messages.length >= 100
      hasMoreAfter.value = false
    }

    emit('count-change', messages.value.length)
  } catch (e) {
    console.error('加载消息失败:', e)
    messages.value = []
    emit('count-change', 0)
  } finally {
    isLoading.value = false
  }
}

// 加载更早的消息（向上滚动）
async function loadMoreBefore() {
  if (isLoadingMore.value || !hasMoreBefore.value || messages.value.length === 0) return

  const sessionId = chatStore.currentSessionId
  if (!sessionId) return

  const firstMessage = messages.value[0]
  if (!firstMessage) return

  isLoadingMore.value = true

  try {
    const query = toRaw(props.query)
    const { filter, senderId, keywords } = buildFilterParams(query)
    const result = await window.aiApi.getMessagesBefore(sessionId, firstMessage.id, 50, filter, senderId, keywords)

    if (result.messages.length > 0) {
      // 记录当前滚动位置
      const container = scrollContainerRef.value
      const oldScrollHeight = container?.scrollHeight || 0

      // prepend 消息
      messages.value = [...result.messages, ...messages.value]

      // 恢复滚动位置
      await nextTick()
      if (container) {
        const newScrollHeight = container.scrollHeight
        container.scrollTop = newScrollHeight - oldScrollHeight
      }

      emit('count-change', messages.value.length)
    }

    hasMoreBefore.value = result.hasMore
  } catch (e) {
    console.error('加载更早消息失败:', e)
  } finally {
    isLoadingMore.value = false
  }
}

// 加载更新的消息（向下滚动）
async function loadMoreAfter() {
  if (isLoadingMore.value || !hasMoreAfter.value || messages.value.length === 0) return

  const sessionId = chatStore.currentSessionId
  if (!sessionId) return

  const lastMessage = messages.value[messages.value.length - 1]
  if (!lastMessage) return

  isLoadingMore.value = true

  try {
    const query = toRaw(props.query)
    const { filter, senderId, keywords } = buildFilterParams(query)
    const result = await window.aiApi.getMessagesAfter(sessionId, lastMessage.id, 50, filter, senderId, keywords)

    if (result.messages.length > 0) {
      messages.value = [...messages.value, ...result.messages]
      emit('count-change', messages.value.length)
    }

    hasMoreAfter.value = result.hasMore
  } catch (e) {
    console.error('加载更新消息失败:', e)
  } finally {
    isLoadingMore.value = false
  }
}

// 滚动到指定消息
function scrollToMessage(messageId: number) {
  const container = scrollContainerRef.value
  if (!container) return

  const messageEl = container.querySelector(`[data-message-id="${messageId}"]`)
  if (messageEl) {
    messageEl.scrollIntoView({ block: 'center', behavior: 'auto' })
  }
}

// 处理滚动事件（检测边界）
function handleScroll() {
  const container = scrollContainerRef.value
  if (!container || isLoadingMore.value) return

  // 接近顶部时加载更多
  if (container.scrollTop < 100 && hasMoreBefore.value) {
    loadMoreBefore()
  }

  // 接近底部时加载更多
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  if (distanceFromBottom < 100 && hasMoreAfter.value) {
    loadMoreAfter()
  }
}

// 判断是否是目标消息
function isTargetMessage(msgId: number): boolean {
  return msgId === props.query.scrollToMessageId
}

// 监听查询变化
watch(
  () => props.query,
  () => {
    loadInitialMessages()
  },
  { deep: true }
)

// 暴露刷新方法
defineExpose({
  refresh: loadInitialMessages,
})
</script>

<template>
  <div class="flex-1 overflow-hidden">
    <!-- 加载中 -->
    <div v-if="isLoading" class="flex h-full items-center justify-center">
      <div class="text-center">
        <UIcon name="i-heroicons-arrow-path" class="h-8 w-8 animate-spin text-gray-400" />
        <p class="mt-2 text-sm text-gray-500">加载中...</p>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="messages.length === 0" class="flex h-full items-center justify-center">
      <div class="text-center">
        <UIcon name="i-heroicons-chat-bubble-left-right" class="h-12 w-12 text-gray-300 dark:text-gray-600" />
        <p class="mt-2 text-sm text-gray-500">暂无消息</p>
        <p class="mt-1 text-xs text-gray-400">尝试调整筛选条件</p>
      </div>
    </div>

    <!-- 消息滚动容器 -->
    <div v-else ref="scrollContainerRef" class="h-full overflow-y-auto" @scroll="handleScroll">
      <!-- 顶部加载指示器 -->
      <div v-if="hasMoreBefore" class="flex justify-center py-2">
        <span v-if="isLoadingMore" class="text-xs text-gray-400">
          <UIcon name="i-heroicons-arrow-path" class="mr-1 inline h-3 w-3 animate-spin" />
          加载更多...
        </span>
        <span v-else class="text-xs text-gray-400">↑ 向上滚动加载更多</span>
      </div>

      <!-- 消息列表 -->
      <div class="divide-y divide-gray-100 dark:divide-gray-800">
        <MessageItem
          v-for="msg in messages"
          :key="msg.id"
          :data-message-id="msg.id"
          :message="msg"
          :is-target="isTargetMessage(msg.id)"
          :highlight-keywords="query.highlightKeywords"
        />
      </div>

      <!-- 底部加载指示器 -->
      <div v-if="hasMoreAfter" class="flex justify-center py-2">
        <span v-if="isLoadingMore" class="text-xs text-gray-400">
          <UIcon name="i-heroicons-arrow-path" class="mr-1 inline h-3 w-3 animate-spin" />
          加载更多...
        </span>
        <span v-else class="text-xs text-gray-400">↓ 向下滚动加载更多</span>
      </div>
    </div>
  </div>
</template>

