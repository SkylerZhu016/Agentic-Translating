export interface EndpointActiveReferenceSummary {
  legacyAgents: number
  vnextAgentOverrides: number
  coordinatorBindings: number
  legacyPresetAgents: number
  legacyPresetCoordinatorBindings: number
  modelProfileBindings: number
  onboardingSelection: number
  capabilityProfiles: number
}

export interface EndpointHistoricalReferenceSummary {
  sessions: number
  workflowPresetRevisions: number
  batchJobs: number
  agentInvocations: number
  llmCalls: number
}

export interface EndpointReferenceSummary {
  active: EndpointActiveReferenceSummary
  historical: EndpointHistoricalReferenceSummary
  totalActive: number
  totalHistorical: number
}

export interface EndpointDeleteConflictDto {
  error: 'endpoint_references_exist'
  references: EndpointReferenceSummary
  /** Kept for compatibility with older clients; contains identifiers only. */
  usedBySessions: string[]
}
