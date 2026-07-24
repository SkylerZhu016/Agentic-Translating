import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
} from 'electron'
import { spawn } from 'child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs'
import { randomBytes } from 'crypto'
import path from 'path'
import JSZip from 'jszip'

let mainWindow = null
let serverProcess = null
let tray = null
let allowQuit = false
const port = 3210
const MAX_BATCH_FILES = 500
const MAX_BATCH_FILE_BYTES = 5 * 1024 * 1024

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function appRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(process.cwd(), '.next', 'standalone')
}

function ensureSecret(userData) {
  const secretFile = path.join(userData, 'desktop-secret.bin')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows safeStorage is unavailable; cannot protect BYOK credentials.')
  }
  if (existsSync(secretFile)) {
    return safeStorage.decryptString(
      Buffer.from(readFileSync(secretFile, 'utf8'), 'base64'),
    )
  }
  const secret = randomBytes(32).toString('hex')
  const encrypted = safeStorage.encryptString(secret)
  writeFileSync(secretFile, encrypted.toString('base64'), { mode: 0o600 })
  return secret
}

function isSupportedTextFile(filePath) {
  return ['.txt', '.md'].includes(path.extname(filePath).toLowerCase())
}

function readPreparedFile(filePath, relativePath) {
  const bytes = readFileSync(filePath)
  if (bytes.byteLength > MAX_BATCH_FILE_BYTES) {
    throw new Error(`文件超过 5 MiB：${relativePath}`)
  }
  let sourceText
  try {
    sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`不是有效 UTF-8：${relativePath}`)
  }
  return {
    relativePath: relativePath.split(path.sep).join('/'),
    sourceText,
    originalLineEnding: sourceText.includes('\r\n') ? 'crlf' : 'lf',
    hadBom:
      bytes.byteLength >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf,
  }
}

function collectFolderFiles(root, current = root, prepared = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      collectFolderFiles(root, absolute, prepared)
    } else if (entry.isFile() && isSupportedTextFile(absolute)) {
      prepared.push(readPreparedFile(absolute, path.relative(root, absolute)))
      if (prepared.length > MAX_BATCH_FILES) {
        throw new Error('文件数量超过 500 个')
      }
    }
  }
  return prepared
}

function safeOutputName(value) {
  const safe = String(value)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return safe || 'Agentic-Translating'
}

