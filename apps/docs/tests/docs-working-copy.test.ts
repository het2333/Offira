import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createDocsDocumentDriver } from '../../local-host/src/docs-document-driver'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { parseDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { buildDocBytes, save, type FileActionContext } from '../src/renderer/file-actions'
import { createDocsSaveAdapter, docsSaveSnapshot } from '../src/renderer/agent/docs-save-adapter'
import { createDocsBrowserAgentBridge } from '../src/renderer/agent/browser-agent-api'

const editors: Editor[] = []
// JSDOM lacks the browser CSS API used when the saved document rebuilds its stylesheet.
;(globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value }
const directories: string[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const original = await buildDocx({ bodyXml: '<w:p><w:r><w:t>Original.</w:t></w:r></w:p>' })
  const parsed = await parseDocx(original)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editors.push(editor)
  const ctx = {
    editor,
    doc: { parsed, filePath: 'nexusdesk://document-1', fileName: 'Report.docx', hash: 'original' },
    dirtyRef: { current: true },
    inkAnnotations: [],
    sectionsDirty: [],
    pgNumDirtySections: [],
    sections: [],
    sectionHfEdits: {},
    styleUpserts: {},
    hfVariantsDirty: [],
    hfVariants: {},
    header: { text: 'Manual header' },
    headerDirty: true,
  } as unknown as FileActionContext
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: 'docParagraph',
    content: [{ type: 'text', text: 'Manual edit.' }],
  })
  return { ctx, editor, original }
}

async function captureFunction() {
  // The first RED is the missing public capture entry point, before any implementation exists.
  const modules = import.meta.glob('../src/renderer/agent/docs-working-copy.ts')
  const module = (await modules['../src/renderer/agent/docs-working-copy.ts']?.()) ?? {}
  expect(module).toHaveProperty('captureDocsWorkingCopy', expect.any(Function))
  return (module as typeof import('../src/renderer/agent/docs-working-copy')).captureDocsWorkingCopy
}

it.each([false, true])(
  'saves recovered complete DOCX to the original with later manual input=%s exactly once',
  async (extraManual) => {
    const capture = await captureFunction()
    const { ctx, editor, original } = await fixture()
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'docParagraph',
      content: [{ type: 'text', text: 'Agent edit.' }],
    })
    const directory = await mkdtemp(join(tmpdir(), 'docs-working-copy-save-'))
    directories.push(directory)
    const path = join(directory, 'Report.docx')
    await writeFile(path, original)
    const driver = await createDocsDocumentDriver(path, {
      workingCopyRoot: join(directory, 'recovery'),
    })
    const port = driver.workingCopy!
    const source = await port.acquireSource()
    const commit = async (bytes: Uint8Array, operationId: string) => {
      const status = await port.store.getStatus()
      const validated = await port.materialize({
        sourceContentId: source.sourceContentId,
        payloadKind: 'docx-bytes',
        parts: new Map([['document', bytes]]),
      })
      return port.store.commitCheckpoint({
        documentEpoch: status.documentEpoch,
        expectedSavedRevision: status.savedRevision,
        expectedWorkingRevision: status.workingRevision,
        operationId,
        planHash: 'approved-plan',
        requestFingerprint: createHash('sha256').update(operationId).digest('hex'),
        payloadHash: createHash('sha256').update(validated).digest('hex'),
        payloadByteLength: validated.length,
        bytes: validated,
        result: { ok: true, summary: 'Committed', warnings: [] },
      })
    }
    const checkpoint = await capture(() => ctx)
    await commit(new Uint8Array(await checkpoint.parts.get('document')!.arrayBuffer()), 'apply-1')
    expect(Array.from(await readFile(path))).toEqual(Array.from(original))
    const recovered = await parseDocx(await port.store.readWorkingBytes())
    ctx.doc = { ...ctx.doc!, parsed: recovered, hash: 'recovered-checkpoint' }
    editor.commands.setContent(blocksToPmDoc(recovered.blocks) as never)
    ctx.header = { text: recovered.headerText!, paras: recovered.headerParas ?? undefined }
    ctx.headerDirty = false
    if (extraManual)
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'docParagraph',
        content: [{ type: 'text', text: 'Extra manual edit.' }],
      })
    // React setters are the only UI boundary replaced here; editor, serializer and durable store are real.
    const live = new Proxy(ctx, {
      get(target, key, receiver) {
        if (typeof key === 'string' && key.startsWith('set'))
          return (value: any) => {
            const field = key[3]!.toLowerCase() + key.slice(4)
            const state = target as unknown as Record<string, any>
            state[field] = typeof value === 'function' ? value(state[field]) : value
          }
        return Reflect.get(target, key, receiver)
      },
    })
    Object.assign(ctx, {
      saveInFlightRef: { current: false },
      saveIncompleteRef: { current: false },
      saveContentSnapshot: () => docsSaveSnapshot(live),
      captureSaveBytes: async () =>
        new Uint8Array(await (await capture(() => live)).parts.get('document')!.arrayBuffer()),
    })
    window.desktop = {
      saveDocx: async (_path: string, data: ArrayBuffer) => {
        const prepared = await commit(new Uint8Array(data), 'prepare-save-1')
        await port.store.promoteWorkingCopy({
          documentEpoch: prepared.documentEpoch,
          expectedSavedRevision: prepared.savedRevision,
          expectedWorkingRevision: prepared.workingRevision,
          checkpointId: prepared.checkpointId,
          operationId: 'save-1',
          requestFingerprint: 'c'.repeat(64),
          planHash: 'save-plan',
          result: { ok: true, summary: 'Saved', warnings: [] },
        })
        return { ok: true }
      },
    } as never
    await expect(save(live, false, true)).resolves.toBe(true)
    const zip = await JSZip.loadAsync(await readFile(path))
    const body = await zip.file('word/document.xml')!.async('string')
    expect(body.match(/Agent edit\./g)).toHaveLength(1)
    expect(body.match(/Manual edit\./g)).toHaveLength(1)
    expect(body.match(/Extra manual edit\./g) ?? []).toHaveLength(extraManual ? 1 : 0)
    expect(await zip.file('word/header1.xml')!.async('string')).toContain('Manual header')
    expect(await port.store.getStatus()).toMatchObject({ dirty: false, savedRevision: 2 })
    expect(ctx.dirtyRef.current, (ctx as any).status).toBe(false)
  },
)

