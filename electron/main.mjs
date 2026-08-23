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
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs'
import { randomBytes } from 'crypto'
import { createRequire } from 'module'
import path from 'path'
import JSZip from 'jszip'
import {
  createElectronTranslator,
  normalizeElectronLocale,
} from './i18n.mjs'
import {
  assertPortAvailable,
  createServerEnvironment,
  DESKTOP_PORT,
  DesktopRuntimeError,
  resolveDesktopRuntime,
  serverEntryFor,
  stopManagedServer,
  waitForManagedServer,
} from './runtime.mjs'

let mainWindow = null
let serverProcess = null
let serverLogStream = null
let serverShutdownPromise = null
let serverShutdownComplete = false
let tray = null
let allowQuit = false
const port = DESKTOP_PORT
const MAX_BATCH_FILES = 500
const MAX_BATCH_FILE_BYTES = 5 * 1024 * 1024
const require = createRequire(import.meta.url)
let electronLocale = normalizeElectronLocale(process.env.LANG)
let et = createElectronTranslator(electronLocale)

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function backupRecoveryFiles(userData) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDirectory = path.join(userData, 'recovery-backups', stamp)
  mkdirSync(backupDirectory, { recursive: true })
  for (const name of [
    'desktop-secret.bin',
    'app.db',
    'app.db-shm',
    'app.db-wal',
  ]) {
    const source = path.join(userData, name)
    if (existsSync(source)) {
      copyFileSync(source, path.join(backupDirectory, name))
    }
  }
  return backupDirectory
}

function scrubSnapshotCredentials(value) {
  if (Array.isArray(value)) return value.map(scrubSnapshotCredentials)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, child] of Object.entries(value)) {
    output[key] =
      key === 'apiKey' || key === 'api_key'
        ? ''
        : scrubSnapshotCredentials(child)
  }
  return output
}

function resetCredentialsPreservingData(userData) {
  const backupDirectory = backupRecoveryFiles(userData)
  const databaseFile = path.join(userData, 'app.db')
  if (existsSync(databaseFile)) {
    const Database = require('better-sqlite3')
    const db = new Database(databaseFile)
    try {
      db.transaction(() => {
        const endpointTable = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='endpoints'",
        ).get()
        if (endpointTable) db.prepare("UPDATE endpoints SET api_key=''").run()
        const sessionTable = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'",
        ).get()
        if (sessionTable) {
          const rows = db.prepare(
            'SELECT id, config_snapshot FROM sessions',
          ).all()
          const update = db.prepare(
            'UPDATE sessions SET config_snapshot=? WHERE id=?',
          )
          for (const row of rows) {
            try {
              const snapshot = JSON.parse(row.config_snapshot)
              update.run(
                JSON.stringify(scrubSnapshotCredentials(snapshot)),
                row.id,
              )
            } catch {
              // Preserve malformed historical snapshots byte-for-byte.
            }
          }
        }
      })()
    } finally {
      db.close()
    }
  }
  const secret = randomBytes(32).toString('hex')
  const encrypted = safeStorage.encryptString(secret)
  writeFileSync(
    path.join(userData, 'desktop-secret.bin'),
    encrypted.toString('base64'),
    { mode: 0o600 },
  )
  return { secret, backupDirectory }
}

