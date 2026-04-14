// ---------------------------------------------------------------------------
// C6 — UI data-testid registry
// Shared by FE / BE / QA — single source of truth for testid attributes.
// ---------------------------------------------------------------------------

export const TID = {
  /** Endpoint configuration panel */
  endpoint: {
    form: 'endpoint-form',
    nameInput: 'name-input',
    baseUrlInput: 'baseurl-input',
    keyInput: 'key-input',
    saveButton: 'save-button',
    listItem: 'endpoint-list-item',
  },

  /** Translator agent cards panel */
  agent: {
    card: 'agent-card',
    addAgentButton: 'add-agent-button',
    modelInput: 'model-input',
    promptOverrideToggle: 'prompt-override-toggle',
  },

  /** Coordinator configuration panel */
  coordinator: {
    modelInput: 'coordinator-model-input',
    flashWarning: 'flash-warning',
    dontShowAgainCheckbox: 'dont-show-again-checkbox',
  },

  /** Translation view */
  translate: {
    sourceInput: 'source-input',
    translateButton: 'translate-button',
    agentStreamCard: 'agent-stream-card',
    agentStatusStreaming: 'agent-status-streaming',
    agentStatusComplete: 'agent-status-complete',
    agentStatusError: 'agent-status-error',
    retryAgentButton: 'retry-agent-button',
  },

  /** Coordination stage view */
  stage: {
    stepper: 'stage-stepper',
    runStageButton: 'run-stage-button',
    outputPanel: 'stage-output-panel',
    staleBadge: 'stage-stale-badge',
  },

  /** Edit + chat view */
  edit: {
    finalText: 'final-text',
    editPopover: 'edit-popover',
    editInstruction: 'edit-instruction',
    editSubmit: 'edit-submit',
    chatPanel: 'chat-panel',
    chatMessage: 'chat-message',
    toolCallBadge: 'tool-call-badge',
    versionHistory: 'version-history',
    versionItem: 'version-item',
  },
} as const
