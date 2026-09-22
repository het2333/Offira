import { useEffect, useState, type FormEvent } from 'react'
import type { ModelCredentialStatus } from './platform/home-api'
import { useShellPlatform } from './office-host-context'
import { useI18n } from './locale'

const PROVIDERS = [
  { label: 'DeepSeek', ref: 'DEEPSEEK_API_KEY' },
  { label: 'OpenAI', ref: 'OPENAI_API_KEY' },
  { label: 'Anthropic', ref: 'ANTHROPIC_API_KEY' },
  { label: 'OpenRouter', ref: 'OPENROUTER_API_KEY' },
  { label: 'Gemini', ref: 'GEMINI_API_KEY' },
] as const

const API_KEY_REF = /^[A-Z][A-Z0-9_]{0,63}_API_KEY$/

export function HarnessModelApiPane() {
  const { lang } = useI18n()
  const zh = lang === 'zh' || lang === 'zh-TW'
  const { home } = useShellPlatform()
  const [provider, setProvider] = useState<string>('DEEPSEEK_API_KEY')
  const [customRef, setCustomRef] = useState('')
  const [key, setKey] = useState('')
  const [status, setStatus] = useState<ModelCredentialStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const ref = provider === 'custom' ? customRef.trim().toUpperCase() : provider
  const validRef = API_KEY_REF.test(ref)

  useEffect(() => {
    let alive = true
    setStatus(null)
    setNotice('')
    if (!validRef || !home.getModelCredential) return () => { alive = false }
    setLoading(true)
    void home.getModelCredential(ref).then((next) => {
      if (alive) setStatus(next)
    }).catch(() => {
      if (alive) setNotice(zh ? '读取配置失败，请检查本地服务连接。' : 'Could not load API key status. Check the local service.')
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [home, ref, validRef, zh])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!validRef || !status?.writable || !key.trim() || !home.setModelCredential) return
    setSaving(true)
    setNotice('')
    try {
      const next = await home.setModelCredential(ref, key.trim())
      setStatus(next)
      setKey('')
      setNotice(zh ? '已保存。下一次发起对话即可使用。' : 'Saved. The next conversation can use this key.')
    } catch {
      setNotice(zh ? '保存失败，请检查本地服务连接或启动环境配置。' : 'Could not save. Check the local service or launch environment.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="set-model-api" onSubmit={(event) => void save(event)}>
      <h3 className="set-pane-title">{zh ? '大模型 API' : 'Model API keys'}</h3>
      <p className="set-field-desc set-model-api-intro">
        {zh ? '把供应商 API Key 保存在本机，供 Offira 助手使用。模型在聊天框中选择。' : 'Save provider API keys on this computer for the Offira assistant. Choose a model in chat.'}
      </p>
      <label className="set-model-api-label" htmlFor="offira-provider">{zh ? '供应商' : 'Provider'}</label>
      <select id="offira-provider" className="set-input set-model-api-control" value={provider}
        onChange={(event) => { setProvider(event.target.value); setKey('') }}>
        {PROVIDERS.map((item) => <option key={item.ref} value={item.ref}>{item.label}</option>)}
        <option value="custom">{zh ? '其他供应商' : 'Other provider'}</option>
      </select>
      {provider === 'custom' && (
        <>
          <label className="set-model-api-label" htmlFor="offira-api-ref">{zh ? 'API Key 变量名' : 'API key variable name'}</label>
          <input id="offira-api-ref" className="set-input set-model-api-control" value={customRef}
            onChange={(event) => setCustomRef(event.target.value)} placeholder="PROVIDER_API_KEY" autoComplete="off" spellCheck={false} />
        </>
      )}
      <p className="set-model-api-state" role="status">
        {!validRef ? (zh ? '请输入以 _API_KEY 结尾的变量名。' : 'Enter a name ending in _API_KEY.')
          : loading ? (zh ? '正在读取配置…' : 'Checking…')
          : status?.configured ? (status.writable ? (zh ? '已配置 · 密钥不会在这里显示' : 'Configured · key is hidden')
            : (zh ? '由启动环境提供 · 请在启动配置中修改' : 'Provided by launch environment · edit it there'))
          : status ? (zh ? '尚未配置' : 'Not configured') : notice}
      </p>
      <label className="set-model-api-label" htmlFor="offira-api-key">API Key</label>
      <input id="offira-api-key" className="set-input set-model-api-control" type="password"
        value={key} onChange={(event) => setKey(event.target.value)} autoComplete="new-password"
        placeholder={zh ? '粘贴新的 API Key' : 'Paste a new API key'}
        disabled={!validRef || loading || !status?.writable || saving} />
      <div className="set-pane-footer">
        <span className="set-field-desc" role="status">{notice}</span>
        <button className="set-btn primary" type="submit" disabled={!key.trim() || !status?.writable || saving}>
          {saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存 API Key' : 'Save API key')}
        </button>
      </div>
    </form>
  )
}
