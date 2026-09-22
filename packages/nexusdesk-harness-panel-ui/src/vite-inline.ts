import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'

/** Browser build boundary: Node loading and executable YAML are not Office capabilities. */
export function inlineHarnessBuild(): Plugin {
  return {
    name: 'nexusdesk-inline-harness', enforce: 'pre',
    config() {
      return {
        define: { 'process.versions.node': '"0.0.0"', 'process.execArgv': '[]', 'process.env.CORDIS_SHARED': 'undefined' },
        resolve: { alias: [{ find: /^node:module$/, replacement: fileURLToPath(new URL('./browser-node-module.ts', import.meta.url)) }] },
      }
    },
    transform(code, id) {
      if (id.endsWith('/@deepseek-ai/dsh-client-ui-primitives/lib/index.js')) {
        const targets = code.match(/document\.body(?=\))/g)
        if (targets?.length !== 5) throw new Error('Unsupported official portal layout.')
        return code.replace(/document\.body(?=\))/g, '(document.querySelector("[data-nexusdesk-office-portal]") ?? document.body)')
      }
      if (id.endsWith('/@deepseek-ai/cordis-plugin-loader/lib/index.js')) {
        const evaluator = /const evaluate = new Function\("ctx", "expr", `[\s\S]*?`\);/
        if (!evaluator.test(code)) throw new Error('Unsupported official loader version: CSP adapter must be reviewed.')
        return code.replace(evaluator, 'const evaluate = () => { throw new Error("Executable loader configuration is unavailable in Office Web.") };')
      }
      if (id.endsWith('/@deepseek-ai/dsh-client-web/lib/base.css')) {
        return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|})\s*([^{}]+)\{/g, (_whole, boundary, selectors) => {
          const scoped = String(selectors).split(',').map((selector) => {
            const s = selector.trim()
            if (['html', 'body', '#root'].includes(s)) return '.native-harness-panel-host'
            return `.native-harness-panel-host ${s}`
          }).join(',')
          return `${boundary}${scoped}{`
        })
      }
      return undefined
    },
  }
}
