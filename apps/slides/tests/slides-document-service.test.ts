import { describe, expect, it } from 'vitest'
import { addElement, createBlankPptx, openPptx, savePptx } from '@genoffice/pptx-engine'

import { SlidesDocumentService } from '../src/main/slides-document-service'

function renderedText(service: SlidesDocumentService): string {
  return service.renderSlides().flatMap((slide) => slide.nodes)
    .flatMap((node) => node.type === 'text' || node.type === 'shape' ? node.text?.lines ?? [] : [])
    .map((line) => line.runs.map((run) => run.text).join(''))
    .join('\n')
}

describe('SlidesDocumentService', () => {
  it('opens a real PPTX, applies the existing transaction DSL, saves bytes, and restores the change', async () => {
    const sourceDeck = await openPptx(await createBlankPptx())
    addElement(sourceDeck.deck.slides[0]!, {
      kind: 'textbox',
      offset: { x: 0, y: 0, cx: 1828800, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'Original title' }] }],
    })
    const source = await savePptx(sourceDeck)
    const service = await SlidesDocumentService.open(source, 'Deck.pptx', 960)
    const initial = service.openResult()
    const title = initial.slides[0]?.nodes.find((node) => node.type === 'text' || node.type === 'shape')

    expect(title).toBeDefined()
    const result = service.applyTransaction({
      ops: [
        {
          op: 'setText',
          target: { slide: 0, el: title!.sourceId },
          paragraphs: [{ runs: [{ text: 'Saved in browser' }] }],
        },
      ],
    })
    expect(result.applied).toBe(true)

    const saved = await service.saveBytes()
    const restored = await SlidesDocumentService.open(saved, 'Deck.pptx', 960)
    const renderedText = restored.openResult().slides[0]!.nodes
      .flatMap((node) => (node.type === 'text' || node.type === 'shape' ? node.text?.lines ?? [] : []))
      .map((line) => `${line.runs.map((run) => run.text).join('')}${line.trailingText ?? ''}`)
      .join('')
    expect(renderedText).toContain('Saved in browser')
  })

  it('advances a memory content version for unsaved edits', async () => {
    const sourceDeck = await openPptx(await createBlankPptx())
    addElement(sourceDeck.deck.slides[0]!, {
      kind: 'textbox',
      offset: { x: 0, y: 0, cx: 1828800, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'Original title' }] }],
    })
    const service = await SlidesDocumentService.open(await savePptx(sourceDeck), 'Deck.pptx', 960)
    const title = service.openResult().slides[0]!.nodes.find((node) => node.type === 'text' || node.type === 'shape')!

    expect((service.readPresentation() as { contentVersion?: number }).contentVersion).toBe(1)
    const result = service.applyTransaction({
      ops: [{ op: 'setText', target: { slide: 0, el: title.sourceId }, paragraphs: [{ runs: [{ text: 'Unsaved title' }] }] }],
    })

    expect(result).toMatchObject({ applied: true, contentVersion: 2 })
    expect((service.readPresentation() as { contentVersion?: number }).contentVersion).toBe(2)
  })

  it('records manual text edits and Agent transactions in the same undo and redo history', async () => {
    const sourceDeck = await openPptx(await createBlankPptx())
    addElement(sourceDeck.deck.slides[0]!, {
      kind: 'textbox',
      offset: { x: 0, y: 0, cx: 1828800, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'Original title' }] }],
    })
    const service = await SlidesDocumentService.open(await savePptx(sourceDeck), 'Deck.pptx', 960)
    const title = service.openResult().slides[0]!.nodes.find((node) => node.type === 'text' || node.type === 'shape')!

    await service.editText({
      slideIndex: 0,
      sourceId: title.sourceId,
      paragraphs: [{ runs: [{ text: 'Manual edit' }] }],
    })
    service.applyTransaction({
      ops: [{ op: 'setText', target: { slide: 0, el: title.sourceId }, paragraphs: [{ runs: [{ text: 'Agent edit' }] }] }],
    })

    await service.undo()
    expect(renderedText(service)).toContain('Manual edit')
    await service.undo()
    expect(renderedText(service)).toContain('Original title')
    await service.redo()
    await service.redo()
    expect(renderedText(service)).toContain('Agent edit')
  })

  it('runs browser CRUD and fill actions through transactions with undo and redo', async () => {
    const service = await SlidesDocumentService.open(await createBlankPptx(), 'Deck.pptx', 960)

    const added = await service.executeUi('add-element', {
      slideIndex: 0,
      kind: 'rect',
      xPx: 30,
      yPx: 40,
      wPx: 200,
      hPx: 100,
      fitWidthPx: 960,
      fillColor: '#336699',
    }) as { sourceId: string; slide: { nodes: Array<{ sourceId: string }> }; contentVersion: number }
    const filled = await service.executeUi('edit-fill', {
      slideIndex: 0,
      sourceId: added.sourceId,
      fill: '#ff0000',
    }) as { slide: unknown; contentVersion: number }
    const undone = await service.undo()
    const redone = await service.redo()

    expect(added.slide.nodes.some((node) => node.sourceId === added.sourceId)).toBe(true)
    expect(filled.contentVersion).toBeGreaterThan(added.contentVersion)
    expect(undone).not.toBeNull()
    expect(redone).not.toBeNull()
    expect(service.renderSlides()[0]!.nodes).toHaveLength(added.slide.nodes.length)
  })

  it('adds a blank slide from the browser action payload', async () => {
    const service = await SlidesDocumentService.open(await createBlankPptx(), 'Deck.pptx', 960)

    const added = await service.executeUi('add-slide', {
      sourceIndex: 0,
      clearText: true,
    }) as { slides: unknown[]; index: number; contentVersion: number }

    expect(added).toMatchObject({ index: 1, contentVersion: 2 })
    expect(added.slides).toHaveLength(2)
  })
})
