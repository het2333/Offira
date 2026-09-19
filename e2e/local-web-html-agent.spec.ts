import { expect, test } from '@playwright/test'
import { launchContentLocalWeb } from './helpers/local-web-content'

async function runNativeTurn(editor: import('@playwright/test').FrameLocator, sessionId: string) {
  return editor.locator('body').evaluate(async (_body, nextSessionId) => {
    const target = window as typeof window & {
      agentApi: { startTurn(input: { prompt: string; documentId: string; sessionId: string }): void; respondApproval(id: string, outcome: 'allowed-once'): void; onFrame(callback: (frame: { type: string; id?: string; proposal?: { planHash?: string }; event?: { type?: string } }) => void): () => void }
      nexusdeskHtmlHost: { document: { documentId: string } }
    }
    return await new Promise<{ approvals: Array<{ id: string; planHash?: string }> }>((resolve, reject) => {
      const approvals: Array<{ id: string; planHash?: string }> = []
      const timeout = window.setTimeout(() => { stop(); reject(new Error('native HTML turn timed out')) }, 10_000)
      const stop = target.agentApi.onFrame((frame) => {
        if (frame.type === 'approval:request' && frame.id) { approvals.push({ id: frame.id, planHash: frame.proposal?.planHash }); target.agentApi.respondApproval(frame.id, 'allowed-once') }
        if (frame.type === 'agent:event' && frame.event?.type === 'turn/end') { window.clearTimeout(timeout); stop(); resolve({ approvals }) }
      })
      target.agentApi.startTurn({ prompt: 'Apply the approved content operation.', documentId: target.nexusdeskHtmlHost.document.documentId, sessionId: nextSessionId })
    })
  }, sessionId)
}

test('HTML browser saves one exact-approved native operation across reload', async ({ page }) => {
  const host = await launchContentLocalWeb('html')
  try {
    await page.goto(host.bootstrapUrl)
    await page.getByText(host.name).first().dblclick()
    const editor = page.frameLocator(`iframe[title="${host.name}"]`)
    await expect(editor.locator('.cm-content')).toContainText('Initial')
    await editor.getByRole('tab', { name: 'Source' }).click()
    await editor.locator('.cm-content').focus()
    await page.keyboard.press('Meta+A')
    await page.keyboard.insertText('<h1>Manual</h1>')
    await expect(editor.locator('.cm-content')).toContainText('Manual')
    await expect.poll(host.readText).toBe('<h1>Initial</h1>')
    await page.waitForTimeout(500)
    await page.reload()
    const recovered = page.frameLocator(`iframe[title="${host.name}"]`)
    await expect(recovered.locator('.cm-content')).toContainText('Manual')
    await expect.poll(host.readText).toBe('<h1>Initial</h1>')
    const first = await runNativeTurn(recovered, 'html-first')
    expect(first.approvals).toEqual([
      expect.objectContaining({ id: 'content-approval', planHash: expect.any(String) }),
      { id: 'content-save-approval', planHash: 'save-current-html-in-place' },
    ])
    await expect.poll(host.hasRecovery).toBe(false)
    await recovered.getByRole('tab', { name: 'Preview' }).click()
    await expect(recovered.frameLocator('iframe[title="preview"]').getByText('Manual Agent')).toBeVisible()
    await page.reload()
    const reloaded = page.frameLocator(`iframe[title="${host.name}"]`)
    await expect(reloaded.locator('.cm-content')).toContainText('Manual')
    await expect(reloaded.locator('.cm-content')).toContainText('Agent')
    const replay = await runNativeTurn(reloaded, 'html-replay')
    expect(replay.approvals).toHaveLength(0)
    await expect.poll(host.readApplyCount).toEqual({ applyCount: 1 })
    const disk = await host.readText()
    expect(disk).toContain('Manual')
    expect(disk.match(/Agent/g)).toHaveLength(1)
  } finally { await host.close() }
})
