import { describe, expect, test } from 'vitest'

import { nativeHarnessEnabled } from '../src/renderer/native-harness'

describe('nativeHarnessEnabled', () => {
  test('uses the official panel by default in local Web only', () => {
    expect(nativeHarnessEnabled('')).toBe(false)
    expect(nativeHarnessEnabled('?host=local-web')).toBe(true)
    expect(nativeHarnessEnabled('?nativeHarness=0')).toBe(false)
  })

  test('keeps the explicit native opt-in for diagnostics', () => {
    expect(nativeHarnessEnabled('?host=local-web&nativeHarness=1')).toBe(true)
    expect(nativeHarnessEnabled('?nativeHarness=true')).toBe(false)
  })
})
