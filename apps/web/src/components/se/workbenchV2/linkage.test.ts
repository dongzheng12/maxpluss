import { describe, expect, it } from 'vitest'
import { buildLinkage, findClauseParagraph, firstCardForClause, splitParagraphs } from './linkage'
import type { TaskCardV2 } from '../../../api/standardExecution'

function card(id: string, clauseNo: string | null): TaskCardV2 {
  return {
    id,
    draftId: id,
    taskDraftId: id,
    groupId: id,
    title: id,
    description: '',
    submitRequirement: '',
    taskType: 'OTHER',
    requiredMaterials: [],
    deadlineSuggestion: { mode: 'AFTER_APPROVAL_DAYS', daysAfterApproval: 7, fixedAt: null, label: '', reason: null },
    basis: { sourceId: null, sourceTitle: null, clauseNo, excerpt: '' },
    polishStatus: 'AI_POLISHED',
    warnings: [],
  }
}

const PARAS = [
  '1 总则',
  '5.2 应每月检查关键设备完好率并形成记录。',
  '5.2.1 关键设备清单应每年复核。',
  '6.3 岗前培训应留存记录。',
]

describe('splitParagraphs', () => {
  it('按换行切段去空', () => {
    expect(splitParagraphs('a\n\nb\n c \n')).toEqual(['a', 'b', 'c'])
  })
})

describe('findClauseParagraph', () => {
  it('命中以条款号开头的段', () => {
    expect(findClauseParagraph(PARAS, '5.2')).toBe(1)
    expect(findClauseParagraph(PARAS, '6.3')).toBe(3)
  })
  it('5.2 不误命中 5.2.1', () => {
    // 5.2 应命中 index 1，而非 2（5.2.1）
    expect(findClauseParagraph(PARAS, '5.2')).toBe(1)
    expect(findClauseParagraph(PARAS, '5.2.1')).toBe(2)
  })
  it('找不到返回 -1', () => {
    expect(findClauseParagraph(PARAS, '9.9')).toBe(-1)
    expect(findClauseParagraph(PARAS, null)).toBe(-1)
  })
})

describe('buildLinkage', () => {
  it('构建双向映射，同条款多卡聚合', () => {
    const cards = [card('a', '5.2'), card('b', '5.2'), card('c', '6.3'), card('d', null)]
    const lk = buildLinkage(cards, PARAS)
    expect(lk.clauseToParagraph['5.2']).toBe(1)
    expect(lk.clauseToParagraph['6.3']).toBe(3)
    expect(lk.clauseToCards['5.2']).toEqual(['a', 'b'])
    expect(lk.cardToClause['a']).toBe('5.2')
    expect(lk.cardToClause['d']).toBeNull()
  })
  it('条款在原文找不到则不进 clauseToParagraph，但仍有 clauseToCards', () => {
    const cards = [card('a', '9.9')]
    const lk = buildLinkage(cards, PARAS)
    expect(lk.clauseToParagraph['9.9']).toBeUndefined()
    expect(lk.clauseToCards['9.9']).toEqual(['a'])
  })
})

describe('firstCardForClause', () => {
  it('返回该条款首卡', () => {
    const lk = buildLinkage([card('a', '5.2'), card('b', '5.2')], PARAS)
    expect(firstCardForClause(lk, '5.2')).toBe('a')
    expect(firstCardForClause(lk, '6.3')).toBeNull()
    expect(firstCardForClause(lk, null)).toBeNull()
  })
})
