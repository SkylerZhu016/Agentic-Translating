export const ELECTRON_LOCALES = ['zh-CN', 'en']

const zhCN = {
  'credential.unavailable.title': '无法使用 Windows 凭据保护',
  'credential.unavailable.message': '系统暂时无法提供安全存储，应用不会降级为明文保存密钥。',
  'credential.unavailable.detail': '可以重试、打开数据目录检查环境，或退出应用。',
  'credential.unreadable.title': '本地凭据无法解密',
  'credential.unreadable.message': '翻译历史仍然完好，但已保存的 API Key 当前无法恢复。',
  'credential.unreadable.detail': '“保留数据并重置凭据”会先备份数据库和损坏密钥，只清空无法恢复的 API Key，不删除会话、译文或版本历史。',
  'credential.reset.title': '凭据已重置',
  'credential.reset.message': '翻译历史已保留，请重新填写 API Key。',
  'credential.reset.detail': '恢复备份：{directory}',
  'button.retry': '重试',
  'button.openData': '打开数据目录',
  'button.resetCredentials': '保留数据并重置凭据',
  'button.exit': '退出',
  'button.continue': '继续启动',
  'button.minimize': '最小化到托盘',
  'button.cancel': '取消',
  'button.exitApp': '退出应用',
  'button.returnToWorkspace': '返回工作台',
  'button.exitWithoutSaving': '放弃未保存更改并退出',
  'close.saveFailed.title': '草稿尚未确认保存',
  'close.saveFailed.message': '窗口已保留，最近的编辑尚未确认写入本地存储。',
  'close.saveFailed.detail': '返回工作台检查保存状态后，可以重新关闭。选择放弃更改并退出会丢失尚未保存的编辑。',
  'file.tooLarge': '文件超过 5 MiB：{path}',
  'file.invalidUtf8': '不是有效 UTF-8：{path}',
  'file.tooMany': '文件数量超过 {limit} 个',
  'export.unsafePath': '导出包含不安全路径：{path}',
  'export.selectDirectory': '选择批量译文输出目录',
  'export.readFailed': '无法读取批量任务导出内容',
  'export.pathEscaped': '导出路径越界：{path}',
  'service.stopped.title': 'Agentic Translating 服务已停止',
  'service.stopped.message': '内嵌服务退出，代码 {code}。可在数据目录 logs 中查看诊断日志。',
  'service.stopFailed.title': '无法完全停止本地服务',
  'tray.open': '打开',
  'tray.openData': '打开数据目录',
  'tray.exit': '退出',
  'splash.seal': '译',
  'splash.preparing': '正在准备本地工作台…',
  'running.title': '仍有任务运行',
  'running.message': '仍有翻译、批量任务或模型请求在运行。',
  'running.unknownTitle': '请确认是否退出',
  'running.unknownMessage': '本地服务暂时没有返回任务状态。继续留在应用中可保留正在执行的工作。',
  'running.detail': '最小化到托盘可继续运行。确认退出会中断当前请求，已经保存的译文和历史会保留。',
  'startup.failed': '启动失败',
  'startup.previewMissing': '日常使用的桌面版本尚未构建：{path}\n\n请先运行 npm run build:standalone，完成后运行 npm run desktop。修改源码后也需重新构建一次。\n\n开发时可直接运行 npm run desktop:dev，支持实时更新，但会使用更多内存。',
  'startup.useLauncher': '请从仓库根目录运行 npm run desktop。\n\nRun npm run desktop from the repository root.',
  'startup.portUnavailable': '本地端口 {port} 已被占用。请关闭占用该端口的程序后重试。诊断日志：{path}\n\nLocal port {port} is already in use. Close the process using it and try again. Diagnostic log: {path}',
  'startup.serverMissing': '本地服务入口不存在：{path}\n\n源码开发请先运行 npm install，再运行 npm run desktop:dev。日常使用请运行 npm run build:standalone，然后运行 npm run desktop。打包版本请重新安装。',
}

