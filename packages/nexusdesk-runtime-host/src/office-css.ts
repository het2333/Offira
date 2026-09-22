import postcss from 'postcss'

const root = '.native-harness-panel-host'
export function scopeOfficeCss(css: string): string {
  const ast = postcss.parse(css)
  ast.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
    rule.selectors = rule.selectors.map(selector => {
      if (/^(body|html|:root)(?=[\s.#[:]|$)/.test(selector)) {
        return selector.replace(/^(body|html|:root)/, root)
      }
      return `${root} ${selector}`
    })
  })
  return ast.toString()
}

/** Fixed official release adaptation; fail closed when the module structure changes. */
export function scopeOfficeModule(source: string): string {
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-theme"')) {
    let sheets = 0
    source = source.replace(/(var \w+_css_default = )("(?:[^"\\]|\\.)*");/g, (_match, declaration, value) => {
      sheets++
      return `${declaration}${JSON.stringify(scopeOfficeCss(JSON.parse(value)))};`
    })
    if (sheets !== 6) throw Error('Unsupported official theme CSS layout.')
    source = source.replaceAll('document.body.style', '(document.querySelector("[data-nexusdesk-theme-root]") ?? document.body).style')
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-layout"')) {
    const select = '(document.querySelector("[data-nexusdesk-theme-root]") ?? document.body)'
    for (const original of ['document.documentElement.style', 'document.documentElement.setAttribute(THEME_SOURCE_ATTRIBUTE,', 'document.documentElement.removeAttribute(THEME_SOURCE_ATTRIBUTE)', 'const body = document.body;']) {
      if (!source.includes(original)) throw Error('Unsupported official theme presenter layout.')
    }
    source = source.replaceAll('document.documentElement.style', `${select}.style`)
      .replaceAll('document.documentElement.setAttribute(THEME_SOURCE_ATTRIBUTE,', `${select}.setAttribute(THEME_SOURCE_ATTRIBUTE,`)
      .replaceAll('document.documentElement.removeAttribute(THEME_SOURCE_ATTRIBUTE)', `${select}.removeAttribute(THEME_SOURCE_ATTRIBUTE)`)
      .replaceAll('const body = document.body;', `const body = ${select};`)
  }
  return source
}
