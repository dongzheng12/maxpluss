import { Button, Checkbox, Modal, Space, Tag, Tooltip, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, HighlightOutlined, SplitCellsOutlined, UndoOutlined } from '@ant-design/icons'
import type { MouseEvent } from 'react'
import { TASK_TYPE_LABEL, type TaskCardV2 } from '../../../api/standardExecution'

const { Text, Paragraph } = Typography

interface TaskCardItemProps {
  card: TaskCardV2
  /** 选中态 + 切换；不传则不渲染多选框（批次1） */
  selected?: boolean
  focused?: boolean
  onToggleSelect?: (cardId: string, checked: boolean) => void
  onEdit: (cardId: string) => void
  onDelete: (cardId: string) => void
  onSplit?: (cardId: string) => void
  /** 单卡 AI 重写（覆盖卡内容，按下前轻确认） */
  onRewrite?: (cardId: string) => void
  rewriting?: boolean
  /** 刚被重写、可撤销 */
  undoable?: boolean
  onUndoRewrite?: (cardId: string) => void
  /** 左右联动：高亮态 + 点击卡回跳原文（批次3 接） */
  active?: boolean
  onActivate?: (cardId: string) => void
}

export default function TaskCardItem({
  card,
  selected,
  focused,
  onToggleSelect,
  onEdit,
  onDelete,
  onSplit,
  onRewrite,
  rewriting,
  undoable,
  onUndoRewrite,
  active,
  onActivate,
}: TaskCardItemProps) {
  const isFallback = card.polishStatus === 'FALLBACK_ORIGINAL'
  const confirmRewrite = (event: MouseEvent) => {
    event.stopPropagation()
    Modal.confirm({
      title: 'AI 重写会覆盖本卡当前内容',
      content: '确认重写？可在重写后撤销。',
      okText: '重写',
      cancelText: '取消',
      onOk: () => onRewrite?.(card.id),
    })
  }
  return (
    <div
      data-card-id={card.id}
      onClick={onActivate ? () => onActivate(card.id) : undefined}
      style={{
        border: `1px solid ${focused || active || selected ? '#4096ff' : '#eef2f7'}`,
        boxShadow: focused
          ? '0 0 0 3px rgba(22,119,255,0.24)'
          : active || selected
            ? '0 0 0 2px rgba(64,150,255,0.15)'
            : undefined,
        borderRadius: 10,
        padding: 14,
        background: selected ? '#f5faff' : '#fff',
        cursor: onActivate ? 'pointer' : undefined,
      }}
    >
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
        <Space align="start" size={10}>
          {onToggleSelect && (
            <Checkbox
              checked={!!selected}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onToggleSelect(card.id, e.target.checked)}
              style={{ marginTop: 2 }}
            />
          )}
          <div>
            <Text strong style={{ fontSize: 15 }}>{card.title || '未命名任务'}</Text>
            <div style={{ marginTop: 6 }}>
              <Space size={6} wrap>
                <Tag color="blue">{TASK_TYPE_LABEL[card.taskType] || card.taskType}</Tag>
                <Tag>{card.deadlineSuggestion.label}</Tag>
                {isFallback && (
                  <Tooltip title="AI 润色失败，展示原文提取结果">
                    <Tag color="orange">原文提取</Tag>
                  </Tooltip>
                )}
                {selected && <Tag color="processing">已选</Tag>}
                {focused && <Tag color="blue">刚生成</Tag>}
                {card.warnings?.map((w) => <Tag color="gold" key={w}>{w}</Tag>)}
              </Space>
            </div>
          </div>
        </Space>
        <Space size={4}>
          {undoable && onUndoRewrite && (
            <Button size="small" type="text" icon={<UndoOutlined />} onClick={(e) => { e.stopPropagation(); onUndoRewrite(card.id) }}>撤销重写</Button>
          )}
          {onRewrite && (
            <Button size="small" type="text" loading={rewriting} icon={<HighlightOutlined />} onClick={confirmRewrite}>AI 重写</Button>
          )}
          <Button size="small" type="text" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); onEdit(card.id) }}>编辑</Button>
          {onSplit && (
            <Button size="small" type="text" icon={<SplitCellsOutlined />} onClick={(e) => { e.stopPropagation(); onSplit(card.id) }}>拆分</Button>
          )}
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); onDelete(card.id) }}>删除</Button>
        </Space>
      </Space>

      {card.description && (
        <Paragraph style={{ margin: '10px 0 6px', color: '#475569' }} ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}>
          {card.description}
        </Paragraph>
      )}

      {card.submitRequirement && (
        <div style={{ marginBottom: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>提交要求：</Text>
          <Text style={{ fontSize: 12 }}>{card.submitRequirement}</Text>
        </div>
      )}

      {card.requiredMaterials?.length > 0 && (
        <Space size={4} wrap style={{ marginBottom: 8 }}>
          {card.requiredMaterials.map((m) => <Tag key={m} bordered={false} color="processing">{m}</Tag>)}
        </Space>
      )}

      <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          依据 {card.basis.clauseNo ? `第 ${card.basis.clauseNo} 条` : '（无条款号）'}
          {card.basis.sourceTitle ? ` · ${card.basis.sourceTitle}` : ''}
        </Text>
        {card.basis.excerpt && (
          <Paragraph style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }} ellipsis={{ rows: 2, expandable: true, symbol: '原文' }}>
            {card.basis.excerpt}
          </Paragraph>
        )}
      </div>
    </div>
  )
}
