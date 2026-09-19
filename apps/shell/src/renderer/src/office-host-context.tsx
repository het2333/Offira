import { createContext, useContext, type ReactNode } from 'react'

import type { OfficeHost } from '@nexusdesk/office-host'
import type { HomeApi } from '../../shared/home-api'
import type { IntegrationsApi } from '../../shared/integrations-api'
import type { TabsApi } from '../../shared/tabs-api'

export interface ShellPlatformServices {
  readonly home: HomeApi
  readonly tabs: Pick<
    TabsApi,
    'showMenu' | 'showNewMenu' | 'showAppMenu' | 'notifyChromePressed' | 'onChromePressed'
  >
  readonly integrations?: IntegrationsApi | undefined
}

interface OfficeHostContextValue {
  readonly host: OfficeHost
  readonly platform?: ShellPlatformServices | undefined
}

const OfficeHostContext = createContext<OfficeHostContextValue | null>(null)

export function OfficeHostProvider({
  host,
  platform,
  children,
}: {
  host: OfficeHost
  platform?: ShellPlatformServices | undefined
  children: ReactNode
}): React.JSX.Element {
  return (
    <OfficeHostContext.Provider value={{ host, platform }}>{children}</OfficeHostContext.Provider>
  )
}

function useOfficeHostContext(): OfficeHostContextValue {
  const value = useContext(OfficeHostContext)
  if (value === null) throw new Error('OfficeHostProvider is missing')
  return value
}

export function useOfficeHost(): OfficeHost {
  return useOfficeHostContext().host
}

export function useShellPlatform(): ShellPlatformServices {
  const platform = useOfficeHostContext().platform
  if (platform === undefined) throw new Error('OfficeHostProvider has no platform services')
  return platform
}