it('serializes manual body and header plus a real Agent mutation into a complete DOCX', async () => {
  const capture = await captureFunction()
  const { ctx, editor } = await fixture()
  const adapter = createDocsSaveAdapter({
    context: () => ctx,
    document: () => ({
      documentId: 'document-1' as never,
      clientId: 'client-1' as never,
      revision: 1 as never,
      title: 'Report.docx',
      attached: true,
    }),
    consumeApproval: () => true,
  })
  const plan = await adapter.propose({
    documentId: 'document-1',
    clientId: 'client-1',
    revision: 1,
    operationId: 'op-1',
    sessionId: 'session-1',
    editorType: 'docs',
    command: 'apply_ops',
    arguments: { ops: [{ op: 'findReplace', find: 'Original.', replace: 'Agent edit.' }] },
  } as never)
  expect((await adapter.apply({ ...plan, approvalId: 'approved' })).ok).toBe(true)
  const payload = await capture(() => ctx)
  const zip = await JSZip.loadAsync(await payload.parts.get('document')!.arrayBuffer())
  const body = await zip.file('word/document.xml')!.async('string')
  expect(body).toContain('Agent edit.')
  expect(body).toContain('Manual edit.')
  expect(await zip.file('word/header1.xml')!.async('string')).toContain('Manual header')
  expect(editor.getText()).toContain('Agent edit.')
  expect(ctx.dirtyRef.current).toBe(true)
})

it('rejects a non-body change while the serializer is suspended and preserves dirty state', async () => {
  const capture = await captureFunction()
  const { ctx } = await fixture()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const saving = capture(() => ctx, {
    serialize: async (current) => {
      entered()
      await gate
      return buildDocBytes(current)
    },
  })
  await started
  ctx.header = { text: 'A different header' }
  release()
  await expect(saving).rejects.toMatchObject({ code: 'STALE_CONTENT' })
  expect(ctx.dirtyRef.current).toBe(true)
})

it('manual Save uses the complete capture guard before crossing the original-file write boundary', async () => {
  const { ctx } = await fixture()
  let entered = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const bytes = await buildDocBytes(ctx)
  let writes = 0
  window.desktop = {
    saveDocx: async () => {
      writes++
      return { ok: true }
    },
  } as never
  Object.assign(ctx, {
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    setStatus() {},
    saveContentSnapshot: () => docsSaveSnapshot(ctx),
    captureSaveBytes: async () => {
      entered = true
      await gate
      return bytes
    },
  })
  const saving = save(ctx, false, true)
  await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 })
  ctx.header = { text: 'Changed while manual Save captured' }
  release()
  await expect(saving).resolves.toBe(false)
  expect(writes).toBe(0)
  expect(ctx.dirtyRef.current).toBe(true)
})

