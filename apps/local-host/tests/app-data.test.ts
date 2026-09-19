import { describe, expect, it } from 'vitest'

import { nexusdeskAppDataDirectory } from '../src/app-data'

describe('nexusdeskAppDataDirectory', () => {
  it('uses the platform application-data root without depending on the current directory', () => {
    expect(nexusdeskAppDataDirectory('darwin', {}, '/Users/example')).toBe(
      '/Users/example/Library/Application Support/NexusDesk',
    )
    expect(
      nexusdeskAppDataDirectory(
        'win32',
        { APPDATA: 'C:\\Users\\example\\AppData\\Roaming' },
        'C:\\Users\\example',
      ),
    ).toBe('C:\\Users\\example\\AppData\\Roaming/NexusDesk')
    expect(
      nexusdeskAppDataDirectory('linux', { XDG_CONFIG_HOME: '/config' }, '/home/example'),
    ).toBe('/config/NexusDesk')
  })
})
