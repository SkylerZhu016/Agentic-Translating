import process from 'node:process'

const apiBase = (
  process.argv.find((argument) => argument.startsWith('--base='))?.slice(7) ??
  'http://127.0.0.1:3000'
).replace(/\/+$/, '')

const endpointId = 57
const contextWindow = 256000
const binding = (model) => ({ endpointId, model, contextWindow })
const target = {
  defaultWorkerBinding: binding('DeepSeek V4 Pro: Go'),
  mainAgentBinding: binding('GLM 5.2: Go'),
  reviewAgentBinding: binding('Kimi K2.6: Go'),
  filterAgentBinding: binding('GLM 5.2: Go'),
  orchestrateAgentBinding: binding('Kimi K2.6: Go'),
  assembleAgentBinding: binding('GLM 5.2: Go'),
  editingAgentBinding: binding('GLM 5.2: Go'),
  contextAnalysisBindings: [
    binding('DeepSeek V4 Pro: Go'),
    binding('Kimi K2.6: Go'),
  ],
}

async function json(url, init) {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      `${response.status} ${url}: ${JSON.stringify(payload ?? {})}`,
    )
  }
  return payload
}

let upgraded = 0
for (const direction of ['en_to_zh', 'zh_to_en']) {
  const catalogue = await json(
    `${apiBase}/api/agent-catalog?direction=${direction}&includeDisabled=1`,
  )
  const currentVariantById = new Map(
    catalogue.variants.map((variant) => [variant.id, variant]),
  )
  const presets = await json(
    `${apiBase}/api/workflow-presets?direction=${direction}`,
  )
  for (const preset of presets) {
    if (!preset.name.startsWith('FSBP B-2 ')) continue
    const detail = await json(
      `${apiBase}/api/workflow-presets/${encodeURIComponent(preset.id)}`,
    )
    const current = detail.revisions.find(
      (revision) => revision.revisionNo === preset.currentRevisionNo,
    )
    if (!current) throw new Error(`${preset.id}: current revision missing`)
    const contract = {
      ...current.contract,
      ...target,
      agentVariantSnapshots: current.contract.agentVariantIds.map((id) => {
        const variant = currentVariantById.get(id)
        if (!variant) throw new Error(`${preset.name}: missing Agent ${id}`)
        return variant
      }),
      promptBundleVersion: 10,
    }
    const alreadyUpgraded =
      current.contract.promptBundleVersion === 10 &&
      current.contract.defaultWorkerBinding?.model ===
        target.defaultWorkerBinding.model &&
      current.contract.reviewAgentBinding?.model ===
        target.reviewAgentBinding.model &&
      current.contract.filterAgentBinding?.model ===
        target.filterAgentBinding.model &&
      current.contract.orchestrateAgentBinding?.model ===
        target.orchestrateAgentBinding.model &&
      current.contract.assembleAgentBinding?.model ===
        target.assembleAgentBinding.model &&
      current.contract.editingAgentBinding?.model ===
        target.editingAgentBinding.model &&
      current.contract.agentVariantSnapshots.every(
        (variant) => variant.promptVersion === 8,
      )
    if (alreadyUpgraded) {
      process.stdout.write(`${preset.name}: already upgraded\n`)
      continue
    }
    const revision = await json(
      `${apiBase}/api/workflow-presets/${encodeURIComponent(preset.id)}/revisions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(contract),
      },
    )
    upgraded += 1
    process.stdout.write(
      `${preset.name}: revision ${revision.revisionNo} (${revision.id})\n`,
    )
  }
}

process.stdout.write(`Upgraded ${upgraded} B-2 presets.\n`)