function ensureSecret(userData) {
  const secretFile = path.join(userData, 'desktop-secret.bin')
  for (;;) {
    if (!safeStorage.isEncryptionAvailable()) {
      const unavailable = dialog.showMessageBoxSync({
        type: 'error',
        title: et('credential.unavailable.title'),
        message: et('credential.unavailable.message'),
        detail: et('credential.unavailable.detail'),
        buttons: [et('button.retry'), et('button.openData'), et('button.exit')],
        defaultId: 0,
        cancelId: 2,
      })
      if (unavailable === 1) {
        void shell.openPath(userData)
        continue
      }
      if (unavailable === 2) throw new Error('safeStorage_unavailable')
      continue
    }
    if (existsSync(secretFile)) {
      try {
        return safeStorage.decryptString(
          Buffer.from(readFileSync(secretFile, 'utf8'), 'base64'),
        )
      } catch (error) {
        const response = dialog.showMessageBoxSync({
          type: 'warning',
          title: et('credential.unreadable.title'),
          message: et('credential.unreadable.message'),
          detail: et('credential.unreadable.detail'),
          buttons: [
            et('button.retry'),
            et('button.openData'),
            et('button.resetCredentials'),
            et('button.exit'),
          ],
          defaultId: 0,
          cancelId: 3,
        })
        if (response === 1) {
          void shell.openPath(userData)
          continue
        }
        if (response === 2) {
          const recovered = resetCredentialsPreservingData(userData)
          dialog.showMessageBoxSync({
            type: 'info',
            title: et('credential.reset.title'),
            message: et('credential.reset.message'),
            detail: et('credential.reset.detail', {
              directory: recovered.backupDirectory,
            }),
            buttons: [et('button.continue')],
          })
          return recovered.secret
        }
        if (response === 3) throw error
        continue
      }
    }
    const secret = randomBytes(32).toString('hex')
    const encrypted = safeStorage.encryptString(secret)
    writeFileSync(secretFile, encrypted.toString('base64'), { mode: 0o600 })
    return secret
  }
}

function isSupportedTextFile(filePath) {
  return ['.txt', '.md'].includes(path.extname(filePath).toLowerCase())
}

function readPreparedFile(filePath, relativePath) {
  const bytes = readFileSync(filePath)
  if (bytes.byteLength > MAX_BATCH_FILE_BYTES) {
    throw new Error(et('file.tooLarge', { path: relativePath }))
  }
  let sourceText
  try {
    sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(et('file.invalidUtf8', { path: relativePath }))
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
        throw new Error(et('file.tooMany', { limit: MAX_BATCH_FILES }))
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
    throw new Error(et('export.unsafePath', { path: value }))
  }
  return unix
}

async function startServer() {
  const startupNonce = randomBytes(24).toString('hex')
  const runtime = resolveDesktopRuntime({
    isPackaged: app.isPackaged,
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    electronExecutable: process.execPath,
  })
  const serverFile = serverEntryFor(runtime)
  if (!existsSync(serverFile)) {
    if (runtime.kind === 'preview') {
      throw new DesktopRuntimeError('preview_missing', serverFile, { serverFile })
    }
    throw new DesktopRuntimeError('server_missing', serverFile, {
      serverFile,
      runtime: runtime.kind,
    })
  }
  const userData = app.getPath('userData')
  const logs = path.join(userData, 'logs')
  mkdirSync(logs, { recursive: true })
  const logFile = path.join(logs, 'desktop-server.log')
  try {
    await assertPortAvailable(port)
  } catch (error) {
    appendFileSync(
      logFile,
      `[${new Date().toISOString()}] Desktop startup blocked: local port ${port} is unavailable.\n`,
      'utf8',
    )
    if (error instanceof DesktopRuntimeError) {
      error.details.logFile = logFile
    }
    throw error
  }
  serverLogStream = createWriteStream(logFile, {
    flags: 'a',
  })
  serverProcess = spawn(runtime.command, runtime.args, {
    cwd: runtime.root,
    windowsHide: true,
    shell: false,
    env: createServerEnvironment(runtime, {
      port,
      userData,
      secret: ensureSecret(userData),
      startupNonce,
      packagedNodePath: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'node_modules')
        : undefined,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.pipe(serverLogStream)
  serverProcess.stderr.pipe(serverLogStream)
  const readiness = await waitForManagedServer(serverProcess, {
    url: `http://127.0.0.1:${port}/api/health/ready`,
    logFile,
    expectedNonce: startupNonce,
  })
  serverProcess.on('exit', (code) => {
    if (!allowQuit) {
      dialog.showErrorBox(
        et('service.stopped.title'),
        et('service.stopped.message', { code: code ?? 'unknown' }),
      )
    }
  })
  return readiness
}

function startupErrorMessage(error) {
  if (error instanceof DesktopRuntimeError) {
    if (error.code === 'preview_missing') {
      return et('startup.previewMissing', {
        path: error.details.serverFile,
      })
    }
    if (error.code === 'system_node_missing') {
      return et('startup.useLauncher')
    }
    if (error.code === 'port_unavailable') {
      return et('startup.portUnavailable', {
        port,
        path: error.details.logFile,
      })
    }
    if (error.code === 'server_missing') {
      return et('startup.serverMissing', {
        path: error.details.serverFile,
      })
    }
  }
  return error instanceof Error ? error.message : String(error)
}

async function stopServer() {
  if (serverShutdownComplete) return
  if (!serverShutdownPromise) {
    serverShutdownPromise = (async () => {
      try {
        await stopManagedServer(serverProcess, { port })
        serverProcess = null
        serverShutdownComplete = true
        if (serverLogStream) {
          serverLogStream.end()
          serverLogStream = null
        }
      } catch (error) {
        serverShutdownPromise = null
        throw error
      }
    })()
  }
  await serverShutdownPromise
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

function updateTrayMenu() {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: et('tray.open'), click: () => mainWindow?.show() },
      {
        label: et('tray.openData'),
        click: () => void shell.openPath(app.getPath('userData')),
      },
      {
        label: et('tray.exit'),
        click: () => {
          allowQuit = true
          app.quit()
        },
      },
    ]),
  )
}

