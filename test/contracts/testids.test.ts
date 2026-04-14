import { describe, it, expect } from 'vitest'
import { TID } from '../../src/lib/testids'

describe('TID — testid registry (C6)', () => {
  it('has endpoint group', () => {
    expect(TID.endpoint).toBeDefined()
    expect(TID.endpoint.form).toBe('endpoint-form')
    expect(TID.endpoint.nameInput).toBe('name-input')
    expect(TID.endpoint.baseUrlInput).toBe('baseurl-input')
    expect(TID.endpoint.keyInput).toBe('key-input')
    expect(TID.endpoint.saveButton).toBe('save-button')
    expect(TID.endpoint.listItem).toBe('endpoint-list-item')
  })

  it('has agent group', () => {
    expect(TID.agent).toBeDefined()
    expect(TID.agent.card).toBe('agent-card')
    expect(TID.agent.addAgentButton).toBe('add-agent-button')
    expect(TID.agent.modelInput).toBe('model-input')
    expect(TID.agent.promptOverrideToggle).toBe('prompt-override-toggle')
  })

  it('has coordinator group', () => {
    expect(TID.coordinator).toBeDefined()
    expect(TID.coordinator.modelInput).toBe('coordinator-model-input')
    expect(TID.coordinator.flashWarning).toBe('flash-warning')
    expect(TID.coordinator.dontShowAgainCheckbox).toBe('dont-show-again-checkbox')
  })

  it('has translate group', () => {
    expect(TID.translate).toBeDefined()
    expect(TID.translate.sourceInput).toBe('source-input')
    expect(TID.translate.translateButton).toBe('translate-button')
    expect(TID.translate.agentStreamCard).toBe('agent-stream-card')
    expect(TID.translate.agentStatusStreaming).toBe('agent-status-streaming')
    expect(TID.translate.agentStatusComplete).toBe('agent-status-complete')
    expect(TID.translate.agentStatusError).toBe('agent-status-error')
    expect(TID.translate.retryAgentButton).toBe('retry-agent-button')
  })

  it('has stage group', () => {
    expect(TID.stage).toBeDefined()
    expect(TID.stage.stepper).toBe('stage-stepper')
    expect(TID.stage.runStageButton).toBe('run-stage-button')
    expect(TID.stage.outputPanel).toBe('stage-output-panel')
    expect(TID.stage.staleBadge).toBe('stage-stale-badge')
  })

  it('has edit group', () => {
    expect(TID.edit).toBeDefined()
    expect(TID.edit.finalText).toBe('final-text')
    expect(TID.edit.editPopover).toBe('edit-popover')
    expect(TID.edit.editInstruction).toBe('edit-instruction')
    expect(TID.edit.editSubmit).toBe('edit-submit')
    expect(TID.edit.chatPanel).toBe('chat-panel')
    expect(TID.edit.chatMessage).toBe('chat-message')
    expect(TID.edit.toolCallBadge).toBe('tool-call-badge')
    expect(TID.edit.versionHistory).toBe('version-history')
    expect(TID.edit.versionItem).toBe('version-item')
  })

  it('all values are non-empty strings', () => {
    function check(obj: Record<string, unknown>) {
      for (const val of Object.values(obj)) {
        if (typeof val === 'string') {
          expect(val.length).toBeGreaterThan(0)
        } else if (typeof val === 'object' && val !== null) {
          check(val as Record<string, unknown>)
        }
      }
    }
    check(TID as unknown as Record<string, unknown>)
  })
})
