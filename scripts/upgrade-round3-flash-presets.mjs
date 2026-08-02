import process from 'node:process'

const apiBase = (
  process.argv.find((argument) => argument.startsWith('--base='))?.slice(7) ??
  'http://127.0.0.1:3001'
).replace(/\/+$/, '')
const model =
  process.argv.find((argument) => argument.startsWith('--model='))?.slice(8) ??
  'DeepSeek V4 Flash: Go'

async function json(url, init) {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${JSON.stringify(payload ?? {})}`)
  }
  return payload
}

const endpoints = await json(`${apiBase}/api/endpoints`)
let selectedEndpoint = null
for (const endpoint of endpoints) {
  const discovery = await json(`${apiBase}/api/endpoints/${endpoint.id}/models`)
  const models = discovery.models ?? discovery
  if (models.some((item) => (item.id ?? item) === model)) {
    selectedEndpoint = endpoint
    break
  }
}
if (!selectedEndpoint) {
  throw new Error(`No configured endpoint advertised the exact model ID: ${model}`)
}

const contextWindow = selectedEndpoint.context_window ?? null
const binding = () => ({
  endpointId: selectedEndpoint.id,
  model,
  contextWindow,
})

let upgraded = 0
for (const direction of ['en_to_zh', 'zh_to_en']) {
  const catalogue = await json(
    `${apiBase}/api/agent-catalog?direction=${direction}&includeDisabled=1`,
  )
  const variantById = new Map(
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
    if (!current) throw new Error(`${preset.name}: current revision missing`)

    const agentVariantSnapshots = current.contract.agentVariantIds.map((id) => {
      const variant = variantById.get(id)
      if (!variant) throw new Error(`${preset.name}: missing Agent ${id}`)
      return {
        ...variant,
        endpointOverrideId: null,
        modelOverride: null,
      }
    })
    const contract = {
      ...current.contract,
      promptBundleVersion: 13,
      agentVariantSnapshots,
      agentBindingOverrides: {},
      defaultWorkerBinding: binding(),
      mainAgentBinding: binding(),
      reviewAgentBinding: binding(),
      filterAgentBinding: binding(),
      orchestrateAgentBinding: binding(),
      assembleAgentBinding: binding(),
      editingAgentBinding: binding(),
      contextAnalysisBindings: [binding(), binding()],
    }
    const alreadyUpgraded =
      current.contract.promptBundleVersion === 13 &&
      [
        current.contract.defaultWorkerBinding,
        current.contract.mainAgentBinding,
        current.contract.reviewAgentBinding,
        current.contract.filterAgentBinding,
        current.contract.orchestrateAgentBinding,
        current.contract.assembleAgentBinding,
        current.contract.editingAgentBinding,
        ...(current.contract.contextAnalysisBindings ?? []),
      ].every(
        (item) =>
          item?.endpointId === selectedEndpoint.id && item?.model === model,
      )
    if (alreadyUpgraded) {
      process.stdout.write(`${preset.name}: already on v13 / ${model}\n`)
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

process.stdout.write(
  `Upgraded ${upgraded} preset(s) using endpoint ${selectedEndpoint.name} and model ${model}.\n`,
)
