import { expect, test } from '@playwright/test'
import { launchPdfLocalWebHost } from './helpers/local-web'
import type { AgentServerFrame } from '@nexusdesk/protocol'
import { PDF_TOOL_NAMES } from '../packages/nexusdesk-runtime-host/src/runtime-policy'

for (const replayTransport of [false, true]) {
  test(`production PDF Harness child executes real tools, exact approvals, and disk save${replayTransport ? ' with transport replay' : ''}`, async ({
    page,
  }) => {
    const host = await launchPdfLocalWebHost({ realRuntime: true })
    const replayed: string[] = []
    let observedFrames: AgentServerFrame[] = []
    if (replayTransport)
      await page.routeWebSocket('**/ws', (socket) => {
        const upstream = socket.connectToServer()
        upstream.onMessage((message) => {
          socket.send(message)
          const frame = JSON.parse(message.toString())
          if (
            frame.type === 'editor:request' &&
            ['apply_ops', 'save_pdf'].includes(frame.command)
          ) {
            // Simulate transport redelivery of the actual approved runtime request,
            // without fabricating a plan, approval, operation ID, or result.
            replayed.push(frame.command)
            socket.send(message)
          }
        })
      })
    try {
      await page.goto(host.bootstrapUrl)
      await page.getByText('Review.pdf').first().dblclick()
      const editor = page.frameLocator('iframe[title="Review.pdf"]')
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
        const observed: unknown[] = []
        ;(window as Window & { realHarnessFrames?: unknown[] }).realHarnessFrames = observed
        window.agentApi!.onFrame((frame) => observed.push(frame))
      })
      const rail = editor.locator('.ai-rail')
      if (await rail.isVisible()) await rail.click()
      await editor.locator('.ai-composer textarea').fill('Highlight NexusDesk and save.')
      await editor.locator('.ai-composer textarea').press('Enter')
      await expect(editor.locator('.ai-confirm-summary')).toBeVisible()
      expect((await host.inspectDiskPdf()).annotationCount).toBe(0)
      await editor
        .locator('.ai-confirm-card')
        .getByRole('button', { name: 'Confirm', exact: true })
        .click()
      await expect(editor.locator('.ai-confirm-summary')).toContainText('Save the current PDF')
      expect((await host.inspectDiskPdf()).annotationCount).toBe(0)
      await editor
        .locator('.ai-confirm-card')
        .getByRole('button', { name: 'Confirm', exact: true })
        .click()
      await expect(editor.locator('.ai-msg-assistant')).toContainText(
        'PDF saved by the real Harness runtime.',
      )
      await expect.poll(host.inspectDiskPdf).toMatchObject({ changed: true, annotationCount: 1 })
      observedFrames = await editor
        .locator('body')
        .evaluate(
          () =>
            (window as Window & { realHarnessFrames?: AgentServerFrame[] }).realHarnessFrames ?? [],
        )
      const approvals = observedFrames.filter((frame) => frame.type === 'approval:request')
      expect(approvals).toHaveLength(2)
      if (replayTransport) expect(replayed).toEqual(['apply_ops', 'save_pdf'])
      for (const frame of approvals)
        expect(frame.proposal).toMatchObject({
          operationId: expect.any(String),
          planHash: expect.any(String),
          snapshotHash: expect.any(String),
        })
      for (const approval of approvals) {
        const applied = observedFrames.find(
          (frame) => frame.type === 'editor:request' && frame.approval?.id === approval.id,
        )
        expect(applied).toMatchObject({
          target: { operationId: approval.proposal!.operationId },
          approval: { planHash: approval.proposal!.planHash },
        })
      }
      expect(host.providerRequests).toHaveLength(3)
      const catalog = host.providerRequests![0]!.tools!.map((tool) => tool.function.name)
      expect(catalog.sort()).toEqual([...PDF_TOOL_NAMES].sort())
      const results = host
        .providerRequests!.at(-1)!
        .messages.filter((message) => message.role === 'tool')
      expect(results).toHaveLength(2)
      for (const result of results) expect(String(result.content)).toContain('"ok":true')
      await page.reload()
      await expect.poll(host.inspectDiskPdf).toMatchObject({ annotationCount: 1 })
    } finally {
      await test.info().attach('local-provider-requests', {
        body: JSON.stringify(host.providerRequests, null, 2),
        contentType: 'application/json',
      })
      const frame = page.frames().find((frame) => frame.parentFrame() !== null)
      if (frame) {
        const frames = observedFrames.length
          ? JSON.stringify(observedFrames)
          : await frame.evaluate(() =>
              JSON.stringify(
                (window as Window & { realHarnessFrames?: unknown[] }).realHarnessFrames,
              ),
            )
        await test
          .info()
          .attach('runtime-frames', { body: frames ?? '[]', contentType: 'application/json' })
      }
      await host.close()
    }
  })
}
