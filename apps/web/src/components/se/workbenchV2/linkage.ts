/**
 * 左右联动纯逻辑：任务卡依据条款号 ↔ 标准原文段落 的映射（无 React 依赖，可 node 测）。
 */
import type { TaskCardV2 } from '../../../api/standardExecution'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把正文按换行切段（与 StandardTextPanel 保持一致） */
export function splitParagraphs(raw: string): string[] {
  return raw
    .split(/\n{1,}/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 找出以某条款号开头的段落 index。
 * - 条款号后必须不接数字或点，避免 "5.2" 误命中 "5.2.1"。
 * - 找不到返回 -1。
 */
export function findClauseParagraph(paragraphs: string[], clauseNo: string | null): number {
  if (!clauseNo) return -1
  const re = new RegExp(`^\\s*${escapeRegExp(clauseNo)}(?![\\d.])`)
  return paragraphs.findIndex((p) => re.test(p))
}

export interface Linkage {
  /** 条款号 → 段落 index（仅 rawText 命中的） */
  clauseToParagraph: Record<string, number>
  /** 条款号 → 该条款下的卡 id 列表 */
  clauseToCards: Record<string, string[]>
  /** 卡 id → 条款号 */
  cardToClause: Record<string, string | null>
}

/** 构建双向联动映射 */
export function buildLinkage(cards: TaskCardV2[], paragraphs: string[]): Linkage {
  const clauseToParagraph: Record<string, number> = {}
  const clauseToCards: Record<string, string[]> = {}
  const cardToClause: Record<string, string | null> = {}

  for (const card of cards) {
    const clause = card.basis.clauseNo
    cardToClause[card.id] = clause
    if (!clause) continue
    if (!(clause in clauseToCards)) {
      clauseToCards[clause] = []
      const idx = findClauseParagraph(paragraphs, clause)
      if (idx >= 0) clauseToParagraph[clause] = idx
    }
    clauseToCards[clause].push(card.id)
  }
  return { clauseToParagraph, clauseToCards, cardToClause }
}

/** 给定激活条款号，返回应高亮/滚动到的第一张卡 id（右→联动） */
export function firstCardForClause(linkage: Linkage, clauseNo: string | null): string | null {
  if (!clauseNo) return null
  return linkage.clauseToCards[clauseNo]?.[0] ?? null
}
