import { createContext, createElement, useContext, type ReactNode } from 'react'

import type { ProductConfig } from '@nexusdesk/office-host'

export const GENOFFICE_PRODUCT_CONFIG: ProductConfig = {
  id: 'genoffice',
  name: 'GenOffice',
  editors: ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'],
  features: { mcp: true, cloudProjects: true, account: true, integrations: true },
}

export const NEXUSDESK_PRODUCT_CONFIG: ProductConfig = {
  id: 'nexusdesk',
  name: 'NexusDesk',
  editors: ['docs', 'sheets', 'slides'],
  features: { mcp: false, cloudProjects: false, account: false, integrations: false },
}

const ProductConfigContext = createContext<ProductConfig>(GENOFFICE_PRODUCT_CONFIG)

export function ProductConfigProvider({
  product,
  children,
}: {
  product: ProductConfig
  children: ReactNode
}): React.ReactElement {
  return createElement(ProductConfigContext.Provider, { value: product }, children)
}

export function useProductConfig(): ProductConfig {
  return useContext(ProductConfigContext)
}
