import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface RuntimeCommand { entry: string; args?: string[] }

function completion(response: import('node:http').ServerResponse, delta: unknown, finishReason: string): void {
  response.write(`data: ${JSON.stringify({
    id: 'e2e-completion', object: 'chat.completion.chunk', created: 0, model: 'smoke-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

/** A deterministic, local-only model endpoint for exercising the production runtime. */
export async function createProductionRuntimeProvider(): Promise<{ runtimeCommand: RuntimeCommand; close(): Promise<void> }> {
  let turnStep = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: Array<{ function?: { name?: string } }> }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    if (!body.tools?.some((tool) => tool.function?.name === 'read_presentation')) {
      completion(response, { role: 'assistant', content: 'Smoke title' }, 'stop')
      return
    }
    const calls = [
      { id: 'e2e-read-call', name: 'read_presentation', arguments: {} },
      {
        id: 'e2e-apply-call', name: 'apply_presentation_operations',
        arguments: { operations: [{ op: 'setText', target: { slide: 0, el: 'sp_0' }, paragraphs: [{ runs: [{ text: 'Edited by production runtime' }] }] }] },
      },
      { id: 'e2e-save-call', name: 'save_presentation', arguments: {} },
    ]
    const call = calls[turnStep]
    turnStep = (turnStep + 1) % 4
    if (call === undefined) {
      completion(response, { role: 'assistant', content: 'Presentation saved.' }, 'stop')
      return
    }
    completion(response, {
      role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
    }, 'tool_calls')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not allocate a local production runtime provider port.')
  const directory = await mkdtemp(join(tmpdir(), 'nexusdesk-production-runtime-provider-'))
  const patchFile = join(directory, 'provider.patch.yml')
  await writeFile(patchFile, `- id: llm-pi-ai
  config:
    providers:
      smoke:
        displayName: Smoke
        api: openai-completions
        baseURL: http://127.0.0.1:${String(address.port)}/v1
        apiKeyEnv: NEXUSD_SMOKE_API_KEY
        models:
          - id: smoke-model
            name: Smoke model
            contextWindow: 32768
            maxTokens: 1024
`)
  const repositoryRoot = process.cwd()
  return {
    runtimeCommand: {
      entry: resolve(repositoryRoot, 'packages/nexusdesk-runtime-host/lib/index.mjs'),
      args: [repositoryRoot, resolve(repositoryRoot, 'packages/nexusdesk-runtime-host/profile'), 'runtime', patchFile],
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}
