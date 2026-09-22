import { useEffect, useState } from 'react'
import { Home } from './Home'
import { Onboarding } from './Onboarding'
import { StarPromptCard } from './StarPromptCard'
import { TabBar } from './TabBar'
import { EditorFrame } from './EditorFrame'
import { useOfficeHost, useShellPlatform } from './office-host-context'
import type { ProductConfig } from '@nexusdesk/office-host'
import { GENOFFICE_PRODUCT_CONFIG, ProductConfigProvider, useProductConfig } from './product-config'

interface AppFrameProps {
  /** resolved before first paint (main.tsx) so home never flashes under the overlay */
  initialOnboardingSeen?: boolean | undefined
  product?: ProductConfig | undefined
}

function AppFrameContent({ initialOnboardingSeen = true }: AppFrameProps) {
  const host = useOfficeHost()
  const product = useProductConfig()
  const { home: homeApi } = useShellPlatform()
  const [homeActive, setHomeActive] = useState<boolean | null>(null)
  const [bootstrap, setBootstrap] = useState<Awaited<ReturnType<typeof host.bootstrap>>>()
  const [showOnboarding, setShowOnboarding] = useState(product.id === 'genoffice' && !initialOnboardingSeen)
  const [starPromptDocOpens, setStarPromptDocOpens] = useState<number | null>(null)

  useEffect(() => {
    const applyTabs = (tabs: Awaited<ReturnType<typeof host.tabs.list>>) => {
      const active = tabs.find((tab) => tab.active)
      setHomeActive(!active || active.kind === 'home')
      setBootstrap((current) => (current === undefined ? current : { ...current, tabs }))
    }
    void host.bootstrap().then((next) => {
      setBootstrap(next)
      applyTabs(next.tabs)
    })
    return host.tabs.onChanged(applyTabs)
  }, [host])

  // The "star us" invitation is decided (and counted as shown) by the main
  // process; ask once per session, and never while onboarding is up — a
  // first-run user can't have met the value threshold anyway.
  useEffect(() => {
    if (product.id !== 'genoffice' || showOnboarding) return
    let alive = true
    void homeApi.starPromptShouldShow?.().then((result) => {
      if (alive && result.show) setStarPromptDocOpens(result.docOpens)
    })
    return () => {
      alive = false
    }
  }, [product.id, showOnboarding])

  const finishOnboarding = async (): Promise<boolean> => {
    try {
      const settings = await host.settings.update({ onboardingSeen: true })
      if (!settings.onboardingSeen) return false
      setShowOnboarding(false)
      return true
    } catch {
      return false
    }
  }

  return (
    <div className="app-frame">
      <TabBar />
      {/* docs/sheets tabs render as WebContentsView children of this window, positioned
       * by the main process to cover this area — only Home paints its own content here. */}
      <div
        className="app-frame-content"
        style={{ visibility: homeActive === true ? 'visible' : 'hidden' }}
      >
        <Home />
      </div>
      <EditorFrame bootstrap={bootstrap} />
      {/* editor WebContentsViews paint above ALL shell DOM, so the overlay only
       * renders while the home tab is active — it comes back when home does */}
      {showOnboarding && homeActive && <Onboarding onDone={finishOnboarding} />}
      {starPromptDocOpens !== null && !showOnboarding && homeActive && (
        <StarPromptCard docOpens={starPromptDocOpens} onClose={() => setStarPromptDocOpens(null)} />
      )}
    </div>
  )
}

export function AppFrame({
  initialOnboardingSeen = true,
  product = GENOFFICE_PRODUCT_CONFIG,
}: AppFrameProps): React.JSX.Element {
  return (
    <ProductConfigProvider product={product}>
      <AppFrameContent initialOnboardingSeen={initialOnboardingSeen} />
    </ProductConfigProvider>
  )
}
