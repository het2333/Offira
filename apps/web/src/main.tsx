import ReactDOM from 'react-dom/client'

import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Missing NexusDesk root element')
ReactDOM.createRoot(root).render(<App />)
