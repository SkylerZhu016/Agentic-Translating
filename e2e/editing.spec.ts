// ---------------------------------------------------------------------------
// E2E: editing.spec.ts
//
// Covers:
//   AC20 — 选中修改（select text in final-text → edit popover → submit
//          instruction → tool_call badge appears → final-text updated → new
//          version persisted）
//   AC21 — 版本历史（version history shows version items; restore a prior
//          version → appends a new "恢复" version → final-text reflects it）
//          + 讨论不改文（discussion round: chat message with no tool_call →
//          final-text unchanged, no new version created）
//
// Strategy:
//   1. Seed config + run translation + run all four stages (assemble produces
//      a final text containing the literal "original text" so the mock's
//      tool_call behavior can replace it).
//   2. For AC20: select text in final-text → fill edit-instruction → submit →
//      assert tool-call-badge (status ok) appears, final-text now contains
//      "replaced text", and a new version item appears in version-history.
//   3. For AC21: click a non-current version item → confirm restore → assert a
//      new "恢复" version appears and final-text reverts. Then send a plain
//      discussion message → assert no new version item is added and
//      final-text unchanged.
// ---------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { TID } from '../src/lib/testids'
import {
  resetDb,
  resetMockBehavior,
  setMockBehavior,
  byTid,
  evidenceScreenshot,
  tid,
  buildReviewOutput,
  buildFilterOutput,
  buildOrchestrateOutput,
  buildAssembleOutput,
} from './helpers'

const MOCK_URL = process.env.E2E_MOCK_LLM_URL ?? 'http://localhost:41099'
const SOURCE_TEXT = 'The quick brown fox jumps over the lazy dog.'
const AGENT_NAMES = ['Agent 1', 'Agent 2', 'Agent 3']
const COORD_MODEL = 'gpt-4o-coordinator'
const CHAT_MODEL = 'chat-model'
// The final text contains "original text" so the mock's tool_call behavior
// (which replaces "original text" → "replaced text") can succeed.
const FINAL_TEXT = 'This is the original text of the assembled translation.'

test.beforeEach(async ({ request }) => {
  await resetDb(request)
  await resetMockBehavior(request)
})

/** Seed endpoint + 3 agents + coordinator with chat model. */
async function seedConfig(request: APIRequestContext): Promise<void> {
  const epRes = await request.post('/api/endpoints', {
    data: { name: 'Mock', base_url: MOCK_URL, api_key: 'sk-mock' },
  })
  expect(epRes.status()).toBe(201)
  const ep = await epRes.json()
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    await request.post('/api/agents', {
      data: {
        name: AGENT_NAMES[i],
        endpoint_id: ep.id,
        model: `agent-model-${i + 1}`,
        prompt_override: null,
        sort_order: i,
      },
    })
  }
  const coRes = await request.put('/api/coordinator', {
    data: { endpoint_id: ep.id, model: COORD_MODEL, chat_endpoint_id: ep.id, chat_model: CHAT_MODEL },
  })
  expect(coRes.status()).toBe(200)
}

/** Run translation fanout (all agents stream successfully). */
async function runTranslation(page: Page, request: APIRequestContext): Promise<void> {
  for (let i = 0; i < AGENT_NAMES.length; i++) {
    await setMockBehavior(request, {
      behavior: 'stream',
      model: `agent-model-${i + 1}`,
      delayMs: 5,
    })
  }
  await page.goto('/')
  await byTid(page, TID.translate.sourceInput).fill(SOURCE_TEXT)
  await byTid(page, TID.translate.translateButton).click()
  await expect(byTid(page, TID.translate.agentStreamCard)).toHaveCount(2, { timeout: 10_000 })
  await expect(byTid(page, TID.translate.agentStatusComplete)).toHaveCount(2, { timeout: 30_000 })
}

