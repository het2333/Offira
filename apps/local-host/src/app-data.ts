import { homedir } from 'node:os'
import { join } from 'node:path'

export function nexusdeskAppDataDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (platform === 'darwin')
    return join(homeDirectory, 'Library', 'Application Support', 'NexusDesk')
  if (platform === 'win32') {
    return join(environment.APPDATA ?? join(homeDirectory, 'AppData', 'Roaming'), 'NexusDesk')
  }
  return join(environment.XDG_CONFIG_HOME ?? join(homeDirectory, '.config'), 'NexusDesk')
}
