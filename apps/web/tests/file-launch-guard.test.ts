import { expect, it } from 'vitest'

import { fileLaunchMessage } from '../src/file-launch-guard'

it('explains direct file launch instead of rendering an empty root', () => {
  expect(fileLaunchMessage(new URL('file:///repo/apps/web/index.html'))).toMatch(
    /npm run start:web/i,
  )
  expect(fileLaunchMessage(new URL('http://127.0.0.1:4000/'))).toBeUndefined()
})
