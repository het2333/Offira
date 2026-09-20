import { expect, test, type FrameLocator } from '@playwright/test'

import { launchSlidesLocalWebHost } from './helpers/local-web-slides'
import { createProductionRuntimeProvider } from './helpers/production-runtime-provider'

test.setTimeout(45_000)

async function runProductionAgent(editor: FrameLocator, documentId: string, sessionId: string): Promise<void> {
  await expect.poll(() => editor.locator('body').evaluate(() =>
    (window as any).nexusdeskSlidesHost?.bridge.client().attached === true,
  )).toBe(true)
  await editor.locator('body').evaluate((_body, { documentId, sessionId }) => {
    const agent = (window as any).agentApi
    ;(window as any).__productionAgentUnsubscribe?.()
    ;(window as any).__productionAgentFrames = []
    ;(window as any).__productionAgentUnsubscribe = agent.onFrame((frame: unknown) => {
      ;(window as any).__productionAgentFrames.push(frame)
      if ((frame as any).type === 'approval:request') agent.respondApproval((frame as any).id, 'allowed-once')
    })
    agent.startTurn({
      prompt: 'Apply the title change and save it.', documentId, sessionId,
      provider: 'smoke', model: 'smoke-model',
    })
  }, { documentId, sessionId })
  try {
    await expect.poll(() => editor.locator('body').evaluate(() =>
      (window as any).__productionAgentFrames.some((frame: any) =>
        frame.type === 'agent:event' && frame.event?.type === 'turn/end' && frame.event?.data?.reason?.kind === 'completed',
      ),
    ), { timeout: 10_000 }).toBe(true)
    await editor.locator('body').evaluate(() => (window as any).__productionAgentUnsubscribe?.())
  } catch (error) {
    const frames = await editor.locator('body').evaluate(() => (window as any).__productionAgentFrames)
    throw new Error(`production runtime turn did not complete: ${JSON.stringify(frames)}; ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('Local Web Slides runs the production runtime and replays a repeated model tool call once', async ({ page }) => {
  const previousKey = process.env.NEXUSD_SMOKE_API_KEY
  process.env.NEXUSD_SMOKE_API_KEY = 'smoke'
  const provider = await createProductionRuntimeProvider()
  const host = await launchSlidesLocalWebHost({ runtimeCommand: provider.runtimeCommand })
  try {
    await page.goto(host.bootstrapUrl)
    await page.getByRole('button', { name: /^Deck\.pptx/ }).dblclick()
    const editor = page.frameLocator('iframe')
    await expect(editor.locator('body')).toBeVisible()

    await runProductionAgent(editor, host.documentId, 'production-runtime-first')
    await expect.poll(host.readApplyCount).toBe(1)
    await expect.poll(host.readPersistedText).toContain('Edited by production runtime')

    await runProductionAgent(editor, host.documentId, 'production-runtime-replay')
    await expect.poll(host.readApplyCount).toBe(1)
  } finally {
    await page.close()
    await host.close()
    await provider.close()
    if (previousKey === undefined) delete process.env.NEXUSD_SMOKE_API_KEY
    else process.env.NEXUSD_SMOKE_API_KEY = previousKey
  }
})
