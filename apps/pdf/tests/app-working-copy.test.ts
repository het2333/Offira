import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkingCopyMutationLane } from '@nexusdesk/web-client'
import type { PdfEditorAdapter, PdfMutationResult } from '../src/renderer/agent/browser-agent-api'
import type { PdfAppDeps } from '../src/renderer/ai/tools'
import type { PdfBrowserHostHandle } from '../src/renderer/browser-host-api'
import { createPdfBrowserApi } from '../src/renderer/browser-host-api'
import { PDF_WEB_CAPABILITIES } from '../src/shared/web-capabilities'
import { decodePdfWorkingCopy } from '../src/shared/working-copy'
import App from '../src/renderer/App'

const view = vi.hoisted(() => ({
  api: undefined as PdfAppDeps | undefined,
  selectImage: undefined as ((id: string, x: number, y: number) => void) | undefined,
}))
// Worker/canvas rendering is external to the state/adapter contract exercised here.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getMetadata: async () => ({ info: {} }),
      getOutline: async () => [],
      getFieldObjects: async () => null,
      getPage: async () => ({
        rotate: 0,
        view: [0, 0, 300, 400],
        userUnit: 1,
        getViewport: () => ({ width: 300, height: 400 }),
        getAnnotations: async () => [],
        getTextContent: async () => ({ items: [], styles: {} }),
      }),
      loadingTask: { destroy: async () => {} },
    }),
  }),
}))
vi.mock('../src/renderer/PdfPage', () => ({
  useVisibleSet: () => ({ visible: new Set<number>([0]), setItemRef: () => {} }),
  PdfPage: () => null,
  MarkupOverlay: () => null,
}))
vi.mock('../src/renderer/PdfThumb', () => ({
  PdfThumb: () => null,
  ThumbPendingOverlay: () => null,
}))
vi.mock('../src/renderer/ai/AiPanel', () => ({
  AiPanel: ({ api }: { api: PdfAppDeps }) => {
    view.api = api
    return null
  },
  GensparkMark: () => null,
}))
vi.mock('../src/renderer/ImageEditLayer', async (original) => ({
  ...(await original<typeof import('../src/renderer/ImageEditLayer')>()),
  ImageEditLayer: ({
    onSelectEdit,
  }: {
    onSelectEdit: (id: string, x: number, y: number) => void
  }) => {
    view.selectImage = onSelectEdit
    return null
  },
}))

let root: Root
let container: HTMLDivElement
let adapter: PdfEditorAdapter
let host: PdfBrowserHostHandle

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const lane = createWorkingCopyMutationLane()
  const document = {
    documentId: 'pdf',
    title: 'test.pdf',
    revision: 1,
    websocketUrl: 'ws://localhost',
    language: 'en',
    theme: 'light' as const,
    contentUrl: '/source',
    capabilities: PDF_WEB_CAPABILITIES,
    workingCopy: {
      documentEpoch: 'epoch',
      workingRevision: 1,
      savedRevision: 1,
      sourceContentId: 'a'.repeat(64),
      checkpointId: null,
      dirty: false,
      recoveryState: 'ready' as const,
      contentUrl: '/source',
    },
  }
  const pdfApi = createPdfBrowserApi({ document, updateRevision() {} }, {
    readContent: async () => new Uint8Array([37, 80, 68, 70]),
    listPageImages: async () => [],
    listStaticFormFills: async () => [],
    pageImagePng: async () => null,
  } as never)
  host = {
    document,
    capabilities: document.capabilities,
    pdfApi,
    recoveryDirty: false,
    busy: false,
    hydrated: true,
    bridge: { consumeApproval: () => true },
    attachEditor(next: PdfEditorAdapter) {
      adapter = next
      return () => {}
    },
    setHydrated() {},
    onWorkingCopyState: () => () => {},
    runMutation: lane.run,
  } as unknown as PdfBrowserHostHandle
  window.pdfApi = pdfApi
  window.nexusdeskPdfHost = host
  container = window.document.createElement('div')
  window.document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(App))
  })
  expect(adapter).toBeDefined()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete window.nexusdeskPdfHost
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function requestOf(result: PdfMutationResult) {
  expect(result.ok).toBe(true)
  expect(result.workingCopy).toBeDefined()
  return decodePdfWorkingCopy(
    new Map(
      await Promise.all(
        [...result.workingCopy!.parts].map(
          async ([key, blob]) => [key, new Uint8Array(await blob.arrayBuffer())] as const,
        ),
      ),
    ),
  ).request
}

