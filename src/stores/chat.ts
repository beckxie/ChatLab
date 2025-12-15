import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  AnalysisSession,
  ImportProgress,
  KeywordTemplate,
  PromptPreset,
  AIPromptSettings,
  ChatRecordQuery,
} from '@/types/chat'
import {
  BUILTIN_PRESETS,
  DEFAULT_GROUP_PRESET_ID,
  DEFAULT_PRIVATE_PRESET_ID,
  CYBER_JUDGE_GROUP_PRESET_ID,
  CYBER_JUDGE_PRIVATE_PRESET_ID,
  getOriginalBuiltinPreset,
} from '@/config/prompts'

// 重新导出常量，保持向后兼容
export { DEFAULT_GROUP_PRESET_ID, DEFAULT_PRIVATE_PRESET_ID, BUILTIN_PRESETS }

export const useChatStore = defineStore(
  'chat',
  () => {
    // 会话列表
    const sessions = ref<AnalysisSession[]>([])
    // 当前选中的会话ID
    const currentSessionId = ref<string | null>(null)
    // 导入状态
    const isImporting = ref(false)
    const importProgress = ref<ImportProgress | null>(null)

    // 当前选中的会话
    const currentSession = computed(() => {
      if (!currentSessionId.value) return null
      return sessions.value.find((s) => s.id === currentSessionId.value) || null
    })

    // 是否已初始化
    const isInitialized = ref(false)

    /**
     * 从数据库加载会话列表
     */
    async function loadSessions() {
      try {
        const list = await window.chatApi.getSessions()
        sessions.value = list
        // 如果当前选中的会话不存在了，清除选中状态
        if (currentSessionId.value && !list.find((s) => s.id === currentSessionId.value)) {
          currentSessionId.value = null
        }
        isInitialized.value = true
      } catch (error) {
        console.error('加载会话列表失败:', error)
        isInitialized.value = true
      }
    }

    /**
     * 选择文件并导入
     */
    async function importFile(): Promise<{ success: boolean; error?: string }> {
      try {
        // 选择文件
        const result = await window.chatApi.selectFile()
        if (!result || !result.filePath) {
          return { success: false, error: '未选择文件' }
        }
        if (result.error) {
          return { success: false, error: result.error }
        }

        // 使用共享的导入逻辑
        return await importFileFromPath(result.filePath)
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }

    /**
     * 从文件路径直接导入（用于拖拽导入）
     */
    async function importFileFromPath(filePath: string): Promise<{ success: boolean; error?: string }> {
      try {
        // 开始导入
        isImporting.value = true

        // 初始化状态
        importProgress.value = {
          stage: 'detecting',
          progress: 0,
          message: '准备导入...',
        }

        // 进度队列控制
        const queue: ImportProgress[] = []
        let isProcessing = false
        let currentStage = 'reading'
        let lastStageTime = Date.now()
        const MIN_STAGE_TIME = 1000 // 每个阶段至少展示1秒

        const processQueue = async () => {
          if (isProcessing) return
          isProcessing = true

          while (queue.length > 0) {
            const next = queue[0]

            // 如果阶段发生变化，确保上一阶段展示了足够时间
            if (next.stage !== currentStage) {
              const elapsed = Date.now() - lastStageTime
              if (elapsed < MIN_STAGE_TIME) {
                await new Promise((resolve) => setTimeout(resolve, MIN_STAGE_TIME - elapsed))
              }
              currentStage = next.stage
              lastStageTime = Date.now()
            }

            // 更新状态
            importProgress.value = queue.shift()!
          }
          isProcessing = false
        }

        // 监听导入进度
        const unsubscribe = window.chatApi.onImportProgress((progress) => {
          // 跳过完成状态，直接跳转
          if (progress.stage === 'done') return
          queue.push(progress)
          processQueue()
        })

        // 执行导入
        const importResult = await window.chatApi.import(filePath)

        // 取消监听
        unsubscribe()

        // 等待队列处理完成
        while (queue.length > 0 || isProcessing) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        // 确保最后一个阶段也展示足够时间
        const elapsed = Date.now() - lastStageTime
        if (elapsed < MIN_STAGE_TIME) {
          await new Promise((resolve) => setTimeout(resolve, MIN_STAGE_TIME - elapsed))
        }

        // 确保进度条走完
        if (importProgress.value) {
          importProgress.value.progress = 100
        }

        // 给一点时间展示 100%
        await new Promise((resolve) => setTimeout(resolve, 300))

        if (importResult.success && importResult.sessionId) {
          // 刷新会话列表
          await loadSessions()
          // 自动选中新导入的会话，进入分析页面
          currentSessionId.value = importResult.sessionId
          return { success: true }
        } else {
          return { success: false, error: importResult.error || '导入失败' }
        }
      } catch (error) {
        return { success: false, error: String(error) }
      } finally {
        isImporting.value = false
        // 延迟清除进度，让用户看到完成状态
        setTimeout(() => {
          importProgress.value = null
        }, 500)
      }
    }

    /**
     * 选择会话
     */
    function selectSession(id: string) {
      currentSessionId.value = id
    }

    /**
     * 删除会话
     */
    async function deleteSession(id: string): Promise<boolean> {
      try {
        const success = await window.chatApi.deleteSession(id)
        if (success) {
          // 从列表中移除
          const index = sessions.value.findIndex((s) => s.id === id)
          if (index !== -1) {
            sessions.value.splice(index, 1)
          }
          // 如果删除的是当前选中的会话，清除选中状态
          if (currentSessionId.value === id) {
            currentSessionId.value = null
          }
          // 强制从后端刷新会话列表，确保与文件系统同步
          await loadSessions()
        }
        return success
      } catch (error) {
        console.error('删除会话失败:', error)
        return false
      }
    }

    /**
     * 重命名会话
     */
    async function renameSession(id: string, newName: string): Promise<boolean> {
      try {
        const success = await window.chatApi.renameSession(id, newName)
        if (success) {
          // 更新本地列表中的名称
          const session = sessions.value.find((s) => s.id === id)
          if (session) {
            session.name = newName
          }
        }
        return success
      } catch (error) {
        console.error('重命名会话失败:', error)
        return false
      }
    }

    /**
     * 清除选中状态
     */
    function clearSelection() {
      currentSessionId.value = null
    }

    // 侧边栏状态
    const isSidebarCollapsed = ref(false)

    function toggleSidebar() {
      isSidebarCollapsed.value = !isSidebarCollapsed.value
    }

    // 设置弹窗状态
    const showSettingModal = ref(false)

    // 截屏弹窗状态
    const showScreenCaptureModal = ref(false)
    const screenCaptureImage = ref<string | null>(null)

    function openScreenCaptureModal(imageData: string) {
      screenCaptureImage.value = imageData
      showScreenCaptureModal.value = true
    }

    function closeScreenCaptureModal() {
      showScreenCaptureModal.value = false
      // 延迟清除图片数据，避免关闭动画时闪烁
      setTimeout(() => {
        screenCaptureImage.value = null
      }, 300)
    }

    // ==================== 聊天记录查看器 Drawer ====================
    const showChatRecordDrawer = ref(false)
    const chatRecordQuery = ref<ChatRecordQuery | null>(null)

    /**
     * 打开聊天记录查看器
     * @param query 查询参数，支持组合查询
     */
    function openChatRecordDrawer(query: ChatRecordQuery) {
      chatRecordQuery.value = query
      showChatRecordDrawer.value = true
    }

    /**
     * 关闭聊天记录查看器
     */
    function closeChatRecordDrawer() {
      showChatRecordDrawer.value = false
      // 延迟清除查询参数，避免关闭动画时内容闪烁
      setTimeout(() => {
        chatRecordQuery.value = null
      }, 300)
    }

    // AI 配置更新计数器（用于触发其他组件刷新）
    const aiConfigVersion = ref(0)

    function notifyAIConfigChanged() {
      aiConfigVersion.value++
    }

    // AI 全局设置
    interface AIGlobalSettings {
      /** 每次发送给 AI 的最大消息条数 */
      maxMessagesPerRequest: number
    }

    const aiGlobalSettings = ref<AIGlobalSettings>({
      maxMessagesPerRequest: 200,
    })

    function updateAIGlobalSettings(settings: Partial<AIGlobalSettings>) {
      aiGlobalSettings.value = { ...aiGlobalSettings.value, ...settings }
      notifyAIConfigChanged()
    }

    // ==================== 自定义关键词模板 ====================
    const customKeywordTemplates = ref<KeywordTemplate[]>([])

    function addCustomKeywordTemplate(template: KeywordTemplate) {
      customKeywordTemplates.value.push(template)
    }

    function updateCustomKeywordTemplate(templateId: string, updates: Partial<Omit<KeywordTemplate, 'id'>>) {
      const index = customKeywordTemplates.value.findIndex((t) => t.id === templateId)
      if (index !== -1) {
        customKeywordTemplates.value[index] = {
          ...customKeywordTemplates.value[index],
          ...updates,
        }
      }
    }

    function removeCustomKeywordTemplate(templateId: string) {
      const index = customKeywordTemplates.value.findIndex((t) => t.id === templateId)
      if (index !== -1) {
        customKeywordTemplates.value.splice(index, 1)
      }
    }

    // ==================== 已删除的预设模板 ====================
    const deletedPresetTemplateIds = ref<string[]>([])

    // ==================== AI 提示词预设管理 ====================
    const customPromptPresets = ref<PromptPreset[]>([])
    /** 内置预设的用户覆盖（key: presetId, value: 覆盖的字段） */
    const builtinPresetOverrides = ref<
      Record<string, { name?: string; roleDefinition?: string; responseRules?: string; updatedAt?: number }>
    >({})
    const aiPromptSettings = ref<AIPromptSettings>({
      activeGroupPresetId: CYBER_JUDGE_GROUP_PRESET_ID,
      activePrivatePresetId: CYBER_JUDGE_PRIVATE_PRESET_ID,
    })

    /** 获取所有预设（内置+覆盖 + 自定义） */
    const allPromptPresets = computed(() => {
      // 合并内置预设和用户覆盖
      const mergedBuiltins = BUILTIN_PRESETS.map((preset) => {
        const override = builtinPresetOverrides.value[preset.id]
        if (override) {
          return {
            ...preset,
            ...override,
          }
        }
        return preset
      })
      return [...mergedBuiltins, ...customPromptPresets.value]
    })

    /** 获取群聊可用的预设 */
    const groupPresets = computed(() => allPromptPresets.value.filter((p) => p.chatType === 'group'))

    /** 获取私聊可用的预设 */
    const privatePresets = computed(() => allPromptPresets.value.filter((p) => p.chatType === 'private'))

    /** 获取当前群聊激活的预设 */
    const activeGroupPreset = computed(() => {
      const preset = allPromptPresets.value.find((p) => p.id === aiPromptSettings.value.activeGroupPresetId)
      return preset || BUILTIN_PRESETS.find((p) => p.id === DEFAULT_GROUP_PRESET_ID)!
    })

    /** 获取当前私聊激活的预设 */
    const activePrivatePreset = computed(() => {
      const preset = allPromptPresets.value.find((p) => p.id === aiPromptSettings.value.activePrivatePresetId)
      return preset || BUILTIN_PRESETS.find((p) => p.id === DEFAULT_PRIVATE_PRESET_ID)!
    })

    /** 添加自定义预设 */
    function addPromptPreset(preset: {
      name: string
      chatType: PromptPreset['chatType']
      roleDefinition: string
      responseRules: string
    }) {
      const newPreset: PromptPreset = {
        ...preset,
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        isBuiltIn: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      customPromptPresets.value.push(newPreset)
      return newPreset.id
    }

    /** 更新预设（支持内置和自定义） */
    function updatePromptPreset(
      presetId: string,
      updates: { name?: string; chatType?: PromptPreset['chatType']; roleDefinition?: string; responseRules?: string }
    ) {
      // 检查是否是内置预设
      const isBuiltin = BUILTIN_PRESETS.some((p) => p.id === presetId)
      if (isBuiltin) {
        // 更新内置预设的覆盖
        builtinPresetOverrides.value[presetId] = {
          ...builtinPresetOverrides.value[presetId],
          name: updates.name,
          roleDefinition: updates.roleDefinition,
          responseRules: updates.responseRules,
          updatedAt: Date.now(),
        }
        return
      }

      // 更新自定义预设
      const index = customPromptPresets.value.findIndex((p) => p.id === presetId)
      if (index !== -1) {
        customPromptPresets.value[index] = {
          ...customPromptPresets.value[index],
          ...updates,
          updatedAt: Date.now(),
        }
      }
    }

    /** 重置内置预设为原始值 */
    function resetBuiltinPreset(presetId: string): boolean {
      const original = getOriginalBuiltinPreset(presetId)
      if (!original) return false

      // 删除覆盖
      delete builtinPresetOverrides.value[presetId]
      return true
    }

    /** 检查内置预设是否被修改过 */
    function isBuiltinPresetModified(presetId: string): boolean {
      return !!builtinPresetOverrides.value[presetId]
    }

    /** 删除自定义预设 */
    function removePromptPreset(presetId: string) {
      const index = customPromptPresets.value.findIndex((p) => p.id === presetId)
      if (index !== -1) {
        customPromptPresets.value.splice(index, 1)
        // 如果删除的是激活的预设，切换到默认
        if (aiPromptSettings.value.activeGroupPresetId === presetId) {
          aiPromptSettings.value.activeGroupPresetId = DEFAULT_GROUP_PRESET_ID
        }
        if (aiPromptSettings.value.activePrivatePresetId === presetId) {
          aiPromptSettings.value.activePrivatePresetId = DEFAULT_PRIVATE_PRESET_ID
        }
      }
    }

    /** 复制预设 */
    function duplicatePromptPreset(presetId: string) {
      const source = allPromptPresets.value.find((p) => p.id === presetId)
      if (source) {
        return addPromptPreset({
          name: `${source.name} (副本)`,
          chatType: source.chatType,
          roleDefinition: source.roleDefinition,
          responseRules: source.responseRules,
        })
      }
      return null
    }

    /** 设置群聊激活的预设 */
    function setActiveGroupPreset(presetId: string) {
      const preset = allPromptPresets.value.find((p) => p.id === presetId)
      if (preset && preset.chatType === 'group') {
        aiPromptSettings.value.activeGroupPresetId = presetId
        notifyAIConfigChanged()
      }
    }

    /** 设置私聊激活的预设 */
    function setActivePrivatePreset(presetId: string) {
      const preset = allPromptPresets.value.find((p) => p.id === presetId)
      if (preset && preset.chatType === 'private') {
        aiPromptSettings.value.activePrivatePresetId = presetId
        notifyAIConfigChanged()
      }
    }

    /** 获取指定聊天类型的激活预设 */
    function getActivePresetForChatType(chatType: 'group' | 'private'): PromptPreset {
      return chatType === 'group' ? activeGroupPreset.value : activePrivatePreset.value
    }

    function addDeletedPresetTemplateId(id: string) {
      if (!deletedPresetTemplateIds.value.includes(id)) {
        deletedPresetTemplateIds.value.push(id)
      }
    }

    return {
      // State
      sessions,
      currentSessionId,
      isImporting,
      importProgress,
      isInitialized,
      isSidebarCollapsed,
      showSettingModal,
      showScreenCaptureModal,
      screenCaptureImage,
      showChatRecordDrawer,
      chatRecordQuery,
      aiConfigVersion,
      aiGlobalSettings,
      customKeywordTemplates,
      deletedPresetTemplateIds,
      customPromptPresets,
      builtinPresetOverrides,
      aiPromptSettings,
      // Computed
      currentSession,
      allPromptPresets,
      groupPresets,
      privatePresets,
      activeGroupPreset,
      activePrivatePreset,
      // Actions
      loadSessions,
      importFile,
      importFileFromPath,
      selectSession,
      deleteSession,
      renameSession,
      clearSelection,
      toggleSidebar,
      openScreenCaptureModal,
      closeScreenCaptureModal,
      openChatRecordDrawer,
      closeChatRecordDrawer,
      notifyAIConfigChanged,
      updateAIGlobalSettings,
      addCustomKeywordTemplate,
      updateCustomKeywordTemplate,
      removeCustomKeywordTemplate,
      addDeletedPresetTemplateId,
      addPromptPreset,
      updatePromptPreset,
      removePromptPreset,
      duplicatePromptPreset,
      setActiveGroupPreset,
      setActivePrivatePreset,
      getActivePresetForChatType,
      resetBuiltinPreset,
      isBuiltinPresetModified,
    }
  },
  {
    persist: [
      {
        // 会话状态：sessionStorage（页面刷新保留，应用重启清除）
        pick: ['currentSessionId', 'isSidebarCollapsed'],
        storage: sessionStorage,
      },
      {
        // 自定义模板、AI 全局设置和提示词预设：localStorage（持久保存）
        pick: [
          'customKeywordTemplates',
          'deletedPresetTemplateIds',
          'aiGlobalSettings',
          'customPromptPresets',
          'builtinPresetOverrides',
          'aiPromptSettings',
        ],
        storage: localStorage,
      },
    ],
  }
)
