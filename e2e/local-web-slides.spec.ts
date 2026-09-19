import { expect, test, type FrameLocator } from '@playwright/test'

import { launchSlidesLocalWebHost } from './helpers/local-web-slides'

test.use({ viewport: { width: 1600, height: 1100 } })
test.setTimeout(45_000)

async function runAgent(editor: FrameLocator, documentId: string, sessionId: string): Promise<void> {
  await expect.poll(() => editor.locator('body').evaluate(() =>
    (window as any).nexusdeskSlidesHost?.bridge.client().attached === true,
  )).toBe(true)
  await editor.locator('body').evaluate((_body, { documentId, sessionId }) => {
    const agent = (window as any).agentApi
    ;(window as any).__slidesAgentFrames = []
    agent.onFrame((frame: unknown) => {
      ;(window as any).__slidesAgentFrames.push(frame)
      if ((frame as any).type === 'approval:request' && (frame as any).id) {
        agent.respondApproval((frame as any).id, 'allowed-once')
      }
    })
    agent.startTurn({ prompt: 'Apply the approved title edit.', documentId, sessionId })
  }, { documentId, sessionId })
  try {
    await expect.poll(() => editor.locator('body').evaluate(() =>
      (window as any).__slidesAgentFrames.some((frame: any) =>
        frame.type === 'agent:event' && frame.event?.type === 'turn/end' && frame.event?.data?.reason?.kind === 'completed',
      ),
    ), { timeout: 5_000 }).toBe(true)
  } catch (error) {
    const frames = await editor.locator('body').evaluate(() => (window as any).__slidesAgentFrames)
    throw new Error(`agent turn did not complete: ${JSON.stringify(frames)}; ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function renderedText(editor: FrameLocator): Promise<string> {
  return editor.locator('body').evaluate(async () =>
    (await (window as any).slidesApi.getRenderSlides())
      .flatMap((slide: any) => slide.nodes)
      .flatMap((node: any) => node.text?.lines ?? [])
      .map((line: any) => line.runs.map((run: any) => run.text).join(''))
      .join('\n'),
  )
}

test('Local Web Slides opens the original UI, persists manual and slide CRUD edits, and replays one approved Harness operation', async ({ page }) => {
  const host = await launchSlidesLocalWebHost()
  let stage = 'open Home'
  try {
    await page.goto(host.bootstrapUrl)
    await expect(page.getByRole('tab', { name: /home/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Deck\.pptx/ })).toBeVisible()
    await page.getByRole('button', { name: /^Deck\.pptx/ }).dblclick()
    const editor = page.frameLocator('iframe')
    await expect(editor.locator('body')).toBeVisible()

    stage = 'load render model'
    const render = await editor.locator('body').evaluate(async () => (window as any).slidesApi.getRenderSlides())
    const title = render[0]!.nodes.find((node: any) => node.type === 'text' && node.sourceId)
    expect(title).toBeDefined()
    const text = title!.text!
    const firstLine = text.lines[0]!
    const firstRun = firstLine.runs[0]!
    // Konva renders content and hit-test canvases in a stack. Target their shared
    // container so Playwright sends real pointer events to the top hit canvas.
    const canvas = editor.locator('.stage-rel .konvajs-content')
    await canvas.scrollIntoViewIfNeeded()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    const point = {
      x: (160 + title!.box.x + text.insets.l + firstRun.x + firstRun.widthPx / 2) * box!.width / (render[0]!.widthPx + 320),
      y: (160 + title!.box.y + text.insets.t + firstLine.top + firstLine.height / 2) * box!.height / (render[0]!.heightPx + 320),
    }
    stage = 'open text editor from canvas'
    const textEditor = editor.locator('[contenteditable="true"]')
    // The original editor opens text on a click in the glyph hit-area; double-click
    // remains the fallback for a frame-only hit on a delayed Konva render.
    await canvas.click({ position: point })
    if (!(await textEditor.isVisible())) await canvas.dblclick({ position: point })
    await expect(textEditor).toBeVisible()
    stage = 'commit manual text edit'
    await textEditor.fill('Edited manually in Local Web')
    await textEditor.press('Control+Enter')
    await editor.getByRole('button', { name: /^Save/ }).click()
    await expect.poll(host.readApplyCount).toBe(0)
    await expect.poll(host.readPersistedText).toContain('Edited manually in Local Web')

    // Original UI path: browser addBlankSlide -> shared transaction bridge -> in-place save.
    stage = 'add a slide through original UI'
    await editor.getByRole('button', { name: 'Slides' }).click()
    await editor.getByRole('button', { name: 'New Slide' }).click()
    await expect.poll(() => editor.locator('body').evaluate(async () =>
      (await (window as any).slidesApi.getRenderSlides()).length,
    )).toBe(render.length + 1)
    await editor.getByRole('button', { name: /^Save/ }).click()
    await expect.poll(host.readPersistedText).toContain('Edited manually in Local Web')

    stage = 'reload manual edits'
    await page.reload()
    const reloaded = page.frameLocator('iframe')
    await expect(reloaded.locator('body')).toBeVisible()
    await expect.poll(() => renderedText(reloaded)).toContain('Edited manually in Local Web')

    stage = 'complete approved agent edit'
    await runAgent(reloaded, host.documentId, 'slides-e2e-session')
    await expect.poll(host.readApplyCount).toBe(1)
    await page.reload()
    const afterAgent = page.frameLocator('iframe')
    await expect.poll(() => renderedText(afterAgent)).toContain('Edited by approved Harness')
    await expect.poll(host.readPersistedText).toContain('Edited by approved Harness')

    stage = 'complete replayed agent edit'
    await runAgent(afterAgent, host.documentId, 'slides-e2e-retry')
    await expect.poll(host.readApplyCount).toBe(1)
    await expect.poll(host.readPersistedText).toContain('Edited by approved Harness')
  } catch (error) {
    throw new Error(`Slides Local Web E2E stalled at ${stage}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // Release the page WebSocket before awaiting the embedded host's shutdown.
    await page.close()
    await host.close()
  }
})
