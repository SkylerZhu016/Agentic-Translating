import { describe, expect, it } from 'vitest'
import type { EndpointReferenceSummary } from '@/src/lib/contracts/endpoint-references'
import { endpointReferenceDisplayGroups } from './EndpointPanel'

describe('EndpointPanel endpoint reference summary', () => {
  it('shows every non-zero active and historical reference category', () => {
    const summary: EndpointReferenceSummary = {
      active: {
        legacyAgents: 1,
        vnextAgentOverrides: 2,
        coordinatorBindings: 3,
        legacyPresetAgents: 4,
        legacyPresetCoordinatorBindings: 5,
        modelProfileBindings: 6,
        onboardingSelection: 1,
        capabilityProfiles: 1,
      },
      historical: {
        sessions: 7,
        workflowPresetRevisions: 8,
        batchJobs: 9,
        agentInvocations: 10,
        llmCalls: 11,
      },
      totalActive: 23,
      totalHistorical: 45,
    }

    expect(endpointReferenceDisplayGroups(summary)).toEqual([
      {
        title: '当前配置引用',
        items: [
          { key: 'legacyAgents', label: '旧版翻译 Agent', count: 1 },
          { key: 'vnextAgentOverrides', label: 'vNext Agent 单独覆盖', count: 2 },
          { key: 'coordinatorBindings', label: '当前统筹与对话绑定', count: 3 },
          { key: 'legacyPresetAgents', label: '旧版预设 Agent', count: 4 },
          {
            key: 'legacyPresetCoordinatorBindings',
            label: '旧版预设统筹绑定',
            count: 5,
          },
          { key: 'modelProfileBindings', label: '默认模型分工', count: 6 },
          { key: 'onboardingSelection', label: '首次运行向导选择', count: 1 },
          { key: 'capabilityProfiles', label: '兼容性检查缓存', count: 1 },
        ],
      },
      {
        title: '历史记录引用',
        items: [
          { key: 'sessions', label: '历史会话', count: 7 },
          {
            key: 'workflowPresetRevisions',
            label: '工作流预设 revision',
            count: 8,
          },
          { key: 'batchJobs', label: '批量任务快照', count: 9 },
          { key: 'agentInvocations', label: 'Agent 调用记录', count: 10 },
          { key: 'llmCalls', label: '模型调用账本', count: 11 },
        ],
      },
    ])
  })

  it('omits empty groups and zero-count rows', () => {
    const summary: EndpointReferenceSummary = {
      active: {
        legacyAgents: 0,
        vnextAgentOverrides: 0,
        coordinatorBindings: 0,
        legacyPresetAgents: 0,
        legacyPresetCoordinatorBindings: 0,
        modelProfileBindings: 0,
        onboardingSelection: 0,
        capabilityProfiles: 0,
      },
      historical: {
        sessions: 1,
        workflowPresetRevisions: 0,
        batchJobs: 0,
        agentInvocations: 0,
        llmCalls: 0,
      },
      totalActive: 0,
      totalHistorical: 1,
    }

    expect(endpointReferenceDisplayGroups(summary)).toEqual([
      {
        title: '历史记录引用',
        items: [{ key: 'sessions', label: '历史会话', count: 1 }],
      },
    ])
  })
})
