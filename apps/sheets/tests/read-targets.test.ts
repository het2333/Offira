import { expect, test } from 'vitest'

import { expandReadTargets } from '../src/renderer/agent/read-targets'

test('expands and deduplicates selected cells', () => {
  expect(expandReadTargets(['C1:C3', 'C2'])).toEqual(['C1', 'C2', 'C3'])
})

test('rejects unbounded or oversized targets before allocation', () => {
  expect(() => expandReadTargets(['C:C'])).toThrow()
  expect(() => expandReadTargets(['A1:XFD1048576'])).toThrow()
  expect(() => expandReadTargets(['A0'])).toThrow()
})
