import { SlidesDocumentService } from './slides-document-service'

interface Request {
  id: number
  action: string
  payload: unknown
}

interface InitPayload {
  bytes: Uint8Array
  title: string
}

let service: SlidesDocumentService | undefined

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function fitWidth(payload: unknown): number {
  const value = object(payload).fitWidthPx
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('fitWidthPx must be a positive finite number.')
  }
  return value
}

async function execute(request: Request): Promise<unknown> {
  if (request.action === 'init') {
    const payload = object(request.payload) as Partial<InitPayload>
    if (!(payload.bytes instanceof Uint8Array) || typeof payload.title !== 'string') {
      throw new Error('Slides service initialization requires presentation bytes and a title.')
    }
    service = await SlidesDocumentService.open(payload.bytes, payload.title, 960)
    return { ok: true }
  }
  if (service === undefined) throw new Error('Slides service is not initialized.')
  if (request.action === 'open') return service.setFitWidth(fitWidth(request.payload))
  if (request.action === 'edit-text') return service.editText(request.payload as never)
  if (request.action === 'apply-txn') return service.applyTransaction(request.payload as never)
  if (request.action === 'read-presentation') return service.readPresentation()
  if (request.action === 'content-state') return service.contentState()
  if (request.action === 'ui') {
    const payload = object(request.payload)
    if (typeof payload.action !== 'string') throw new Error('Slides UI action requires an action name.')
    return service.executeUi(payload.action, payload.payload)
  }
  if (request.action === 'undo') return service.undo()
  if (request.action === 'redo') return service.redo()
  if (request.action === 'render-slides') return service.renderSlides()
  if (request.action === 'is-dirty') return service.isDirty()
  if (request.action === 'serialize') return { bytes: await service.serializeBytes(), slides: service.renderSlides() }
  if (request.action === 'commit-saved') {
    service.markSaved()
    return { ok: true }
  }
  if (request.action === 'replace') {
    const payload = object(request.payload) as Partial<InitPayload>
    if (!(payload.bytes instanceof Uint8Array) || typeof payload.title !== 'string') {
      throw new Error('Slides replacement requires presentation bytes and a title.')
    }
    service = await SlidesDocumentService.open(payload.bytes, payload.title, fitWidth(payload))
    return service.openResult()
  }
  if (request.action === 'close') return { ok: true }
  throw new Error(`Unsupported Slides service action: ${request.action}`)
}

process.on('message', (message: unknown) => {
  const request = message as Partial<Request>
  if (typeof request.id !== 'number' || typeof request.action !== 'string') return
  void execute({ id: request.id, action: request.action, payload: request.payload })
    .then((value) => process.send?.({ id: request.id, ok: true, value }))
    .catch((error: unknown) => process.send?.({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Slides service request failed.',
    }))
})
