<script setup lang="ts">
/**
 * 聊天记录查看器 Drawer
 * 主组件，组合筛选面板、消息列表等子组件
 */
import { ref, watch, computed, toRaw, nextTick } from 'vue'
import { useChatStore } from '@/stores/chat'
import FilterPanel from './FilterPanel.vue'
import ActiveFilters from './ActiveFilters.vue'
import MessageList from './MessageList.vue'
import type { ChatRecordQuery } from './types'

const chatStore = useChatStore()

// 消息列表组件引用
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)

// 本地查询条件（可编辑的副本）
const localQuery = ref<ChatRecordQuery>({})

// 筛选面板是否展开
const filterExpanded = ref(false)

// 消息数量
const messageCount = ref(0)

// 计算是否有任何筛选条件
const hasActiveFilters = computed(() => {
  const q = localQuery.value
  return !!(q.scrollToMessageId || q.memberId || q.memberName || q.startTs || q.endTs || q.keywords?.length)
})

// 应用筛选
function handleApplyFilter(query: ChatRecordQuery) {
  localQuery.value = query
  filterExpanded.value = false
}

// 重置筛选
function handleResetFilter() {
  localQuery.value = {}
  filterExpanded.value = false
}

// 移除单个筛选条件
function handleRemoveFilter(key: keyof ChatRecordQuery) {
  const newQuery = { ...localQuery.value }
  delete newQuery[key]
  if (key === 'keywords') {
    delete newQuery.highlightKeywords
  }
  if (key === 'memberId') {
    delete newQuery.memberName
  }
  localQuery.value = newQuery
}

// 清除所有筛选
function handleClearAll() {
  localQuery.value = {}
}

// 切换筛选面板
function toggleFilterPanel() {
  filterExpanded.value = !filterExpanded.value
}

// 处理消息数量变化
function handleCountChange(count: number) {
  messageCount.value = count
}

// 监听 Drawer 打开
watch(
  () => chatStore.showChatRecordDrawer,
  async (isOpen) => {
    if (isOpen) {
      // 复制查询参数到本地
      const query = toRaw(chatStore.chatRecordQuery)
      localQuery.value = query ? { ...query } : {}
      // 如果有外部传入的筛选条件，默认不展开筛选面板
      filterExpanded.value = false
      // 等待 DOM 更新后主动触发加载
      await nextTick()
      messageListRef.value?.refresh()
    } else {
      // 关闭时清理
      localQuery.value = {}
      filterExpanded.value = false
      messageCount.value = 0
    }
  }
)
</script>

<template>
  <UDrawer v-model:open="chatStore.showChatRecordDrawer" direction="right" :handle="false">
    <template #content>
      <div class="flex h-full w-[580px] flex-col bg-white dark:bg-gray-900">
        <!-- 头部 -->
        <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <h3 class="text-lg font-semibold text-gray-900 dark:text-white">聊天记录查看器</h3>
          <UButton
            icon="i-heroicons-x-mark"
            color="neutral"
            variant="ghost"
            size="sm"
            @click="chatStore.closeChatRecordDrawer()"
          />
        </div>

        <!-- 筛选面板 -->
        <FilterPanel
          :query="localQuery"
          :expanded="filterExpanded"
          @apply="handleApplyFilter"
          @reset="handleResetFilter"
          @toggle="toggleFilterPanel"
        />

        <!-- 当前激活的筛选条件 -->
        <ActiveFilters
          v-if="hasActiveFilters && !filterExpanded"
          :query="localQuery"
          @remove="handleRemoveFilter"
          @clear-all="handleClearAll"
        />

        <!-- 消息列表 -->
        <MessageList
          ref="messageListRef"
          :query="localQuery"
          @count-change="handleCountChange"
        />

        <!-- 底部统计 -->
        <div v-if="messageCount > 0" class="border-t border-gray-200 px-4 py-2 dark:border-gray-800">
          <span class="text-xs text-gray-500">已加载 {{ messageCount }} 条消息</span>
        </div>
      </div>
    </template>
  </UDrawer>
</template>

