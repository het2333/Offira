import type { Editor } from '@tiptap/react'
import { BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID } from '@genoffice/docx-engine'

import type { McpEditorCommand } from '../../shared/ipc'
import { executeTool, markDocSeen } from '../ai/tools'
import { findNumId, type NumIds } from '../ai/protocol'
import { save, type FileActionContext } from '../file-actions'

export type DocsCommand = McpEditorCommand

export type DocsCommandResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string }

interface InsertContentInput {
  html: string
  afterBlockIndex?: number
}

interface ReplaceBlocksInput {
  startBlockIndex: number
  endBlockIndex: number
  html: string
}

interface ApplyOpsInput {
  ops: unknown[]
  dryRun?: boolean
}

function numIdsFor(ctx: FileActionContext): NumIds {
  const blocks = ctx.doc?.parsed.blocks ?? []
  const isBlank = ctx.doc?.isBlank === true
  return {
    bullet: findNumId(blocks, 'bullet') ?? (isBlank ? BLANK_BULLET_NUM_ID : null),
    ordered: findNumId(blocks, 'ordered') ?? (isBlank ? BLANK_ORDERED_NUM_ID : null),
  }
}

function clearAiChangedFlags(editor: Editor): void {
  const view = editor.view
  let tr = view.state.tr
  let touched = false
  view.state.doc.forEach((node, offset) => {
    if (node.attrs.aiChanged) {
      tr = tr.setNodeMarkup(offset, undefined, { ...node.attrs, aiChanged: false })
      touched = true
    }
  })
  if (!touched) return
  tr = tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  markDocSeen(editor)
}

function publicErrorText(output: string): string {
  return output.replaceAll('get_document_context', 'read_document')
}

function blockType(nodeType: string, level: unknown): string {
  if (nodeType === 'docHeading') return `h${Math.min(Math.max(Number(level) || 1, 1), 6)}`
  if (nodeType === 'docListItem') return 'li'
  if (nodeType === 'docTable') return 'table'
  return 'p'
}

function documentBlocks(editor: Editor): Array<{ index: number; type: string; text: string }> {
  const blocks: Array<{ index: number; type: string; text: string }> = []
  editor.state.doc.forEach((node, _offset, index) => {
    blocks.push({
      index,
      type: blockType(node.type.name, node.attrs.level),
      text: node.textContent,
    })
  })
  return blocks
}

async function execute(
  ctx: FileActionContext,
  command: DocsCommand,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const editor = ctx.editor
  if (!editor || !ctx.doc) throw new Error('the document is not ready')

  switch (command) {
    case 'insert_content': {
      const input = (payload ?? {}) as InsertContentInput
      if (typeof input.html !== 'string') throw new Error('insert_content requires "html"')
      if (input.afterBlockIndex !== undefined) {
        const last = editor.state.doc.childCount - 1
        if (!Number.isInteger(input.afterBlockIndex) || input.afterBlockIndex < -1) {
          throw new Error(`afterBlockIndex must be an integer >= -1 (got ${input.afterBlockIndex})`)
        }
        if (input.afterBlockIndex > last) {
          throw new Error(
            `afterBlockIndex ${input.afterBlockIndex} is out of range (valid: -1..${last}); ` +
              'call read_document for fresh block indexes',
          )
        }
      }
      const outcome = await executeTool(
        editor,
        { id: 'external', name: 'insert_content', input: { ...input } },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(publicErrorText(outcome.output))
      clearAiChangedFlags(editor)
      return { summary: outcome.summary, mutated: outcome.mutated }
    }

    case 'replace_blocks': {
      const input = (payload ?? {}) as ReplaceBlocksInput
      if (typeof input.html !== 'string') throw new Error('replace_blocks requires "html"')
      const outcome = await executeTool(
        editor,
        { id: 'external', name: 'replace_blocks', input: { ...input } },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(publicErrorText(outcome.output))
      clearAiChangedFlags(editor)
      return { summary: outcome.summary, mutated: outcome.mutated }
    }

    case 'apply_ops': {
      const input = (payload ?? {}) as ApplyOpsInput
      const outcome = await executeTool(
        editor,
        {
          id: 'external',
          name: 'apply_ops',
          input: { ops: input.ops, ...(input.dryRun === true ? { dryRun: true } : {}) },
        },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(publicErrorText(outcome.output))
      if (input.dryRun !== true) clearAiChangedFlags(editor)
      return { summary: outcome.summary, output: outcome.output, mutated: outcome.mutated }
    }

    case 'read_document': {
      const outcome = await executeTool(
        editor,
        { id: 'external', name: 'get_document_context', input: {} },
        numIdsFor(ctx),
      )
      if (outcome.isError) throw new Error(publicErrorText(outcome.output))
      return { text: outcome.output, blocks: documentBlocks(editor) }
    }

    case 'save_document': {
      const input = (payload ?? {}) as {
        path?: string
        overwrite?: boolean
        inPlace?: boolean
      }
      let reason = ''
      if (input.inPlace === true) {
        const ok = await save(ctx, false, true)
        if (!ok) throw new Error('the document could not be saved')
        return { saved: true }
      }
      if (typeof input.path !== 'string' || !input.path) {
        throw new Error('save_document requires an absolute "path"')
      }
      const ok = await save(ctx, false, true, undefined, {
        path: input.path,
        overwrite: input.overwrite === true,
        onError: (message) => (reason = message),
      })
      if (!ok) throw new Error(reason || 'the document could not be saved')
      return { saved: true, path: input.path }
    }
  }
}

/** Execute the stable Docs DSL without depending on MCP or NexusDesk frames. */
export async function executeDocsCommand(
  context: FileActionContext,
  command: DocsCommand,
  payload: unknown,
): Promise<DocsCommandResult> {
  try {
    return { ok: true, result: await execute(context, command, payload) }
  } catch (error: unknown) {
    return {
      ok: false,
      error: publicErrorText(error instanceof Error ? error.message : String(error)),
    }
  }
}
