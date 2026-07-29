import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { PocGate } from './components/PocGate'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PocGate>
      <App />
    </PocGate>
  </StrictMode>,
)
