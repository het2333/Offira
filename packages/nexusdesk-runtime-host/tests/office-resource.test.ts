import { describe, expect, it } from 'vitest'
import { createOfficeIndexHtml } from '../src/office-resource'

describe('Office-only native frontend bootstrap', () => {
  it('installs the document capability before the real official frontend and hides fallback workbench', () => {
    const html = createOfficeIndexHtml('<html><head><script type="module" crossorigin src="./assets/entry.js"></script><link rel="stylesheet" href="./assets/style.css"></head><body><div id="root"></div></body></html>', [])
    expect(html).toContain("installOfficePanelBinding")
    expect(html).toContain('window.frameElement?.__NEXUSD_OFFICE__')
    expect(html).toContain('await import("/harness/assets/entry.js")')
    expect(html).not.toContain('src="./assets/entry.js"')
    expect(html).toContain('/harness/assets/style.css')
    expect(html).toContain('#root:not(:has([data-nexusdesk-office-panel]))')
  })
  it('rejects an unknown official entry layout instead of booting the full workbench', () => {
    expect(() => createOfficeIndexHtml('<html><head></head><body></body></html>', [])).toThrow()
  })
})
