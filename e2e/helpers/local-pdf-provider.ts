import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Only provider responses are scripted. The production runtime boots its real
 * profile, owns the agent loop, executes createPdfTools, and emits every IPC frame.
 */
export async function startLocalPdfProvider(directory: string) {
  const requests: {
    tools?: { function: { name: string } }[]
    messages: { role: string; content: unknown; tool_call_id?: string }[]
  }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const toolResults = body.messages.filter((message: { role: string }) => message.role === 'tool')
    const step = toolResults.length
    const calls = [
      {
        name: 'markup_pdf_text',
        arguments: JSON.stringify({ page: 1, text: 'NexusDesk', type: 'highlight' }),
      },
      { name: 'save_pdf', arguments: '{}' },
    ]
    const call = calls[step]
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const emit = (delta: unknown, finish_reason: string | null) =>
      response.write(
        `data: ${JSON.stringify({ id: `local-pdf-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      )
    emit(
      {
        role: 'assistant',
        ...(call
          ? { tool_calls: [{ index: 0, id: `pdf-tool-${step}`, type: 'function', function: call }] }
          : { content: 'PDF saved by the real Harness runtime.' }),
      },
      null,
    )
    emit({}, call ? 'tool_calls' : 'stop')
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local provider address')
  const patchPath = join(directory, 'local-provider.patch.json')
  // A test-only credential reference; never reads a developer's real API key.
  const previousKey = process.env.NEXUSDESK_PDF_TEST_KEY
  process.env.NEXUSDESK_PDF_TEST_KEY = 'local-fixture-only'
  await writeFile(
    patchPath,
    JSON.stringify([
      {
        id: 'llm-deepseek',
        config: {
          protocol: 'chat-completions',
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: 'NEXUSDESK_PDF_TEST_KEY',
          thinking: 'disabled',
          reasoningEffort: 'off',
        },
      },
      { id: 'session-title-llm', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
    ]),
  )
  return {
    requests,
    runtimeCommand: {
      entry: resolve('packages/nexusdesk-runtime-host/lib/index.mjs'),
      args: [
        process.cwd(),
        resolve('packages/nexusdesk-runtime-host/profile'),
        'runtime',
        patchPath,
      ],
    },
    async close() {
      if (previousKey === undefined) delete process.env.NEXUSDESK_PDF_TEST_KEY
      else process.env.NEXUSDESK_PDF_TEST_KEY = previousKey
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
