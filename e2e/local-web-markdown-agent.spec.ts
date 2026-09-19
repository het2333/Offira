import { expect, test, type FrameLocator } from '@playwright/test'
import { launchContentLocalWeb } from './helpers/local-web-content'

async function runNativeTurn(editor: FrameLocator, sessionId: string) {
  return editor.locator('body').evaluate(async (_body, nextSessionId) => {
    const target = window as typeof window & {
      agentApi: {
        startTurn(input: { prompt: string; documentId: string; sessionId: string }): void
        respondApproval(id: string, outcome: 'allowed-once'): void
        onFrame(callback: (frame: { type: string; id?: string; proposal?: { planHash?: string } }) => void): () => void
      }
      nexusdeskMarkdownHost: { document: { documentId: string } }
    }
    return await new Promise<{ approvals: Array<{ id: string; planHash?: string }> }>((resolve, reject) => {
      const approvals: Array<{ id: string; planHash?: string }> = []
      const timeout = window.setTimeout(() => { stop(); reject(new Error('native Markdown turn timed out')) }, 10_000)
      const stop = target.agentApi.onFrame((frame) => {
        if (frame.type === 'approval:request' && frame.id) {
          approvals.push({ id: frame.id, planHash: frame.proposal?.planHash })
          target.agentApi.respondApproval(frame.id, 'allowed-once')
        }
        if (frame.type === 'agent:event' && (frame as { event?: { type?: string } }).event?.type === 'turn/end') {
          window.clearTimeout(timeout); stop(); resolve({ approvals })
        }
      })
      target.agentApi.startTurn({ prompt: 'Apply the approved content operation.', documentId: target.nexusdeskMarkdownHost.document.documentId, sessionId: nextSessionId })
    })
  }, sessionId)
}

test('Markdown browser saves one exact-approved native operation across reload', async ({ page }) => {
  const host = await launchContentLocalWeb('markdown')
  try {
    await page.goto(host.bootstrapUrl)
    await page.getByText(host.name).first().dblclick()
    const editor = page.frameLocator(`iframe[title="${host.name}"]`)
    await expect(editor.locator('.ProseMirror')).toContainText('Initial')
    await editor.locator('.ProseMirror').focus()
    await page.keyboard.press('Meta+A')
    await page.keyboard.insertText('Manual')
    await expect(editor.locator('.ProseMirror')).toContainText('Manual')
    const first = await runNativeTurn(editor, 'markdown-first')
    expect(first.approvals).toEqual([
      expect.objectContaining({ id: 'content-approval', planHash: expect.any(String) }),
      { id: 'content-save-approval', planHash: 'save-current-markdown-in-place' },
    ])
    await page.reload()
    const reloaded = page.frameLocator(`iframe[title="${host.name}"]`)
    await expect(reloaded.locator('.ProseMirror')).toContainText('Manual')
    await expect(reloaded.locator('.ProseMirror')).toContainText('Agent')
    const replay = await runNativeTurn(reloaded, 'markdown-replay')
    expect(replay.approvals).toHaveLength(0)
    await expect.poll(host.readApplyCount).toEqual({ applyCount: 1 })
    const disk = await host.readText()
    expect(disk).toContain('Manual')
    expect(disk.match(/Agent/g)).toHaveLength(1)
  } finally { await host.close() }
})
