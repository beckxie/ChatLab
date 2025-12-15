<script setup lang="ts">
import { onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import Sidebar from '@/components/common/Sidebar.vue'
import SettingModal from '@/components/common/SettingModal.vue'
import ScreenCaptureModal from '@/components/common/ScreenCaptureModal.vue'
import { ChatRecordDrawer } from '@/components/common/ChatRecord'

const chatStore = useChatStore()
const { isInitialized } = storeToRefs(chatStore)
const route = useRoute()

const tooltip = {
  delayDuration: 100,
}

// 应用启动时从数据库加载会话列表
onMounted(async () => {
  await chatStore.loadSessions()
})
</script>

<template>
  <UApp :tooltip="tooltip">
    <div class="flex h-screen w-full overflow-hidden bg-white dark:bg-gray-950">
      <template v-if="!isInitialized">
        <div class="flex h-full w-full items-center justify-center">
          <div class="flex flex-col items-center justify-center text-center">
            <UIcon name="i-heroicons-arrow-path" class="h-8 w-8 animate-spin text-pink-500" />
            <p class="mt-2 text-sm text-gray-500">加载中...</p>
          </div>
        </div>
      </template>
      <template v-else>
        <Sidebar />
        <main class="flex-1 overflow-hidden">
          <router-view v-slot="{ Component }">
            <Transition name="page-fade" mode="out-in">
              <component :is="Component" :key="route.path" />
            </Transition>
          </router-view>
        </main>
      </template>
    </div>
    <SettingModal v-model:open="chatStore.showSettingModal" @ai-config-saved="chatStore.notifyAIConfigChanged" />
    <ScreenCaptureModal
      :open="chatStore.showScreenCaptureModal"
      :image-data="chatStore.screenCaptureImage"
      @update:open="(v) => (v ? null : chatStore.closeScreenCaptureModal())"
    />
    <!-- 全局聊天记录查看器 -->
    <ChatRecordDrawer />
  </UApp>
</template>

<style scoped>
.page-fade-enter-active,
.page-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.page-fade-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.page-fade-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