function ensureTray() {
  if (tray) return
  tray = new Tray(
    nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    ),
  )
  tray.setToolTip('Agentic Translating')
  updateTrayMenu()
  tray.on('double-click', () => mainWindow?.show())
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 880,
    minHeight: 640,
    backgroundColor: '#f7f4ec',
    show: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html>
      <html lang="${electronLocale}">
        <meta charset="utf-8">
        <style>
          html,body{height:100%;margin:0;background:#f7f4ec;color:#26231f}
          body{display:grid;place-items:center;font-family:system-ui,sans-serif}
          main{text-align:center}
          .seal{display:inline-grid;place-items:center;width:56px;height:56px;border:1px solid #26231f;border-radius:10px;font-family:serif;font-size:28px}
          h1{font:600 20px Georgia,serif;letter-spacing:.04em;margin:18px 0 8px}
          p{font-size:13px;color:#777067}
          i{display:inline-block;width:6px;height:6px;border-radius:50%;background:#26231f;animation:pulse 1.2s infinite}
          @keyframes pulse{50%{opacity:.25}}
        </style>
        <main><div class="seal">${et('splash.seal')}</div><h1>Agentic Translating</h1><p><i></i> ${et('splash.preparing')}</p></main>
      </html>
    `)}`,
  )
  await startServer()
  mainWindow.on('close', async (event) => {
    if (allowQuit || !(await hasRunningWork())) return
    event.preventDefault()
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: et('running.title'),
      message: et('running.message'),
      detail: et('running.detail'),
      buttons: [
        et('button.minimize'),
        et('button.cancel'),
        et('button.exitApp'),
      ],
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
    if (files.length > MAX_BATCH_FILES) {
      throw new Error(et('file.tooMany', { limit: MAX_BATCH_FILES }))
    }
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
    title: et('export.selectDirectory'),
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
    throw new Error(et('export.readFailed'))
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
      throw new Error(et('export.pathEscaped', { path: entryName }))
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
ipcMain.handle('agentic:set-locale', (_event, locale) => {
  electronLocale = normalizeElectronLocale(locale)
  et = createElectronTranslator(electronLocale)
  updateTrayMenu()
  return electronLocale
})

app.whenReady().then(() => {
  electronLocale = normalizeElectronLocale(app.getLocale())
  et = createElectronTranslator(electronLocale)
  return createWindow()
}).catch((error) => {
  dialog.showErrorBox(
    et('startup.failed'),
    startupErrorMessage(error),
  )
  app.quit()
})

app.on('before-quit', (event) => {
  allowQuit = true
  if (!serverProcess || serverShutdownComplete) return
  event.preventDefault()
  void stopServer()
    .then(() => app.quit())
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(message)
      dialog.showErrorBox(et('service.stopFailed.title'), message)
      allowQuit = false
      ensureTray()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit()
})
