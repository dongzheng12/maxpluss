import { useCallback, useEffect, useState } from 'react'

export const AI_DISPLAY_STORAGE_KEY = 'bxz_se_ai_display_enabled'
export const AI_DISPLAY_CHANGE_EVENT = 'bxz-se-ai-display-change'

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>

function getBrowserStorage(): MinimalStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readAIDisplayEnabled(storage: Pick<Storage, 'getItem'> | null = getBrowserStorage()) {
  const raw = storage?.getItem(AI_DISPLAY_STORAGE_KEY)
  return raw !== 'false'
}

export function writeAIDisplayEnabled(enabled: boolean, storage: MinimalStorage | null = getBrowserStorage()) {
  storage?.setItem(AI_DISPLAY_STORAGE_KEY, enabled ? 'true' : 'false')
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AI_DISPLAY_CHANGE_EVENT, { detail: { enabled } }))
  }
}

export function useAIDisplayPreference() {
  const [enabled, setEnabledState] = useState(() => readAIDisplayEnabled())

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const sync = () => setEnabledState(readAIDisplayEnabled())
    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail
      if (typeof detail?.enabled === 'boolean') setEnabledState(detail.enabled)
      else sync()
    }
    window.addEventListener('storage', sync)
    window.addEventListener(AI_DISPLAY_CHANGE_EVENT, onCustom)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(AI_DISPLAY_CHANGE_EVENT, onCustom)
    }
  }, [])

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next)
    writeAIDisplayEnabled(next)
  }, [])

  return { enabled, setEnabled }
}