describe('App working-copy adapter timing', () => {
  it('detects draft typing during the digest even before React commits its render', async () => {
    await act(async () => {
      view.api!.addNote(0, [50, 50], 'Before')
    })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.pdf-note-card button[aria-label="编辑"]')!
        .click()
    })
    const input = container.querySelector<HTMLTextAreaElement>('.pdf-note-card textarea')!
    const plan = await adapter.proposeSave()
    const current = adapter
    let release!: () => void
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle)
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return digest(...args)
    })
    await act(async () => {
      const result = current.save({ ...plan, operations: [], approvalId: 'approval' })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Late draft',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
      release()
      expect(await result).toMatchObject({ ok: false, warnings: [{ code: 'STALE_PLAN' }] })
    })
  })

  it.each([false, true])(
    'recognizes its durable head and protects later manual work (late=%s)',
    async (late) => {
      const current = adapter
      await act(async () => {
        const snapshotHash = await current.snapshot()
        await current.apply({
          approvalId: 'approval',
          planHash: 'plan',
          snapshotHash,
          summary: 'Rotate',
          targets: [],
          operations: [{ op: 'rotatePages', pages: [0], dir: 90 }],
        })
        await current.persisted!({
          documentEpoch: 'epoch',
          operationId: 'op',
          requestFingerprint: 'f'.repeat(64),
          checkpointId: 'checkpoint',
          blobHash: 'b'.repeat(64),
          workingRevision: 2,
          savedRevision: 1,
          dirty: true,
        })
      })
      if (late)
        await act(async () => {
          view.api!.applyOps([{ op: 'rotatePages', pages: [0], dir: 90 }])
        })
      host.document.workingCopy!.sourceContentId = 'b'.repeat(64)
      await act(async () => {
        if (late)
          await expect(adapter.restoreWorkingCopy!()).rejects.toMatchObject({
            code: 'PDF_RECOVERY_LOCAL_CHANGES',
          })
        else await adapter.restoreWorkingCopy!()
      })
      if (late) host.document.workingCopy!.sourceContentId = 'a'.repeat(64)
      await act(async () => {
        const plan = await adapter.proposeSave()
        const captured = await requestOf(
          await adapter.save({ ...plan, operations: [], approvalId: 'approval' }),
        )
        expect(captured.rotations).toEqual(late ? [{ pageIndex: 0, delta: 180 }] : [])
      })
    },
  )

  it('keeps the open note edit draft through same-source recovery and includes it in the next save', async () => {
    await act(async () => {
      view.api!.addNote(0, [50, 50], 'Before')
    })
    const edit = container.querySelector<HTMLButtonElement>(
      '.pdf-note-card button[aria-label="编辑"]',
    )!
    expect(edit).not.toBeNull()
    await act(async () => {
      edit.click()
    })
    const input = container.querySelector<HTMLTextAreaElement>('.pdf-note-card textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Keep draft',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await adapter.restoreWorkingCopy!()
    })
    expect(container.querySelector<HTMLTextAreaElement>('.pdf-note-card textarea')?.value).toBe(
      'Keep draft',
    )
    const current = adapter
    await act(async () => {
      const snapshotHash = await current.snapshot()
      const captured = await requestOf(
        await current.apply({
          approvalId: 'approval',
          planHash: 'draft',
          snapshotHash,
          summary: 'Rotate',
          targets: [],
          operations: [{ op: 'rotatePages', pages: [0], dir: 90 }],
        }),
      )
      expect(captured.drawings).toMatchObject([{ contents: 'Keep draft' }])
      await current.persisted!({
        documentEpoch: 'epoch',
        operationId: 'draft',
        requestFingerprint: 'f'.repeat(64),
        checkpointId: 'checkpoint',
        blobHash: 'b'.repeat(64),
        workingRevision: 2,
        savedRevision: 1,
        dirty: true,
      })
    })
    host.document.workingCopy!.sourceContentId = 'b'.repeat(64)
    await act(async () => {
      await expect(adapter.restoreWorkingCopy!()).resolves.toBeUndefined()
    })
  })

  it('rejects a manual content change that lands while the approval digest is pending', async () => {
    const plan = await adapter.proposeSave()
    const current = adapter
    let release!: () => void
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle)
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return digest(...args)
    })
    await act(async () => {
      const result = current.save({ ...plan, operations: [], approvalId: 'approval' })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      view.api!.applyOps([{ op: 'rotatePages', pages: [0], dir: 90 }])
      release()
      expect(await result).toMatchObject({ ok: false, warnings: [{ code: 'STALE_PLAN' }] })
    })
  })

  it('serializes an already-started manual image flip behind the approved save capture', async () => {
    const originalImage = 'AQID'
    await act(async () => {
      view.api!.applyOps([
        {
          op: 'addImageEdit',
          id: 'image',
          input: {
            kind: 'insertImage',
            pageIndex: 0,
            rect: [10, 10, 20, 20],
            image: originalImage,
            layer: 'aboveText',
          },
        },
      ])
    })
    await act(async () => {
      view.selectImage!('image', 20, 20)
    })
    let releaseImage!: () => void
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 1
        naturalHeight = 1
        onload?: () => void
        set src(_value: string) {
          releaseImage = () => this.onload?.()
        }
      },
    )
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) }),
      putImageData() {},
    } as never)
    const encoded = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,BAUG')
    const flip = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === '水平翻转',
    )!
    expect(flip).toBeDefined()
    await act(async () => {
      flip.click()
    })
    expect(releaseImage).toBeTypeOf('function')
    const plan = await adapter.proposeSave()
    const current = adapter
    let releaseDigest!: () => void
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle)
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        releaseDigest = resolve
      })
      return digest(...args)
    })
    await act(async () => {
      const result = host.runMutation(() =>
        current.save({ ...plan, operations: [], approvalId: 'approval' }),
      )
      await vi.waitFor(() => expect(releaseDigest).toBeTypeOf('function'))
      releaseImage()
      await vi.waitFor(() => expect(encoded).toHaveBeenCalled())
      releaseDigest()
      const captured = await requestOf(await result)
      expect(captured.imageEdits).toMatchObject([{ image: originalImage }])
      await host.runMutation(async () => {})
    })
    await act(async () => {
      const next = await adapter.proposeSave()
      const captured = await requestOf(
        await adapter.save({ ...next, operations: [], approvalId: 'approval' }),
      )
      expect(captured.imageEdits).toMatchObject([{ image: 'BAUG' }])
    })
  })

  it('blocks a different recovered source without discarding unsaved local edits', async () => {
    await act(async () => {
      view.api!.applyOps([
        {
          op: 'putTextEdit',
          id: 'manual',
          input: {
            pageIndex: 0,
            rect: [10, 10, 50, 24],
            oldText: 'Before',
            newText: 'Keep manual',
          },
        },
      ])
    })
    host.document.workingCopy!.sourceContentId = 'b'.repeat(64)
    await act(async () => {
      await expect(adapter.restoreWorkingCopy!()).rejects.toMatchObject({
        code: 'PDF_RECOVERY_LOCAL_CHANGES',
      })
    })
    host.document.workingCopy!.sourceContentId = 'a'.repeat(64)
    await act(async () => {
      const plan = await adapter.proposeSave()
      const captured = await requestOf(
        await adapter.save({ ...plan, operations: [], approvalId: 'approval' }),
      )
      expect(captured.textEdits?.[0]?.newText).toBe('Keep manual')
    })
  })

  it.each(['STALE_PLAN', 'failed checkpoint'])(
    'retains manual pending work when %s recovers the same source',
    async (reason) => {
      const proposed = await adapter.proposeSave()
      await act(async () => {
        view.api!.applyOps([
          {
            op: 'putTextEdit',
            id: 'manual',
            input: {
              pageIndex: 0,
              rect: [10, 10, 50, 24],
              oldText: 'Before',
              newText: 'Keep manual',
            },
          },
        ])
      })
      if (reason === 'STALE_PLAN') {
        const failed = await adapter.save({ ...proposed, operations: [], approvalId: 'approval' })
        expect(failed).toMatchObject({ ok: false, warnings: [{ code: 'STALE_PLAN' }] })
      } else {
        // The adapter applied/captured successfully but persistence did not acknowledge it.
        // No persisted callback is sent, exactly as on a rejected checkpoint upload.
        await act(async () => {
          const snapshotHash = await adapter.snapshot()
          expect(
            (
              await adapter.apply({
                approvalId: 'approval',
                planHash: 'mark',
                snapshotHash,
                summary: 'Mark',
                targets: [],
                operations: [{ op: 'rotatePages', pages: [0], dir: 90 }],
              })
            ).ok,
          ).toBe(true)
        })
      }
      await act(async () => {
        await adapter.restoreWorkingCopy!()
      })
      await act(async () => {
        const plan = await adapter.proposeSave()
        const captured = await requestOf(
          await adapter.save({ ...plan, operations: [], approvalId: 'approval' }),
        )
        expect(captured.textEdits).toEqual([
          { pageIndex: 0, rect: [10, 10, 50, 24], oldText: 'Before', newText: 'Keep manual' },
        ])
      })
    },
  )

  it('captures an Agent text edit from the reducer post-state before React rerenders', async () => {
    const current = adapter
    const snapshotHash = await current.snapshot()
    await act(async () => {
      const result = await current.apply({
        approvalId: 'approval',
        planHash: 'plan',
        snapshotHash,
        summary: 'Edit',
        targets: [],
        operations: [
          {
            op: 'putTextEdit',
            id: 'edit',
            input: {
              pageIndex: 0,
              rect: [10, 10, 50, 24],
              oldText: 'Before',
              newText: 'After',
            },
          },
        ],
      })
      const captured = await requestOf(result)
      expect(captured.textEdits).toEqual([
        { pageIndex: 0, rect: [10, 10, 50, 24], oldText: 'Before', newText: 'After' },
      ])
    })
  })
})
