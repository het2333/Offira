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

test('Local Web PDF gates native controls and completes approved and manual page rewrites', async ({
  page,
}) => {
  const host = await launchPdfLocalWebHost()
  try {
    await page.goto(host.bootstrapUrl)
    await page.getByText('Review.pdf').first().dblclick()
    const editor = page.frameLocator('iframe[title="Review.pdf"]')
    await expect(editor.getByRole('button', { name: 'PDF Converter', exact: true })).toBeDisabled()
    await expect(editor.getByRole('button', { name: 'Print', exact: true })).toBeDisabled()
    await expect(editor.getByRole('button', { name: 'Export images', exact: true })).toBeDisabled()
    await editor.getByRole('button', { name: 'Annotate', exact: true }).click()
    await expect(editor.getByRole('button', { name: 'Redact area', exact: true })).toBeDisabled()
    await editor.getByRole('button', { name: 'Pages', exact: true }).click()
    for (const name of ['Extract page', 'Import pages', 'Replace pages', 'Split PDF', 'Merge PDF'])
      await expect(editor.getByRole('button', { name, exact: true })).toBeDisabled()
    await expect(
      editor.getByRole('button', { name: 'Insert blank page', exact: true }),
    ).toBeEnabled()
    await expect(editor.getByRole('button', { name: 'Crop pages', exact: true })).toBeEnabled()
    const rail = editor.locator('.ai-rail')
    if (await rail.isVisible()) await rail.click()
    await editor.locator('.ai-composer textarea').fill('Insert a blank page.')
    await editor.locator('.ai-composer textarea').press('Enter')
    await expect(editor.locator('.ai-confirm-summary')).toContainText(
      'insert a blank page after page 1',
    )
    await editor
      .locator('.ai-confirm-card')
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await expect.poll(host.readApplyCount).toBe(1)
    await expect(editor.locator('.ai-confirm-summary')).toContainText('Save the current PDF')
    await editor
      .locator('.ai-confirm-card')
      .getByRole('button', { name: 'Confirm', exact: true })
      .click()
    await expect(editor.locator('.ai-msg-assistant')).toContainText('PDF saved.')
    await expect.poll(host.inspectDiskPdf).toMatchObject({ pageCount: 2 })
    await editor.getByRole('button', { name: 'Insert blank page', exact: true }).click()
    await expect.poll(host.inspectDiskPdf).toMatchObject({ pageCount: 3 })
    await editor.getByRole('button', { name: 'Page size', exact: true }).click()
    await editor.getByRole('button', { name: 'A4', exact: true }).click()
    await expect.poll(host.inspectDiskPdf).toMatchObject({
      pageSizes: [
        { width: 595, height: 842 },
        { width: 595, height: 842 },
        { width: 595, height: 842 },
      ],
    })
    await page.reload()
    await expect.poll(host.inspectDiskPdf).toMatchObject({ pageCount: 3 })
  } finally {
    await host.close()
  }
})

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
    await expect(editor.locator('.pdf-page.pdf-inserting-text')).toBeVisible()
    const pdfPage = editor.locator('.pdf-page').first()
    await expect(pdfPage).toBeVisible()
    await pdfPage.click({ position: { x: 120, y: 160 } })
    await expect(editor.locator('.pdf-textinsert-preview').first()).toContainText(
      'Manual Local Web text',
    )

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
