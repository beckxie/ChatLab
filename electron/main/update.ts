import { dialog, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { platform } from '@electron-toolkit/utils'
import { logger } from './logger'

let isFirstShow = true
const checkUpdate = (win) => {
  autoUpdater.autoDownload = false // 自动下载
  autoUpdater.autoInstallOnAppQuit = true // 应用退出后自动安装

  // 开发模式下模拟更新检测（需要创建 dev-app-update.yml 文件）
  // 取消下面的注释来启用开发模式更新测试
  // if (!app.isPackaged) {
  //   Object.defineProperty(app, 'isPackaged', {
  //     get() {
  //       return true
  //     },
  //   })
  // }

  let showUpdateMessageBox = false
  autoUpdater.on('update-available', (info) => {
    // win.webContents.send('show-message', 'electron:发现新版本')
    if (showUpdateMessageBox) return
    showUpdateMessageBox = true

    // 解析更新日志
    let releaseNotes = ''
    if (info.releaseNotes) {
      if (typeof info.releaseNotes === 'string') {
        releaseNotes = info.releaseNotes
      } else if (Array.isArray(info.releaseNotes)) {
        releaseNotes = info.releaseNotes.map((note) => note.note || note).join('\n')
      }
      // 简单清理 HTML 标签
      releaseNotes = releaseNotes.replace(/<[^>]*>/g, '').trim()
    }

    const detail = releaseNotes
      ? `更新内容：\n${releaseNotes}\n\n是否立即下载并安装新版本？`
      : '是否立即下载并安装新版本？'

    dialog
      .showMessageBox({
        title: '发现新版本 v' + info.version,
        message: '发现新版本 v' + info.version,
        detail,
        buttons: ['立即下载', '取消'],
        defaultId: 0,
        cancelId: 1,
        type: 'question',
        noLink: true,
      })
      .then((result) => {
        showUpdateMessageBox = false
        if (result.response === 0) {
          autoUpdater
            .downloadUpdate()
            .then(() => {
              console.log('wait for post download operation')
            })
            .catch((downloadError) => {
              // 下载失败记录到日志，不显示给用户
              logger.error(`[Update] 下载更新失败: ${downloadError}`)
            })
        }
      })
  })

  // 监听下载进度事件
  autoUpdater.on('download-progress', (progressObj) => {
    console.log(`更新下载进度: ${progressObj.percent}%`)
    win.webContents.send('update-download-progress', progressObj.percent)
  })

  // 下载完成
  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox({
        title: '下载完成',
        message: '新版本已准备就绪，是否现在安装？',
        buttons: ['安装', platform.isMacOS ? '之后提醒' : '稍后（应用退出后自动安装）'],
        defaultId: 1,
        cancelId: 2,
        type: 'question',
      })
      .then((result) => {
        if (result.response === 0) {
          win.webContents.send('begin-install')
          // @ts-ignore
          app.isQuiting = true
          setTimeout(() => {
            setImmediate(() => {
              autoUpdater.quitAndInstall()
            })
          }, 100)
        }
      })
  })

  // 不需要更新
  autoUpdater.on('update-not-available', (info) => {
    // 客户端打开会默认弹一次，用isFirstShow来控制不弹
    if (isFirstShow) {
      isFirstShow = false
    } else {
      win.webContents.send('show-message', {
        type: 'success',
        message: '已是最新版本',
      })
    }
  })

  // 错误处理（静默处理，记录到日志）
  autoUpdater.on('error', (err) => {
    // 更新错误记录到日志，不显示给用户
    logger.error(`[Update] 更新错误: ${err.message || err}`)
  })

  // 等待 3 秒再检查更新，确保窗口准备完成，用户进入系统
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log('[Update] 检查更新失败:', err)
    })
  }, 3000)
}

/**
 * 模拟更新弹窗（仅用于开发测试）
 * 控制台通过：window.api.app.simulateUpdate() 测试
 */
const simulateUpdateDialog = (win) => {
  const mockInfo = {
    version: '9.9.9',
    releaseNotes: `## 更新内容\n\n- 🎉 新增聊天记录查看器\n- 🔧 修复已知问题\n- ⚡️ 性能优化`,
  }

  // 解析更新日志
  let releaseNotes = mockInfo.releaseNotes.replace(/<[^>]*>/g, '').trim()

  const detail = releaseNotes
    ? `更新内容：\n${releaseNotes}\n\n是否立即下载并安装新版本？`
    : '是否立即下载并安装新版本？'

  dialog.showMessageBox({
    title: '发现新版本 v' + mockInfo.version,
    message: '发现新版本 v' + mockInfo.version,
    detail,
    buttons: ['立即下载', '取消'],
    defaultId: 0,
    cancelId: 1,
    type: 'question',
    noLink: true,
  })
}

export { checkUpdate, simulateUpdateDialog }
