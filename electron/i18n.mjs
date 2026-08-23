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
  'running.message': '仍有翻译或批量任务在运行。',
  'running.detail': '可以最小化到托盘继续运行，或确认退出并在下次启动时从失败节点重试。',
  'startup.failed': '启动失败',
  'startup.previewMissing': '桌面预览产物不存在：{path}\n\n请先运行 npm run build:standalone，再运行 npm run desktop:preview。本命令不会自动构建。\n\nDesktop preview is missing. Run npm run build:standalone, then npm run desktop:preview. This command never builds implicitly.',
  'startup.useLauncher': '请从仓库根目录运行 npm run desktop。\n\nRun npm run desktop from the repository root.',
  'startup.portUnavailable': '本地端口 {port} 已被占用。请关闭占用该端口的程序后重试。诊断日志：{path}\n\nLocal port {port} is already in use. Close the process using it and try again. Diagnostic log: {path}',
  'startup.serverMissing': '本地服务入口不存在：{path}\n\n源码模式请先运行 npm install，再运行 npm run desktop；打包版本请重新安装。\n\nThe local service entry is missing. For source development, run npm install and then npm run desktop; otherwise reinstall the packaged app.',
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
  'running.message': 'A translation or batch task is still running.',
  'running.detail': 'Minimize to the tray to keep it running, or exit and retry from the failed step the next time the app starts.',
  'startup.failed': 'Startup failed',
  'startup.previewMissing': 'Desktop preview is missing: {path}\n\nRun npm run build:standalone, then npm run desktop:preview. This command never builds implicitly.\n\n桌面预览产物不存在。请先运行 npm run build:standalone，再运行 npm run desktop:preview；本命令不会自动构建。',
  'startup.useLauncher': 'Run npm run desktop from the repository root.\n\n请从仓库根目录运行 npm run desktop。',
  'startup.portUnavailable': 'Local port {port} is already in use. Close the process using it and try again. Diagnostic log: {path}\n\n本地端口 {port} 已被占用，请关闭占用程序后重试。诊断日志：{path}',
  'startup.serverMissing': 'The local service entry is missing: {path}\n\nFor source development, run npm install and then npm run desktop; otherwise reinstall the packaged app.\n\n本地服务入口不存在；源码模式请先运行 npm install，再运行 npm run desktop，打包版本请重新安装。',
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
