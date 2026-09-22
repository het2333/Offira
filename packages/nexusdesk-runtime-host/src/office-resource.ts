import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { scopeOfficeModule } from './office-css'
import { bootInjections, type ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'

export interface OfficeResource { status: number; contentType: string; bodyBase64: string }

/** Official frontend entry with a fail-closed document capability installed before boot. */
export function createOfficeIndexHtml(source: string, injections: readonly IndexInjection[]): string {
  const entry = source.match(/<script\s+type="module"[^>]*src="(\.\/assets\/[^"<>]+\.js)"[^>]*><\/script>/)
  if (!entry?.[1]) throw new Error('Unsupported official frontend entry layout.')
  const script = `
<script type="module">
import { installOfficePanelBinding } from '/harness/binding.js';
const capability = window.frameElement?.__NEXUSD_OFFICE__;
const status = document.getElementById('office-status');
const fail = () => { status.hidden = false; status.textContent = '助手未能连接。请重新打开当前文档面板；不要重复提交未核实的修改。'; capability?.onError?.(); };
try {
  if (!capability?.binding || !capability?.rpc) throw new Error('Missing Office capability');
  window.__DSH_TRANSPORT__ = { rpc: capability.rpc };
  installOfficePanelBinding(capability.binding);
  let reported = false;
  const observer = new MutationObserver(() => {
    const ready = document.querySelector('[data-nexusdesk-office-panel="ready"]');
    const failed = document.querySelector('[data-nexusdesk-office-panel="failed"]');
    status.hidden = Boolean(ready);
    if (ready && !reported) { reported = true; capability.onReady?.(); }
    if (failed) fail();
  });
  observer.observe(document.getElementById('root'), { childList: true, subtree: true });
  await import(${JSON.stringify(entry[1].replace('./assets/', '/harness/assets/'))});
} catch { fail(); }
</script>`
  const html = source.replace(entry[0], '')
    .replaceAll('href="./', 'href="/harness/')
    .replace('<html lang="en">', '<html lang="zh-CN">')
    .replace('</head>', `<style>html,body,#root{height:100%;margin:0}#root:not(:has([data-nexusdesk-office-panel])){visibility:hidden}#office-status{position:absolute;inset:0;display:grid;place-items:center;padding:20px;text-align:center;font:14px system-ui;color:#666}#office-status[hidden]{display:none}</style></head>`)
    .replace('</body>', `<div id="office-status" role="status">正在连接文档助手…</div>${script}</body>`)
  return renderIndexInjections(html, injections)
}

export async function readOfficeResource(modules: Pick<ClientModuleRegistry, 'graph' | 'fetchBundle'>, url: string): Promise<OfficeResource> {
  if (url === '/harness/boot.json' || url === '/harness/loader.js') {
    const graph = modules.graph()
    if (!graph.entries.some((entry) => entry.id === '@nexusdesk/harness-office-panel-ui')) throw new Error('Office Client graph is missing its restricted root.')
    const rows = bootInjections(graph)
    const scripts = rows.filter((row) => row.kind === 'script')
    const body = url.endsWith('.js')
      ? scripts.map((row) => row.text).join('\n')
      : JSON.stringify(rows.map((row) => row.kind === 'script' ? { kind: 'script-src', placement: row.placement, src: '/harness/loader.js' } : row))
    return { status: 200, contentType: url.endsWith('.js') ? 'application/javascript' : 'application/json', bodyBase64: Buffer.from(body).toString('base64') }
  }
  if (url === '/harness/index.html') {
    const graph = modules.graph()
    if (!graph.entries.some((entry) => entry.id === '@nexusdesk/harness-office-panel-ui')) throw new Error('Office Client graph is missing its restricted root.')
    const require = createRequire(import.meta.url)
    const frontendRoot = dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json'))
    const html = createOfficeIndexHtml(await readFile(join(frontendRoot, 'dist/index.html'), 'utf8'), bootInjections(graph))
    return { status: 200, contentType: 'text/html; charset=utf-8', bodyBase64: Buffer.from(html).toString('base64') }
  }
  if (!url.startsWith('/plugins/') || url.length > 16384 || url.includes('.map')) throw new Error('Invalid Office resource URL.')
  const response = await modules.fetchBundle(new Request(new URL(url, 'http://office.invalid')))
  const contentType = response.headers.get('content-type') ?? 'application/javascript'
  const body = Buffer.from(await response.arrayBuffer())
  return { status: response.status, contentType, bodyBase64: (contentType.includes('javascript') ? Buffer.from(scopeOfficeModule(body.toString('utf8'))) : body).toString('base64') }
}
