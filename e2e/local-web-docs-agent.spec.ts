import { expect, test, type FrameLocator } from '@playwright/test'

import { launchDocsLocalWebHost } from './helpers/local-web-docs'

async function runApprovedDocsTurn(
  frame: FrameLocator,
  input: { documentId: string; sessionId: string; prompt: string },
) {
  return frame.locator('body').evaluate(
    (_body, request) =>
      new Promise<{ approvals: string[]; text: string }>((resolve, reject) => {
        const agent = (
          window as unknown as {
            agentApi?: {
              startTurn(value: { prompt: string; documentId: string; sessionId: string }): void
              respondApproval(id: string, outcome: 'allowed-once' | 'denied'): void
              onFrame(callback: (frame: Record<string, unknown>) => void): () => void
            }
          }
        ).agentApi
        if (agent === undefined) {
          reject(new Error('Docs Agent API is unavailable'))
          return
        }
        const approvals: string[] = []
        let text = ''
        const timer = window.setTimeout(() => {
          off()
          reject(new Error('Docs Agent turn timed out'))
        }, 30_000)
        const finish = (result: { approvals: string[]; text: string }) => {
          window.clearTimeout(timer)
          off()
          resolve(result)
        }
        const off = agent.onFrame((message) => {
          if (message.type === 'approval:request' && message.sessionId === request.sessionId) {
            const reason = typeof message.reason === 'string' ? message.reason : 'Approve operation'
            const proposal = message.proposal as { planHash?: unknown } | undefined
            const planHash =
              typeof proposal?.planHash === 'string' ? proposal.planHash : 'missing-plan-hash'
            const detail = `${reason}\nPlan hash: ${planHash}`
            approvals.push(detail)
            agent.respondApproval(
              String(message.id),
              window.confirm(detail) ? 'allowed-once' : 'denied',
            )
            return
          }
          if (message.type === 'fatal') {
            window.clearTimeout(timer)
            off()
            reject(new Error(String(message.message ?? 'Harness runtime failed')))
            return
          }
          if (message.type !== 'agent:event' || message.sessionId !== request.sessionId) return
          const event = message.event as { type?: unknown; data?: Record<string, unknown> }
          if (
            event.type === 'stream/chunk' &&
            event.data?.type === 'text-delta' &&
            typeof event.data.text === 'string'
          ) {
            text += event.data.text
          }
          if (event.type === 'turn/end') finish({ approvals, text })
        })
        agent.startTurn(request)
      }),
    input,
  )
}

test('Docs authenticated browser edits and saves one approved operation across reload', async ({
  page,
}) => {
  const host = await launchDocsLocalWebHost()
  const dialogs: string[] = []
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.accept()
  })

  try {
    await page.goto(host.bootstrapUrl)
    await expect(page.getByRole('tab', { name: /home/i })).toBeVisible()
    await page.getByText('nexusdesk-docs-source.docx').first().dblclick()
    await expect(page.getByRole('tab', { name: 'nexusdesk-docs-source.docx' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    const editorElement = page.locator('iframe[title="nexusdesk-docs-source.docx"]')
    const editorBox = await editorElement.boundingBox()
    expect(editorBox?.width).toBeGreaterThan(900)
    expect(editorBox?.height).toBeGreaterThan(500)
    const editor = page.frameLocator('iframe[title="nexusdesk-docs-source.docx"]')
    const document = editor.locator('.ProseMirror')
    await expect(document).toContainText('第一段。')
    await document.click()
    await document.pressSequentially('Manual edit. ')

    const first = await runApprovedDocsTurn(editor, {
      documentId: host.documentId,
      sessionId: 'docs-session-1',
      prompt: 'Apply the deterministic document edit and save it.',
    })
    expect(first.approvals).toHaveLength(2)
    expect(first.text).toContain('Document saved.')
    await expect(document).toContainText('Manual edit.')
    await expect(document).toContainText('Agent edit. 第一段。')
    await expect.poll(host.readApplyCount).toBe(1)

    await page.reload()
    await expect(page.getByRole('tab', { name: 'nexusdesk-docs-source.docx' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const reloadedEditor = page.frameLocator('iframe[title="nexusdesk-docs-source.docx"]')
    const reloadedDocument = reloadedEditor.locator('.ProseMirror')
    await expect(reloadedDocument).toContainText('Manual edit.')
    await expect(reloadedDocument).toContainText('Agent edit. 第一段。')

    const replay = await runApprovedDocsTurn(reloadedEditor, {
      documentId: host.documentId,
      sessionId: 'docs-session-2',
      prompt: 'Retry the same accepted document operation.',
    })
    expect(replay.approvals).toHaveLength(1)
    await expect.poll(host.readApplyCount).toBe(1)
    expect(dialogs).toHaveLength(3)
    expect(await reloadedDocument.getByText('Agent edit.', { exact: false }).count()).toBe(1)

    const diskText = await host.readDocumentText()
    expect(diskText).toContain('Manual edit.')
    expect(diskText.match(/Agent edit\./g)).toHaveLength(1)
  } finally {
    await host.close()
  }
})
