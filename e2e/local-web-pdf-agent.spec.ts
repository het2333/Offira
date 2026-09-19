import { expect, test } from '@playwright/test'

import { launchPdfLocalWebHost } from './helpers/local-web'

async function startPdfHarnessTurn(
  editor: ReturnType<import('@playwright/test').Page['frameLocator']>,
  sessionId: string,
  prompt: string,
): Promise<void> {
  await expect
    .poll(() =>
      editor
        .locator('body')
        .evaluate(() =>
          Boolean(window.agentApi && window.nexusdeskPdfHost?.bridge.client().attached),
        ),
    )
    .toBe(true)
  await editor.locator('body').evaluate(() => {
    const target = window as Window & {
      nexusdeskPdfHarnessApprovals?: string[]
      stopNexusdeskPdfHarnessApprovals?: () => void
    }
    target.stopNexusdeskPdfHarnessApprovals?.()
    target.nexusdeskPdfHarnessApprovals = []
    target.stopNexusdeskPdfHarnessApprovals = window.agentApi?.onFrame((frame) => {
      if (frame.type !== 'approval:request') return
      target.nexusdeskPdfHarnessApprovals?.push(frame.id)
      window.agentApi?.respondApproval(frame.id, 'allowed-once')
    })
  })
  await editor.locator('body').evaluate(
    (_element, { prompt: turnPrompt, sessionId: turnSessionId }) => {
      const api = window.agentApi
      const documentId = window.nexusdeskPdfHost?.document.documentId
      if (api === undefined || documentId === undefined)
        throw new Error('PDF Harness bridge is unavailable')
      api.startTurn({ prompt: turnPrompt, sessionId: turnSessionId, documentId })
    },
    { prompt, sessionId },
  )
}

async function approvalCount(
  editor: ReturnType<import('@playwright/test').Page['frameLocator']>,
): Promise<number> {
  return editor
    .locator('body')
    .evaluate(
      () =>
        (window as Window & { nexusdeskPdfHarnessApprovals?: string[] })
          .nexusdeskPdfHarnessApprovals?.length ?? 0,
    )
}

test('Local Web persists a manual PDF edit and one approved semantic agent edit across reload', async ({
  page,
}) => {
  const host = await launchPdfLocalWebHost()
  try {
    await page.goto(host.bootstrapUrl)
    await expect(page.getByRole('tab', { name: /home/i })).toBeVisible()
    await page.getByText('Review.pdf').first().dblclick()
    await expect(page.getByRole('tab', { name: 'Review.pdf' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    const editor = page.frameLocator('iframe[title="Review.pdf"]')
    await editor.getByRole('button', { name: 'Edit', exact: true }).click()
    await editor.getByRole('button', { name: /insert text/i }).click()
    await editor.locator('textarea.pdf-modal-textarea').fill('Manual Local Web text')
    await editor.getByRole('button', { name: /^ok$/i }).click()
    const canvas = editor.locator('canvas').first()
    await expect(canvas).toBeVisible()
    await canvas.click({ position: { x: 120, y: 160 } })

    await startPdfHarnessTurn(editor, 'pdf-e2e-turn-1', 'Highlight NexusDesk and save.')
    await expect.poll(host.readApplyCount).toBe(1)
    await expect.poll(() => approvalCount(editor)).toBe(2)
    await expect.poll(host.readApplyCount).toBe(1)

    await page.reload()
    await expect(page.getByRole('tab', { name: 'Review.pdf' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const reloadedEditor = page.frameLocator('iframe[title="Review.pdf"]')
    await startPdfHarnessTurn(
      reloadedEditor,
      'pdf-e2e-turn-2',
      'Retry the same accepted operation.',
    )
    await expect.poll(host.readApplyCount).toBe(1)
    await expect.poll(() => approvalCount(reloadedEditor)).toBe(0)

    await expect.poll(host.inspectDiskPdf).toMatchObject({
      changed: true,
      annotationCount: 1,
      text: expect.stringContaining('Manual Local Web text'),
    })
  } finally {
    await host.close()
  }
})