function safeZipRelativePath(value) {
  const unix = value.replace(/\\/g, '/')
  if (
    !unix ||
    unix.startsWith('/') ||
    /^[a-zA-Z]:/.test(unix) ||
    unix.split('/').includes('..')
  ) {
    throw new Error(`导出包含不安全路径：${value}`)
  }
  return unix
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/settings`)
      if (response.ok) return
    } catch {
      // Embedded server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Embedded Next.js service did not become healthy in time.')
}

function startServer() {
  const root = appRoot()
  const serverFile = path.join(root, 'server.js')
  if (!existsSync(serverFile)) {
    throw new Error(`Standalone server is missing: ${serverFile}`)
  }
  const userData = app.getPath('userData')
  const logs = path.join(userData, 'logs')
  mkdirSync(logs, { recursive: true })
  const output = createWriteStream(path.join(logs, 'desktop-server.log'), {
    flags: 'a',
  })
  serverProcess = spawn(process.execPath, [serverFile], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      AGENTIC_DESKTOP: '1',
      AGENTIC_DATA_DIR: userData,
      AGENTIC_SECRET_KEY: ensureSecret(userData),
      NODE_PATH: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'node_modules')
        : process.env.NODE_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.pipe(output)
  serverProcess.stderr.pipe(output)
  serverProcess.on('exit', (code) => {
    if (!allowQuit && code !== 0) {
      dialog.showErrorBox(
        'Agentic Translating 服务已停止',
        `内嵌服务退出，代码 ${code ?? 'unknown'}。可在数据目录 logs 中查看诊断日志。`,
      )
    }
  })
}

async function hasRunningWork() {
  try {
    const [batches, sessions] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/batches`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/api/sessions?limit=100`).then((response) => response.json()),
    ])
    return (
      batches.some((batch) => batch.status === 'running') ||
      sessions.sessions.some((session) =>
        ['translating', 'coordinating'].includes(session.state),
      )
    )
  } catch {
    return false
  }
}

function ensureTray() {
  if (tray) return
  tray = new Tray(
    nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ),
  )
  tray.setToolTip('Agentic Translating')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开', click: () => mainWindow?.show() },
      {
        label: '打开数据目录',
        click: () => void shell.openPath(app.getPath('userData')),
      },
      {
        label: '退出',
        click: () => {
          allowQuit = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('double-click', () => mainWindow?.show())
}

async function createWindow() {
  startServer()
  await waitForServer()
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 880,
    minHeight: 640,
    backgroundColor: '#f7f4ec',
    show: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', async (event) => {
    if (allowQuit || !(await hasRunningWork())) return
    event.preventDefault()
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '仍有任务运行',
      message: '仍有翻译或批量任务在运行。',
      detail: '可以最小化到托盘继续运行，或确认退出并在下次启动时从失败节点重试。',
      buttons: ['最小化到托盘', '取消', '退出应用'],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) {
      ensureTray()
      mainWindow.hide()
    } else if (result.response === 2) {
      allowQuit = true
      app.quit()
    }
  })
  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
}

ipcMain.handle('agentic:select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Text', extensions: ['txt', 'md'] }],
  })
  if (result.canceled) return { canceled: true, files: [] }
  try {
    const files = result.filePaths
      .filter(isSupportedTextFile)
      .map((filePath) => readPreparedFile(filePath, path.basename(filePath)))
    if (files.length > MAX_BATCH_FILES) throw new Error('文件数量超过 500 个')
    return { canceled: false, files }
  } catch (error) {
    return {
      canceled: false,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
})
ipcMain.handle('agentic:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, files: [] }
  }
  try {
    return {
      canceled: false,
      files: collectFolderFiles(result.filePaths[0]),
    }
  } catch (error) {
    return {
      canceled: false,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
})
ipcMain.handle('agentic:export-batch', async (_event, batchId, includeAudit) => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择批量译文输出目录',
  })
  if (selection.canceled || !selection.filePaths[0]) {
    return { canceled: true }
  }
  const [detailResponse, archiveResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/batches/${encodeURIComponent(batchId)}`),
    fetch(
      `http://127.0.0.1:${port}/api/batches/${encodeURIComponent(batchId)}/export?audit=${includeAudit ? '1' : '0'}`,
    ),
  ])
  if (!detailResponse.ok || !archiveResponse.ok) {
    throw new Error('无法读取批量任务导出内容')
  }
  const detail = await detailResponse.json()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputDirectory = path.join(
    selection.filePaths[0],
    `${safeOutputName(detail.batch.name)}-${stamp}`,
  )
  mkdirSync(outputDirectory, { recursive: false })
  const zip = await JSZip.loadAsync(await archiveResponse.arrayBuffer())
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const relative = safeZipRelativePath(entryName)
    const destination = path.resolve(outputDirectory, ...relative.split('/'))
    const relativeToOutput = path.relative(outputDirectory, destination)
    if (
      relativeToOutput.startsWith('..') ||
      path.isAbsolute(relativeToOutput)
    ) {
      throw new Error(`导出路径越界：${entryName}`)
    }
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, await entry.async('nodebuffer'))
  }
  return { canceled: false, outputDirectory }
})
ipcMain.handle('agentic:open-data-dir', () =>
  shell.openPath(app.getPath('userData')),
)
ipcMain.handle('agentic:open-diagnostic-logs', () =>
  shell.openPath(path.join(app.getPath('userData'), 'logs')),
)

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('启动失败', error instanceof Error ? error.message : String(error))
  app.quit()
})

app.on('before-quit', () => {
  allowQuit = true
  serverProcess?.kill()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit()
})
