<script setup lang="ts">
/**
 * 聊天记录筛选面板
 * 支持消息ID、成员、时间范围、关键词的组合筛选
 */
import { ref, watch, computed } from 'vue'
import dayjs from 'dayjs'
import type { ChatRecordQuery, FilterFormData } from './types'

const props = defineProps<{
  /** 当前查询条件 */
  query: ChatRecordQuery
  /** 是否展开 */
  expanded?: boolean
}>()

const emit = defineEmits<{
  /** 应用筛选 */
  (e: 'apply', query: ChatRecordQuery): void
  /** 重置筛选 */
  (e: 'reset'): void
  /** 切换展开状态 */
  (e: 'toggle'): void
}>()

// 本地表单数据
const formData = ref<FilterFormData>({
  messageId: '',
  memberName: '',
  keywords: '',
  startDate: '',
  endDate: '',
})

// 是否有输入
const hasInput = computed(() => {
  const f = formData.value
  return !!(f.messageId || f.memberName || f.keywords || f.startDate || f.endDate)
})

// 同步外部 query 到表单
watch(
  () => props.query,
  (query) => {
    if (query) {
      formData.value = {
        messageId: query.scrollToMessageId?.toString() || '',
        memberName: query.memberName || '',
        keywords: query.keywords?.join(', ') || '',
        startDate: query.startTs ? dayjs.unix(query.startTs).format('YYYY-MM-DD') : '',
        endDate: query.endTs ? dayjs.unix(query.endTs).format('YYYY-MM-DD') : '',
      }
    }
  },
  { immediate: true }
)

// 应用筛选
function applyFilter() {
  const f = formData.value
  const query: ChatRecordQuery = {}

  // 消息 ID
  if (f.messageId) {
    const id = parseInt(f.messageId, 10)
    if (!isNaN(id)) {
      query.scrollToMessageId = id
    }
  }

  // 成员名称（需要后续通过 API 获取成员 ID）
  if (f.memberName) {
    query.memberName = f.memberName
    // TODO: 这里可以添加成员搜索功能
  }

  // 关键词
  if (f.keywords) {
    const keywords = f.keywords
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter((k) => k)
    if (keywords.length > 0) {
      query.keywords = keywords
      query.highlightKeywords = keywords
    }
  }

  // 时间范围
  if (f.startDate) {
    query.startTs = dayjs(f.startDate).startOf('day').unix()
  }
  if (f.endDate) {
    query.endTs = dayjs(f.endDate).endOf('day').unix()
  }

  emit('apply', query)
}

// 重置筛选
function resetFilter() {
  formData.value = {
    messageId: '',
    memberName: '',
    keywords: '',
    startDate: '',
    endDate: '',
  }
  emit('reset')
}
</script>

<template>
  <div class="border-b border-gray-200 dark:border-gray-800">
    <!-- 折叠头部 -->
    <button
      class="flex w-full items-center justify-between px-4 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
      @click="emit('toggle')"
    >
      <span class="flex items-center gap-2">
        <UIcon name="i-heroicons-funnel" class="h-4 w-4" />
        <span>筛选条件</span>
        <span
          v-if="hasInput"
          class="rounded-full bg-blue-500 px-1.5 py-0.5 text-xs font-medium text-white"
        >
          已设置
        </span>
      </span>
      <UIcon
        :name="expanded ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
        class="h-4 w-4 transition-transform"
      />
    </button>

    <!-- 展开的筛选表单 -->
    <div v-if="expanded" class="space-y-3 px-4 pb-4">
      <!-- 消息 ID -->
      <div class="flex items-center gap-2">
        <label class="w-16 shrink-0 text-xs text-gray-500">消息 ID</label>
        <UInput
          v-model="formData.messageId"
          type="number"
          placeholder="输入消息 ID 定位"
          size="sm"
          class="flex-1"
        />
      </div>

      <!-- 成员 -->
      <div class="flex items-center gap-2">
        <label class="w-16 shrink-0 text-xs text-gray-500">成员</label>
        <UInput
          v-model="formData.memberName"
          placeholder="成员名称（暂不支持）"
          size="sm"
          class="flex-1"
          disabled
        />
      </div>

      <!-- 关键词 -->
      <div class="flex items-center gap-2">
        <label class="w-16 shrink-0 text-xs text-gray-500">关键词</label>
        <UInput
          v-model="formData.keywords"
          placeholder="多个用逗号分隔"
          size="sm"
          class="flex-1"
        />
      </div>

      <!-- 时间范围 -->
      <div class="flex items-center gap-2">
        <label class="w-16 shrink-0 text-xs text-gray-500">时间</label>
        <div class="flex flex-1 items-center gap-2">
          <UInput v-model="formData.startDate" type="date" size="sm" class="flex-1" />
          <span class="text-gray-400">~</span>
          <UInput v-model="formData.endDate" type="date" size="sm" class="flex-1" />
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="flex justify-end gap-2 pt-2">
        <UButton color="neutral" variant="ghost" size="sm" @click="resetFilter">
          重置
        </UButton>
        <UButton color="primary" size="sm" @click="applyFilter">
          应用筛选
        </UButton>
      </div>
    </div>
  </div>
</template>

