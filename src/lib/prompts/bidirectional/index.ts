import type {
  AgentDirectionVariant,
  BuiltinDirection,
  DirectionPromptBundle,
} from '../../contracts/vnext'
import { BUILTIN_AGENT_ARCHETYPES } from './archetypes'
import { EN_TO_ZH_BUNDLE, EN_TO_ZH_VARIANTS } from './en-to-zh'
import { ZH_TO_EN_BUNDLE, ZH_TO_EN_VARIANTS } from './zh-to-en'

export { BUILTIN_AGENT_ARCHETYPES } from './archetypes'
export {
  DASH_POLICY_EN,
  DASH_POLICY_ZH,
  POETRY_LINEATION_EN,
  POETRY_LINEATION_ZH,
  QUALITY_DISCIPLINE_EN,
  QUALITY_DISCIPLINE_ZH,
  SEMANTIC_BOUNDARY_EN,
  SEMANTIC_BOUNDARY_ZH,
  STAGE_BOUNDARY_EN,
  STAGE_BOUNDARY_ZH,
} from './common'

export const BUILTIN_AGENT_VARIANTS: AgentDirectionVariant[] = [
  ...EN_TO_ZH_VARIANTS,
  ...ZH_TO_EN_VARIANTS,
].map((variant, index) => ({
  ...variant,
  promptVersion: 17,
  enabled: true,
  endpointOverrideId: null,
  modelOverride: null,
  sortOrder: index % BUILTIN_AGENT_ARCHETYPES.length,
}))

export const BUILTIN_DIRECTION_BUNDLES: DirectionPromptBundle[] = [
  EN_TO_ZH_BUNDLE,
  ZH_TO_EN_BUNDLE,
]

export function getBuiltinDirectionBundle(
  direction: BuiltinDirection,
): DirectionPromptBundle {
  const bundle = BUILTIN_DIRECTION_BUNDLES.find(
    (item) => item.direction === direction,
  )
  if (!bundle) {
    throw new Error(`Missing built-in prompt bundle for ${direction}`)
  }
  return bundle
}
