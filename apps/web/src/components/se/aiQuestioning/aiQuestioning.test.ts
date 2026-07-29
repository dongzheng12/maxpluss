import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, beforeEach } from 'vitest'
import { SEPageContext } from '../../../contexts/SEPageContext'
import { AIAskableRegion } from './AIAskableRegion'
import {
  DEFAULT_AI_CONTEXT_QUESTION,
  formatAIQuestionContext,
  summarizeAIContextText,
  type AIQuestionContext,
} from './types'
import { readAIDisplayEnabled, writeAIDisplayEnabled, AI_DISPLAY_STORAGE_KEY } from './displayPreference'
import { clearAIAskableRegistryForTest, getAIAskable, registerAIAskable } from './askableRegistry'

class MemoryStorage {
  private data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

const context: AIQuestionContext = {
  page: 'enterprise/risks',
  objectType: 'risk',
  objectId: 'risk-1',
  title: '门岗巡查记录逾期',
  summary: '门岗夜间巡查记录超过截止时间仍未提交，建议先提醒执行人补交并核查班次交接记录。',
  meta: { riskLevel: 'HIGH' },
}

describe('P4-v2 aiQuestioning components', () => {
  beforeEach(() => clearAIAskableRegistryForTest())

  it('formats the shared chat context protocol', () => {
    const text = formatAIQuestionContext(context)
    expect(text).toContain('page=enterprise/risks')
    expect(text).toContain('objectType=risk')
    expect(text).toContain('objectId=risk-1')
    expect(text).toContain('riskLevel=HIGH')
    expect(text).toContain('正文摘要：')
    expect(text).toContain('门岗夜间巡查记录')
  })

  it('truncates long summaries without dropping the visible context shape', () => {
    const text = summarizeAIContextText('安保'.repeat(400), 20)
    expect(text).toHaveLength(20)
    expect(text.endsWith('…')).toBe(true)
  })

  it('defaults AI display to on and persists explicit off', () => {
    const storage = new MemoryStorage()
    expect(readAIDisplayEnabled(storage)).toBe(true)
    writeAIDisplayEnabled(false, storage)
    expect(storage.getItem(AI_DISPLAY_STORAGE_KEY)).toBe('false')
    expect(readAIDisplayEnabled(storage)).toBe(false)
    writeAIDisplayEnabled(true, storage)
    expect(readAIDisplayEnabled(storage)).toBe(true)
  })

  it('registers askable entries for the one-shot picker', () => {
    const unregister = registerAIAskable('risk-card', { context, question: DEFAULT_AI_CONTEXT_QUESTION })
    expect(getAIAskable('risk-card')?.context.objectId).toBe('risk-1')
    unregister()
    expect(getAIAskable('risk-card')).toBeNull()
  })

  it('renders askable region with a picker data hook in node SSR', () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        SEPageContext.Provider,
        { value: { data: null, setData: () => {}, ask: null, triggerAsk: () => {} } },
        React.createElement(
          AIAskableRegion,
          { context, children: React.createElement('article', null, '风险卡片正文') },
        ),
      ),
    )

    expect(markup).toContain('data-ai-askable-id')
    expect(markup).toContain('风险卡片正文')
  })
})
