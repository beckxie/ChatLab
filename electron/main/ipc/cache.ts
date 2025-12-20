// electron/main/ipc/cache.ts
import { ipcMain, app, shell } from 'electron'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import type { IpcContext } from './types'

/**
 * 获取 ChatLab 数据目录
 */
function getChatLabDir(): string {
  try {
    const docPath = app.getPath('documents')
    return path.join(docPath, 'ChatLab')
  } catch {
    return path.join(process.cwd(), 'ChatLab')
  }
}

/**
 * 递归计算目录大小
 */
async function getDirSize(dirPath: string): Promise<number> {
  let totalSize = 0
  try {
    const exists = fsSync.existsSync(dirPath)
    if (!exists) return 0

    const files = await fs.readdir(dirPath, { withFileTypes: true })
    for (const file of files) {
      const filePath = path.join(dirPath, file.name)
      if (file.isDirectory()) {
        totalSize += await getDirSize(filePath)
      } else {
        const stat = await fs.stat(filePath)
        totalSize += stat.size
      }
    }
  } catch (error) {
    console.error('[Cache] Error getting dir size:', dirPath, error)
  }
  return totalSize
}

/**
 * 获取目录中的文件数量
 */
async function getFileCount(dirPath: string): Promise<number> {
  let count = 0
  try {
    const exists = fsSync.existsSync(dirPath)
    if (!exists) return 0

    const files = await fs.readdir(dirPath, { withFileTypes: true })
    for (const file of files) {
      const filePath = path.join(dirPath, file.name)
      if (file.isDirectory()) {
        count += await getFileCount(filePath)
      } else {
        count++
      }
    }
  } catch (error) {
    console.error('[Cache] Error getting file count:', dirPath, error)
  }
  return count
}

export function registerCacheHandlers(_context: IpcContext): void {
  console.log('[IPC] Registering cache handlers...')

  /**
   * 获取所有缓存目录信息
   */
  ipcMain.handle('cache:getInfo', async () => {
    const chatLabDir = getChatLabDir()

    // 定义缓存目录
    const cacheDirectories = [
      {
        id: 'databases',
        name: '聊天记录数据库',
        description: '导入的聊天记录分析数据',
        path: path.join(chatLabDir, 'databases'),
        icon: 'i-heroicons-circle-stack',
        canClear: false, // 不允许一键清理，因为是重要数据
      },
      {
        id: 'ai',
        name: 'AI 对话数据库',
        description: 'AI 对话历史和配置文件',
        path: path.join(chatLabDir, 'ai'),
        icon: 'i-heroicons-sparkles',
        canClear: false, // 不允许一键清理
      },
      // 临时文件已有自动清理机制（应用启动时、合并完成后），无需暴露给用户
      {
        id: 'downloads',
        name: '下载目录',
        description: '包含截屏文件、分析结果等',
        path: path.join(chatLabDir, 'downloads'),
        icon: 'i-heroicons-arrow-down-tray',
        canClear: true, // 可以清理
      },
      {
        id: 'logs',
        name: '日志文件',
        description: '软件的运行日志，包含导入、AI、错误等日志',
        path: path.join(chatLabDir, 'logs'),
        icon: 'i-heroicons-document-text',
        canClear: true, // 可以清理
      },
    ]

    // 获取每个目录的信息
    const results = await Promise.all(
      cacheDirectories.map(async (dir) => {
        const size = await getDirSize(dir.path)
        const fileCount = await getFileCount(dir.path)
        const exists = fsSync.existsSync(dir.path)

        return {
          ...dir,
          size,
          fileCount,
          exists,
        }
      })
    )

    return {
      baseDir: chatLabDir,
      directories: results,
      totalSize: results.reduce((sum, dir) => sum + dir.size, 0),
    }
  })

  /**
   * 清理指定缓存目录
   */
  ipcMain.handle('cache:clear', async (_, cacheId: string) => {
    const chatLabDir = getChatLabDir()

    // 只允许清理 downloads 和 logs（temp 由系统自动清理）
    const allowedDirs: Record<string, string> = {
      downloads: path.join(chatLabDir, 'downloads'),
      logs: path.join(chatLabDir, 'logs'),
    }

    const dirPath = allowedDirs[cacheId]
    if (!dirPath) {
      return { success: false, error: '不允许清理此目录' }
    }

    try {
      const exists = fsSync.existsSync(dirPath)
      if (!exists) {
        return { success: true, message: '目录不存在，无需清理' }
      }

      // 删除目录下的所有文件
      const files = await fs.readdir(dirPath)
      for (const file of files) {
        const filePath = path.join(dirPath, file)
        const stat = await fs.stat(filePath)
        if (stat.isDirectory()) {
          await fs.rm(filePath, { recursive: true })
        } else {
          await fs.unlink(filePath)
        }
      }

      console.log(`[Cache] Cleared directory: ${dirPath}`)
      return { success: true }
    } catch (error) {
      console.error('[Cache] Error clearing cache:', error)
      return { success: false, error: String(error) }
    }
  })

  /**
   * 保存文件到下载目录
   */
  ipcMain.handle('cache:saveToDownloads', async (_, filename: string, dataUrl: string) => {
    const chatLabDir = getChatLabDir()
    const downloadsDir = path.join(chatLabDir, 'downloads')

    try {
      // 确保目录存在
      if (!fsSync.existsSync(downloadsDir)) {
        await fs.mkdir(downloadsDir, { recursive: true })
      }

      // 从 data URL 中提取 base64 数据
      const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '')
      const buffer = Buffer.from(base64Data, 'base64')

      // 写入文件
      const filePath = path.join(downloadsDir, filename)
      await fs.writeFile(filePath, buffer)

      console.log(`[Cache] Saved file to downloads: ${filePath}`)
      return { success: true, filePath }
    } catch (error) {
      console.error('[Cache] Error saving to downloads:', error)
      return { success: false, error: String(error) }
    }
  })

  /**
   * 在文件管理器中打开缓存目录
   */
  ipcMain.handle('cache:openDir', async (_, cacheId: string) => {
    const chatLabDir = getChatLabDir()

    const dirPaths: Record<string, string> = {
      base: chatLabDir,
      databases: path.join(chatLabDir, 'databases'),
      downloads: path.join(chatLabDir, 'downloads'),
      ai: path.join(chatLabDir, 'ai'),
      logs: path.join(chatLabDir, 'logs'),
    }

    const dirPath = dirPaths[cacheId]
    if (!dirPath) {
      return { success: false, error: '未知的目录' }
    }

    try {
      // 确保目录存在
      if (!fsSync.existsSync(dirPath)) {
        await fs.mkdir(dirPath, { recursive: true })
      }

      await shell.openPath(dirPath)
      return { success: true }
    } catch (error) {
      console.error('[Cache] Error opening directory:', error)
      return { success: false, error: String(error) }
    }
  })
}
