// 并发运行对话门禁：每个样本一个独立进程（--only 分片输出），全部完成后自动合并
// 用法：node scripts/run-gate-parallel.mjs --config=FSBP_Test/private/round-03/<config>.json [--max=2]
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const configArgument = process.argv.find((argument) => argument.startsWith('--config='))
const runConfig = configArgument
  ? JSON.parse(await readFile(path.resolve(configArgument.slice(9)), 'utf8'))
  : {}
const maxParallel = Number(
  process.argv.find((argument) => argument.startsWith('--max='))?.slice(6) ?? 4,
)
const selectedIds = runConfig.selectedIds ?? []
if (!selectedIds.length) throw new Error('no selectedIds in config')
console.log(`parallel gate: ${selectedIds.length} samples, max ${maxParallel} concurrent`)

let next = 0
let running = 0
const failures = []

function launch() {
  while (running < maxParallel && next < selectedIds.length) {
    const id = selectedIds[next]
    next += 1
    running += 1
    const slug = runConfig.experimentSlug ?? 'round3-dev-conversation-v1'
    const outLog = path.join('.omo', `${slug}-${id}.out.log`)
    const errLog = path.join('.omo', `${slug}-${id}.err.log`)
    const child = spawn(
      process.execPath,
      [
        'scripts/run-round3-conversation-gate.mjs',
        `--config=${path.resolve(configArgument.slice(9))}`,
        `--only=${id}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const outFs = createWriteStream(outLog)
    const errFs = createWriteStream(errLog)
    child.stdout.pipe(outFs)
    child.stderr.pipe(errFs)
    child.on('exit', (code, signal) => {
      running -= 1
      const ok = code === 0 && !signal
      console.log(`[${id}] ${ok ? 'OK' : `FAIL(code=${code},sig=${signal})`} -> ${outLog}`)
      if (!ok) failures.push(id)
      launch()
    })
    console.log(`[${id}] launched (${running}/${maxParallel} running)`)
  }
  if (running === 0 && next >= selectedIds.length) {
    console.log('--- all done ---')
    if (failures.length) {
      console.log(`FAILED samples: ${failures.join(', ')}`)
    }
    console.log('merging every terminal shard, including recorded failures...')
    const merge = spawn(
      process.execPath,
      ['scripts/merge-gate-shards.mjs', `--config=${path.resolve(configArgument.slice(9))}`],
      { stdio: 'inherit' },
    )
    merge.on('exit', (code) => {
      if (code === 0) console.log('merged into manifest.json + results.jsonl')
      else console.log('merge failed')
      process.exitCode = failures.length === 0 && code === 0 ? 0 : 1
    })
  }
}

launch()