const en = {
  'credential.unavailable.title': 'Windows credential protection is unavailable',
  'credential.unavailable.message': 'Secure storage is temporarily unavailable. The app will not fall back to storing keys in plain text.',
  'credential.unavailable.detail': 'Retry, open the data folder to inspect the environment, or exit the app.',
  'credential.unreadable.title': 'Local credentials cannot be decrypted',
  'credential.unreadable.message': 'Your translation history is intact, but saved API keys cannot currently be recovered.',
  'credential.unreadable.detail': '“Keep data and reset credentials” first backs up the database and damaged key, then clears only unrecoverable API keys. Sessions, translations, and version history are kept.',
  'credential.reset.title': 'Credentials reset',
  'credential.reset.message': 'Translation history was kept. Please enter your API key again.',
  'credential.reset.detail': 'Recovery backup: {directory}',
  'button.retry': 'Retry',
  'button.openData': 'Open data folder',
  'button.resetCredentials': 'Keep data and reset credentials',
  'button.exit': 'Exit',
  'button.continue': 'Continue startup',
  'button.minimize': 'Minimize to tray',
  'button.cancel': 'Cancel',
  'button.exitApp': 'Exit app',
  'button.returnToWorkspace': 'Return to workspace',
  'button.exitWithoutSaving': 'Discard unsaved changes and exit',
  'close.saveFailed.title': 'Draft save has not been confirmed',
  'close.saveFailed.message': 'The window is staying open because the latest edits have not been confirmed saved locally.',
  'close.saveFailed.detail': 'Return to the workspace to check the save status, then close again. Discarding changes and exiting loses any edits that have not been saved.',
  'file.tooLarge': 'File exceeds 5 MiB: {path}',
  'file.invalidUtf8': 'File is not valid UTF-8: {path}',
  'file.tooMany': 'The selection exceeds {limit} files',
  'export.unsafePath': 'Export contains an unsafe path: {path}',
  'export.selectDirectory': 'Choose the batch translation output folder',
  'export.readFailed': 'Unable to read the batch export',
  'export.pathEscaped': 'Export path escapes the output folder: {path}',
  'service.stopped.title': 'Agentic Translating service stopped',
  'service.stopped.message': 'The embedded service exited with code {code}. Diagnostic logs are available in the data folder under logs.',
  'service.stopFailed.title': 'Unable to stop the local service completely',
  'tray.open': 'Open',
  'tray.openData': 'Open data folder',
  'tray.exit': 'Exit',
  'splash.seal': 'A',
  'splash.preparing': 'Preparing your local workspace…',
  'running.title': 'Tasks are still running',
  'running.message': 'A translation, batch task, or model request is still running.',
  'running.unknownTitle': 'Confirm before exiting',
  'running.unknownMessage': 'The local service has not returned the task status. Stay in the app to keep ongoing work available.',
  'running.detail': 'Minimize to the tray to keep work running. Exiting interrupts current requests. Saved translations and history are kept.',
  'startup.failed': 'Startup failed',
  'startup.previewMissing': 'The desktop version for daily use has not been built: {path}\n\nRun npm run build:standalone, then npm run desktop. Rebuild after changing source code.\n\nFor live development, run npm run desktop:dev. Development mode uses more memory.',
  'startup.useLauncher': 'Run npm run desktop from the repository root.\n\n请从仓库根目录运行 npm run desktop。',
  'startup.portUnavailable': 'Local port {port} is already in use. Close the process using it and try again. Diagnostic log: {path}\n\n本地端口 {port} 已被占用，请关闭占用程序后重试。诊断日志：{path}',
  'startup.serverMissing': 'The local service entry is missing: {path}\n\nFor source development, run npm install, then npm run desktop:dev. For daily use, run npm run build:standalone, then npm run desktop. Reinstall a packaged app if its service is missing.',
}

export const electronCatalogs = { 'zh-CN': zhCN, en }

export function normalizeElectronLocale(value) {
  return String(value ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function createElectronTranslator(locale) {
  const normalized = normalizeElectronLocale(locale)
  const catalog = electronCatalogs[normalized]
  return (key, values = {}) => {
    const template = catalog[key] ?? zhCN[key] ?? key
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) =>
      Object.prototype.hasOwnProperty.call(values, name)
        ? String(values[name])
        : `{${name}}`,
    )
  }
}

export function assertElectronCatalogParity() {
  const reference = Object.keys(zhCN).sort()
  const candidate = Object.keys(en).sort()
  const missing = reference.filter((key) => !candidate.includes(key))
  const extra = candidate.filter((key) => !reference.includes(key))
  return { missing, extra }
}
