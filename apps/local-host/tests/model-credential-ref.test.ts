import { expect, it } from 'vitest'
import { prepareLegacyProviderEnvironment } from '../src/model-credential-ref'

it('preserves app-specific legacy keys over inherited keys while leaving non-key settings available', () => {
  const inherited: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'inherited-dummy', OTHER: 'kept' }
  const legacy = prepareLegacyProviderEnvironment({
    DEEPSEEK_API_KEY: 'app-dummy',
    OPENAI_BASE_URL: 'https://example.test/v1',
  }, inherited)
  expect(legacy).toEqual({ DEEPSEEK_API_KEY: 'app-dummy' })
  expect(inherited.DEEPSEEK_API_KEY).toBeUndefined()
  expect(inherited.OPENAI_BASE_URL).toBe('https://example.test/v1')
  expect(inherited.OTHER).toBe('kept')
})
