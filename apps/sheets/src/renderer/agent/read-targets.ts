const MAX_EXCEL_COLUMN = 16_384
const MAX_EXCEL_ROW = 1_048_576

interface CellPosition {
  column: number
  row: number
}

function parseCell(address: string): CellPosition {
  const match = /^([A-Za-z]+)([1-9]\d*)$/.exec(address)
  if (!match) throw new Error(`invalid bounded A1 cell or range: ${address}`)

  let column = 0
  for (const character of match[1]!.toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64
  }
  const row = Number(match[2])
  if (column > MAX_EXCEL_COLUMN || row > MAX_EXCEL_ROW) {
    throw new Error(`cell is outside Excel worksheet bounds: ${address}`)
  }
  return { column, row }
}

function columnName(column: number): string {
  let value = column
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

export function expandReadTargets(addresses: readonly string[], maxCells = 10_000): string[] {
  if (!Number.isSafeInteger(maxCells) || maxCells < 1) {
    throw new Error('maxCells must be a positive integer')
  }

  const ranges: Array<{ start: CellPosition; end: CellPosition }> = []
  let requestedCells = 0
  for (const address of addresses) {
    const parts = address.split(':')
    if (parts.length > 2 || parts.some((part) => part.length === 0)) {
      throw new Error(`invalid bounded A1 cell or range: ${address}`)
    }
    const first = parseCell(parts[0]!)
    const second = parts.length === 2 ? parseCell(parts[1]!) : first
    const start = {
      row: Math.min(first.row, second.row),
      column: Math.min(first.column, second.column),
    }
    const end = {
      row: Math.max(first.row, second.row),
      column: Math.max(first.column, second.column),
    }
    requestedCells += (end.row - start.row + 1) * (end.column - start.column + 1)
    if (requestedCells > maxCells) {
      throw new Error(`read targets exceed the ${String(maxCells)} cell limit`)
    }
    ranges.push({ start, end })
  }

  const result: string[] = []
  const seen = new Set<string>()
  for (const { start, end } of ranges) {
    for (let row = start.row; row <= end.row; row += 1) {
      for (let column = start.column; column <= end.column; column += 1) {
        const address = `${columnName(column)}${String(row)}`
        if (seen.has(address)) continue
        seen.add(address)
        result.push(address)
      }
    }
  }
  return result
}