it('keeps a completed Web Save successful when the editor cannot rebase its saved document', async () => {
  const { ctx } = await fixture()
  const statuses: string[] = []
  let writes = 0
  window.desktop = {
    saveDocx: async () => {
      writes++
      return { ok: true }
    },
  } as never
  Object.assign(ctx, {
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    setStatus: (status: string) => statuses.push(status),
    setDocCss: () => {
      throw Error('editor reload failed')
    },
    saveContentSnapshot: () => docsSaveSnapshot(ctx),
    captureSaveBytes: () => buildDocBytes(ctx),
  })
  await expect(save(ctx, false, true)).resolves.toBe(true)
  expect(writes).toBe(1)
  expect(statuses.at(-1)).toMatch(/saved.*reload|sav.*completed.*reload/i)
  expect(ctx.dirtyRef.current).toBe(true)
})

it('does not deliver apply success before checkpoint and coalesces duplicate mutation requests', async () => {
  const capture = await captureFunction()
  const { ctx, editor } = await fixture()
  const sent: any[] = []
  const listeners = new Set<(frame: any) => void>()
  const client = {
    state: 'ready',
    clientId: 'client-1',
    send: (frame: any) => sent.push(frame),
    onFrame: (fn: any) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    onState: () => () => {},
    request() {},
  }
  let release!: () => void
  let checkpointBytes: ArrayBuffer | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const state = {
    documentEpoch: 'epoch-1',
    workingRevision: 1,
    savedRevision: 1,
    sourceContentId: 'a'.repeat(64),
    checkpointId: null,
    dirty: false,
    recoveryState: 'ready',
    contentUrl: '/source',
  } as const
  const bridge = createDocsBrowserAgentBridge({
    client: client as never,
    documentId: 'document-1' as never,
    revision: 1 as never,
    workingCopy: {
      state: () => state,
      capture: () => capture(() => ctx),
      persistence: {
        lookup: async () => ({ state: 'not-found' }),
        checkpoint: async (frame, _result, payload) => {
          checkpointBytes = await payload.parts.get('document')!.arrayBuffer()
          await gate
          return {
            documentEpoch: 'epoch-1',
            operationId: frame.target.operationId,
            requestFingerprint: 'b'.repeat(64),
            checkpointId: 'checkpoint-1',
            blobHash: 'c'.repeat(64),
            workingRevision: 2,
            savedRevision: 1,
            dirty: true,
          }
        },
      },
    },
  })
  bridge.attachEditor(
    createDocsSaveAdapter({
      context: () => ctx,
      document: () => ({
        documentId: 'document-1' as never,
        clientId: 'client-1' as never,
        revision: 1 as never,
        title: 'Report.docx',
        attached: true,
      }),
      consumeApproval: (id, hash) => bridge.consumeApproval(id, hash),
    }),
  )
  const emit = (frame: any) => listeners.forEach((fn) => fn(frame))
  bridge.setHydrated(state)
  const registration = sent.find((frame) => frame.type === 'editor:register')
  emit({
    type: 'editor:registered',
    id: registration.id,
    documentId: 'document-1',
    documentEpoch: 'epoch-1',
    sourceContentId: state.sourceContentId,
    revision: 1,
  })
  const target = {
    documentId: 'document-1',
    clientId: 'client-1',
    editorType: 'docs',
    revision: 1,
    sessionId: 'session-1',
    operationId: 'op-1',
  }
  const args = { ops: [{ op: 'findReplace', find: 'Original.', replace: 'Agent edit.' }] }
  emit({ type: 'editor:request', id: 'propose', target, command: 'propose_ops', arguments: args })
  await vi.waitFor(() => expect(sent.some((frame) => frame.id === 'propose')).toBe(true), {
    timeout: 10_000,
  })
  const planHash = sent.find((frame) => frame.id === 'propose').result.data.planHash
  const request = {
    type: 'editor:request',
    id: 'apply',
    target,
    command: 'apply_ops',
    arguments: args,
    approval: { id: 'approval-1', planHash },
  }
  emit(request)
  emit({ ...request, id: 'duplicate' })
  await vi.waitFor(() => expect(checkpointBytes).toBeDefined(), { timeout: 10_000 })
  expect(sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(1)
  expect(editor.getText().match(/Agent edit\./g)).toHaveLength(1)
  release()
  await vi.waitFor(() =>
    expect(sent.filter((frame) => frame.type === 'editor:result')).toHaveLength(3),
  )
  expect(sent.find((frame) => frame.id === 'apply')).toMatchObject({
    result: { ok: true },
    persistence: { checkpointId: 'checkpoint-1' },
  })
  const zip = await JSZip.loadAsync(checkpointBytes!)
  expect(await zip.file('word/document.xml')!.async('string')).toContain('Manual edit.')
  expect(await zip.file('word/header1.xml')!.async('string')).toContain('Manual header')
  bridge.dispose()
})
