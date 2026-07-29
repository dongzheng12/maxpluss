import { useMemo } from 'react'
import { Empty, Typography } from 'antd'
import type { TaskCardV2 } from '../../../api/standardExecution'
import { buildLinkage, splitParagraphs } from './linkage'

const { Text } = Typography

interface StandardTextPanelProps {
  /** 标准文档完整正文（优先展示） */
  rawText?: string | null
  sourceTitle?: string | null
  /** 无正文时的兜底：用任务卡依据摘录拼"依据片段" */
  cards: TaskCardV2[]
  /** 联动高亮：当前激活的条款号 */
  activeClauseNo?: string | null
  onClauseClick?: (clauseNo: string) => void
}

export default function StandardTextPanel({
  rawText,
  sourceTitle,
  cards,
  activeClauseNo,
  onClauseClick,
}: StandardTextPanelProps) {
  const hasRaw = !!rawText && rawText.trim().length > 0
  const paragraphs = useMemo(() => (hasRaw ? splitParagraphs(rawText!) : []), [hasRaw, rawText])
  // 段落 index → 条款号（仅原文里能定位到的有依据条款）
  const paraClause = useMemo(() => {
    const map: Record<number, string> = {}
    if (!hasRaw) return map
    const lk = buildLinkage(cards, paragraphs)
    for (const [clause, idx] of Object.entries(lk.clauseToParagraph)) map[idx] = clause
    return map
  }, [hasRaw, cards, paragraphs])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #eef2f7' }}>
        <Text strong>标准原文</Text>
        {sourceTitle && <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{sourceTitle}</Text>}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, lineHeight: 1.8, color: '#334155', fontSize: 13 }}>
        {hasRaw ? (
          paragraphs.map((p, i) => {
            const clause = paraClause[i]
            const active = !!clause && clause === activeClauseNo
            return (
              <p
                key={i}
                data-clause-no={clause || undefined}
                onClick={clause && onClauseClick ? () => onClauseClick(clause) : undefined}
                style={{
                  margin: '0 0 10px',
                  padding: clause ? '4px 8px' : '0 8px',
                  borderRadius: 6,
                  background: active ? 'rgba(64,150,255,0.14)' : clause ? '#f8fafc' : undefined,
                  borderLeft: clause ? `3px solid ${active ? '#4096ff' : '#e2e8f0'}` : undefined,
                  cursor: clause && onClauseClick ? 'pointer' : undefined,
                  transition: 'background .15s',
                }}
              >
                {p}
              </p>
            )
          })
        ) : cards.length > 0 ? (
          // 兜底：无完整正文时，用卡片依据摘录拼"依据片段"，仍支持联动
          cards
            .filter((c) => c.basis.excerpt)
            .map((c) => {
              const active = !!activeClauseNo && c.basis.clauseNo === activeClauseNo
              return (
                <div
                  key={c.id}
                  data-clause-no={c.basis.clauseNo || undefined}
                  onClick={onClauseClick && c.basis.clauseNo ? () => onClauseClick(c.basis.clauseNo!) : undefined}
                  style={{
                    margin: '0 0 12px',
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: active ? 'rgba(64,150,255,0.14)' : '#f8fafc',
                    borderLeft: `3px solid ${active ? '#4096ff' : '#e2e8f0'}`,
                    cursor: onClauseClick && c.basis.clauseNo ? 'pointer' : undefined,
                  }}
                >
                  {c.basis.clauseNo && <Text type="secondary" style={{ fontSize: 12 }}>第 {c.basis.clauseNo} 条</Text>}
                  <div style={{ marginTop: 2 }}>{c.basis.excerpt}</div>
                </div>
              )
            })
        ) : (
          <Empty description="选择标准文档并生成任务后，这里显示原文依据" />
        )}
      </div>
    </div>
  )
}