/** Run all four coordination stages to reach assembled state. */
async function runAllStages(page: Page, request: APIRequestContext): Promise<void> {
  const stages = ['review', 'filter', 'orchestrate', 'assemble'] as const
  for (const stage of stages) {
    let jsonContent: string
    switch (stage) {
      case 'review':
        jsonContent = buildReviewOutput(AGENT_NAMES)
        break
      case 'filter':
        jsonContent = buildFilterOutput(['Agent 1', 'Agent 2'], ['Agent 3'])
        break
      case 'orchestrate':
        jsonContent = buildOrchestrateOutput([
          { segment_index: 0, source_agent_id: 'Agent 1', source_segment: 'segment one', rationale: 'first' },
          { segment_index: 1, source_agent_id: 'Agent 2', source_segment: 'segment two', rationale: 'second' },
        ])
        break
      case 'assemble':
        // Notes must NOT contain the substring "original text" — otherwise it
        // appears twice in the JSON string (in final_text AND notes), causing
        // the editing matcher to reject the tool_call replacement as ambiguous.
        jsonContent = buildAssembleOutput(FINAL_TEXT, 'assembled from two segments.')
        break
    }
    await setMockBehavior(request, { behavior: 'json_content', model: COORD_MODEL, jsonContent })
    const btn = page
      .locator(`[data-stage="${stage}"]`)
      .locator(tid(TID.stage.runStageButton))
    await expect(btn).toBeEnabled({ timeout: 10_000 })
    await btn.click()
    await expect(
      page
        .locator(`${tid(TID.stage.outputPanel)}[data-stage="${stage}"]`)
        .locator('text=完成'),
    ).toBeVisible({ timeout: 30_000 })
  }
  // After assemble, final-text should be populated
  await expect(byTid(page, TID.edit.finalText)).toContainText(/original text/, { timeout: 10_000 })
}

/** Count version items in version-history. */
function versionItemCount(page: Page): Promise<number> {
  return byTid(page, TID.edit.versionItem).count()
}

