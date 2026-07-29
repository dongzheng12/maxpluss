import { useState, useCallback, type ReactNode } from 'react'
import { SEPageContext, type SEPageData, type SEAskTrigger } from './SEPageContext'

/**
 * SE 页面上下文 Provider：封装页面数据上下文（data）+ 详情页「问小智」触发（ask）。
 * admin 后台与企业版门户两个 Layout 复用，确保 AI 浮标在两端都能拿到上下文与触发。
 */
export function SEPageProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<SEPageData | null>(null)
  const [ask, setAsk] = useState<SEAskTrigger | null>(null)
  const triggerAsk = useCallback((contextText: string, question: string) => {
    setAsk({ contextText, question, nonce: Date.now() })
  }, [])
  return (
    <SEPageContext.Provider value={{ data, setData, ask, triggerAsk }}>
      {children}
    </SEPageContext.Provider>
  )
}
