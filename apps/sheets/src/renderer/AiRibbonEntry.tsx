import { GensparkMark } from './ribbon-icons'
import offiraMark from '../../../../packages/nexusdesk-shell-ui/src/assets/offira-mark.svg'

interface AiRibbonEntryProps {
  readonly nativeHarness: boolean
  readonly open: boolean
  readonly onToggle: () => void
  readonly assistantTitle: string
}

export function AiRibbonEntry({ nativeHarness, open, onToggle, assistantTitle }: AiRibbonEntryProps): React.JSX.Element {
  const nativeLabel = open ? '收起 Offira 助手' : '打开 Offira 助手'
  return <button
    className={`ribbon-tool as-button large ai-entry ${nativeHarness ? 'offira-ai-entry' : ''} ${open ? 'active' : ''}`}
    data-tip={nativeHarness ? nativeLabel : assistantTitle}
    aria-label={nativeHarness ? nativeLabel : undefined}
    aria-pressed={open}
    onClick={onToggle}
  >
    <span className="tool-icon-row">
      {nativeHarness ? <img className="offira-ai-mark" src={offiraMark} alt="" /> : <GensparkMark size={26} />}
    </span>
    <span><strong>{nativeHarness ? 'Offira AI' : 'Genspark AI'}</strong></span>
  </button>
}
