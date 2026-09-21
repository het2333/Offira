import { describe, expect, test } from 'vitest'

import { nativeHarnessEnabled } from '../src/renderer/native-harness'

describe('nativeHarnessEnabled', () => {
  test('keeps the existing Sheets chat as the default', () => {
    expect(nativeHarnessEnabled('')).toBe(false)
    expect(nativeHarnessEnabled('?host=local-web')).toBe(false)
    expect(nativeHarnessEnabled('?nativeHarness=0')).toBe(false)
  })

  test('enables the native panel only for the exact opt-in value', () => {
    expect(nativeHarnessEnabled('?host=local-web&nativeHarness=1')).toBe(true)
    expect(nativeHarnessEnabled('?nativeHarness=true')).toBe(false)
  })
})
