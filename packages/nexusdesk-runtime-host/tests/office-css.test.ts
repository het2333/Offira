import { expect, test } from 'vitest'
import { scopeOfficeCss } from '../src/office-css'

test('scopes theme rules including nested supports but preserves keyframes', () => {
  const css = scopeOfficeCss('body{color:red}:root{--x:1}@supports (corner-shape:squircle){*,:before,:after{corner-shape:squircle}}@keyframes fade{from{opacity:0}to{opacity:1}}')
  expect(css).not.toMatch(/(?:^|})body\{/)
  expect(css).toContain('.native-harness-panel-host{color:red}')
  expect(css).toContain('.native-harness-panel-host *')
  expect(css).toContain('from{opacity:0}')
  expect(css).not.toContain('.native-harness-panel-host from')
})
