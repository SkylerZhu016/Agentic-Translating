import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const stage = mkdtempSync(path.join(os.tmpdir(), 'agentic-package-'))
const output = path.resolve(root, 'dist-electron')
const expectedOutputPrefix = `${path.resolve(root)}${path.sep}`
const npmCli = process.env.npm_execpath
const builderCli = path.join(
  root,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js',
)
const buildEnvironment = {
  ...process.env,
  ELECTRON_CACHE: path.join(root, '.omo', 'electron-cache'),
  ELECTRON_BUILDER_CACHE: path.join(root, '.omo', 'electron-builder-cache'),
}

if (!output.startsWith(expectedOutputPrefix)) {
  throw new Error(`Refusing to replace build output outside the project: ${output}`)
}
if (!npmCli || !existsSync(npmCli)) {
  throw new Error('npm_execpath is unavailable; run this script through npm.')
}

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildEnvironment,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    })
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    )
  })
}

async function runWithRetry(command, args, cwd = root, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run(command, args, cwd)
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        console.warn(
          `Packaging attempt ${attempt} failed; retrying transient download/build step.`,
        )
      }
    }
  }
  throw lastError
}

try {
  await run(process.execPath, ['scripts/generate-icon.mjs'])
  await run(process.execPath, [npmCli, 'run', 'build'])
  await run(process.execPath, ['scripts/prepare-standalone.mjs'])

  cpSync(path.join(root, 'package.json'), path.join(stage, 'package.json'))
  cpSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'))
  cpSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'))
  cpSync(path.join(root, 'electron'), path.join(stage, 'electron'), {
    recursive: true,
  })
  cpSync(path.join(root, 'build'), path.join(stage, 'build'), {
    recursive: true,
  })
  cpSync(
    path.join(root, '.next', 'standalone'),
    path.join(stage, '.next', 'standalone'),
    { recursive: true },
  )

  // Install a clean production dependency tree in a path without spaces.
  // install-app-deps then rebuilds only this staged better-sqlite3 copy for
  // Electron; the developer's Node ABI remains untouched.
  await run(
    process.execPath,
    [
      npmCli,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--cache',
      path.join(root, '.npm-cache'),
    ],
    stage,
  )
  await run(
    process.execPath,
    [builderCli, 'install-app-deps'],
    stage,
  )
  await runWithRetry(
    process.execPath,
    [builderCli, '--projectDir', stage, '--win', 'nsis', 'portable'],
    stage,
  )

  if (existsSync(output)) rmSync(output, { recursive: true, force: true })
  cpSync(path.join(stage, 'dist-electron'), output, { recursive: true })
} finally {
  rmSync(stage, { recursive: true, force: true })
}
