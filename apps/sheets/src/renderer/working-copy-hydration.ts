/** Recovery must never acknowledge a partial native index or a replaced model. */
export async function readIndexedWorkingCopyRange<T extends { indexingComplete: boolean }>(
  read: () => Promise<T>,
  isCurrent: () => boolean,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 200
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isCurrent()) throw new Error('The recovering workbook was replaced.')
    const result = await read()
    if (!isCurrent()) throw new Error('The recovering workbook was replaced.')
    if (result.indexingComplete) return result
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 150))
  }
  throw new Error('Workbook indexing did not complete during recovery.')
}
