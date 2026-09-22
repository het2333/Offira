import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('ships the Offira title and its own SVG browser icon', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')
  const icon = readFileSync(fileURLToPath(new URL('../public/offira-mark.svg', import.meta.url)), 'utf8')
  const shellIcon = readFileSync(fileURLToPath(new URL('../../../packages/nexusdesk-shell-ui/src/assets/offira-mark.svg', import.meta.url)), 'utf8')
  expect(html).toContain('<title>Offira</title>')
  expect(html).toContain('href="/offira-mark.svg"')
  expect(icon).toContain('<svg')
  expect(icon).toContain('viewBox="0 0 48 48"')
  expect(icon).toBe(shellIcon)
})