test.describe('AC20 — select-text edit', () => {
  test.skip('legacy selection-edit fixture is superseded by automatic v3 orchestration', async ({
    page,
    request,
  }) => {
    await seedConfig(request)
    await runTranslation(page, request)
    await runAllStages(page, request)

    const versionsBefore = await versionItemCount(page)
    expect(versionsBefore).toBeGreaterThanOrEqual(1)

    // Configure chat mock to invoke replace_text tool (mock's tool_call
    // behavior replaces "original text" → "replaced text").
    await setMockBehavior(request, { behavior: 'tool_call', model: CHAT_MODEL })

    // Select the substring "original text" inside final-text via Playwright
    // text selection helpers.
    const finalTextEl = byTid(page, TID.edit.finalText)
    await expect(finalTextEl).toContainText(/original text/)

    // Use page.evaluate to programmatically select the substring, then
    // dispatch a mouseup event to trigger inspectSelection().
    await page.evaluate((testid) => {
      const container = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement
      if (!container) throw new Error('final-text container not found')
      const fullText = container.textContent ?? ''
      const target = 'original text'
      const start = fullText.indexOf(target)
      if (start === -1) throw new Error('target substring not found in final-text')
      const range = document.createRange()
      const textNode = container.firstChild as Text
      range.setStart(textNode, start)
      range.setEnd(textNode, start + target.length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      // Trigger the same handler the component uses
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    }, TID.edit.finalText)

    // The edit popover should appear
    await expect(byTid(page, TID.edit.editPopover)).toBeVisible({ timeout: 5_000 })
    await evidenceScreenshot(page, 'editing-popover-shown')

    await byTid(page, TID.edit.editInstruction).fill('Make this more formal')
    await byTid(page, TID.edit.editSubmit).click()

    // The tool-call-badge in live messages is transient (cleared by refresh()),
    // so we wait for the committed state instead.
    // final-text should now contain "replaced text" (the new_string)
    await expect(byTid(page, TID.edit.finalText)).toContainText(/replaced text/, {
      timeout: 30_000,
    })

    // A new version item should have been added
    await expect(byTid(page, TID.edit.versionItem)).toHaveCount(versionsBefore + 1, {
      timeout: 10_000,
    })

    await evidenceScreenshot(page, 'editing-edit-applied')
  })
})

test.describe('AC21 — version history + discussion-no-change', () => {
  test.skip('legacy version-restore fixture is superseded by automatic v3 orchestration', async ({
    page,
    request,
  }) => {
    await seedConfig(request)
    await runTranslation(page, request)
    await runAllStages(page, request)

    // First apply an edit so we have ≥2 versions to restore from
    await setMockBehavior(request, { behavior: 'tool_call', model: CHAT_MODEL })
    const finalTextEl = byTid(page, TID.edit.finalText)
    await expect(finalTextEl).toContainText(/original text/)
    await page.evaluate((testid) => {
      const container = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement
      const fullText = container.textContent ?? ''
      const target = 'original text'
      const start = fullText.indexOf(target)
      const range = document.createRange()
      const textNode = container.firstChild as Text
      range.setStart(textNode, start)
      range.setEnd(textNode, start + target.length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    }, TID.edit.finalText)
    await expect(byTid(page, TID.edit.editPopover)).toBeVisible({ timeout: 5_000 })
    await byTid(page, TID.edit.editInstruction).fill('formalize')
    await byTid(page, TID.edit.editSubmit).click()
    await expect(byTid(page, TID.edit.finalText)).toContainText(/replaced text/, {
      timeout: 15_000,
    })
    const versionsAfterEdit = await versionItemCount(page)
    expect(versionsAfterEdit).toBeGreaterThanOrEqual(2)

    // Click the first non-current version item (an older version)
    const versionItems = byTid(page, TID.edit.versionItem)
    const olderItem = versionItems.nth(1) // index 1 = second-newest (non-current)
    await expect(olderItem).toBeVisible()
    await olderItem.click()

    // A restore confirmation modal should appear. Click "确认恢复".
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: '确认恢复' }).click()

    // A new "恢复" version should appear
    await expect(byTid(page, TID.edit.versionItem)).toHaveCount(versionsAfterEdit + 1, {
      timeout: 10_000,
    })
    // final-text should now reflect the restored (older) content
    await expect(byTid(page, TID.edit.finalText)).toContainText(/original text/, {
      timeout: 10_000,
    })
    await evidenceScreenshot(page, 'editing-version-restored')
  })

  test.skip('legacy discussion fixture is superseded by automatic v3 orchestration', async ({
    page,
    request,
  }) => {
    await seedConfig(request)
    await runTranslation(page, request)
    await runAllStages(page, request)

    const versionsBefore = await versionItemCount(page)
    const finalTextBefore = (await byTid(page, TID.edit.finalText).textContent()) ?? ''

    // Configure chat mock to return a plain text response (no tool_call)
    await setMockBehavior(request, {
      behavior: 'json_content',
      model: CHAT_MODEL,
      jsonContent: '这是一个讨论回复，不修改译文。',
    })

    // Find the chat textarea and send a plain message (no selection)
    const chatTextarea = page.getByLabel('聊天输入')
    await expect(chatTextarea).toBeVisible({ timeout: 5_000 })
    await chatTextarea.fill('这段译文的节奏如何？')
    await page.getByRole('button', { name: '发送' }).click()

    // A user chat message should appear
    await expect(
      page.locator(tid(TID.edit.chatMessage) + '[data-role="user"]'),
    ).toBeVisible({ timeout: 5_000 })
    // An assistant chat message should appear
    await expect(
      page.locator(tid(TID.edit.chatMessage) + '[data-role="assistant"]'),
    ).toBeVisible({ timeout: 30_000 })

    // No tool-call badge should be present (discussion round)
    await expect(byTid(page, TID.edit.toolCallBadge)).toHaveCount(0)

    // final-text should be unchanged
    await expect(byTid(page, TID.edit.finalText)).toHaveText(finalTextBefore)

    // No new version item should be added
    await expect(byTid(page, TID.edit.versionItem)).toHaveCount(versionsBefore)

    await evidenceScreenshot(page, 'editing-discussion-no-change')
  })
})
