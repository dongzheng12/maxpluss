import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TASK_DETAIL_FIELD_KEYS,
  TASK_EDIT_FIELD_KEYS,
  TASK_FIELD_MODEL,
} from './tasks/taskFieldModel'

const here = path.dirname(fileURLToPath(import.meta.url))

const readPage = (relativePath: string) => readFileSync(path.join(here, relativePath), 'utf8')
const count = (source: string, needle: string) => source.split(needle).length - 1

const enterprisePageFiles = [
  'dashboard/index.tsx',
  'intelligence-dashboard/index.tsx',
  'tasks/index.tsx',
  'sources/index.tsx',
  'requirements/index.tsx',
  'reviews/index.tsx',
  'records/index.tsx',
  'packages/index.tsx',
  'question-banks/index.tsx',
  'risks/index.tsx',
]

describe('enterprise page product rulings', () => {
  it.each(enterprisePageFiles)('keeps %s free of the removed CSV export action', (relativePath) => {
    expect(readPage(relativePath)).not.toContain('导出 CSV')
  })

  it('renders task detail and edit panels from the same 12-field model', () => {
    const tasks = readPage('tasks/index.tsx')

    expect(TASK_FIELD_MODEL).toHaveLength(12)
    expect(TASK_DETAIL_FIELD_KEYS).toEqual(TASK_EDIT_FIELD_KEYS)
    expect(tasks).toContain('data-task-panel-field-count={TASK_FIELD_MODEL.length}')
    // Detail panel renders every model field through one map.
    expect(tasks).toContain('TASK_FIELD_MODEL.map((field) => renderDetailField(field.key))')
    // Edit panel covers the same 12 fields via a curated layout: 6 basic fields
    // mapped, 5 editable fields rendered individually, and submitRequirement shown
    // as a derived read-only policy shell — so detail/edit stay in lockstep.
    expect(tasks).toContain("(['title', 'taskType', 'source', 'assignees', 'reviewer', 'deadline']")
    ;(['generatedContent', 'submitForm', 'materials', 'status', 'lifecycle'] as const).forEach((key) => {
      expect(tasks).toContain(`renderEditField('${key}')`)
    })
    expect(tasks).toContain("fieldShell('submitRequirement', 'edit'")
    expect(count(tasks, 'data-task-panel-field-count={TASK_FIELD_MODEL.length}')).toBe(2)
  })

  it('keeps task side panels mutually exclusive and closable', () => {
    const tasks = readPage('tasks/index.tsx')

    expect(tasks).toContain('{detailOpen && !editOpen && (')
    // Both side panels are closable: the detail drawer via closeTaskPanel and the
    // edit modal via cancelEdit. Closing clears the row + de-highlights the list.
    expect(tasks).toContain('onClose={closeTaskPanel}')
    expect(tasks).toContain('onCancel={cancelEdit}')
    expect(tasks).toContain('keyboard')
    expect(tasks).toContain('setDetailRow(null)')
    expect(tasks).toContain('setEditRow(null)')
    expect(tasks).toContain("detailRow?.id === row.id || editRow?.id === row.id")
  })

  it('keeps task bulk actions explainable when only part of the selection applies', () => {
    const tasks = readPage('tasks/index.tsx')

    expect(tasks).toContain('Tooltip title={batchAssignTip}')
    expect(tasks).toContain('Tooltip title={batchCancelTip}')
    expect(tasks).toContain('非草稿会自动跳过')
    expect(tasks).toContain('其余会自动跳过')
    expect(tasks).toContain('仅当选中项全部为草稿时可删除')
    expect(tasks).toContain('项中 ${selectedDraftCount} 项适用')
  })

  it('keeps the standard library create/import panel hidden until explicitly opened', () => {
    const sources = readPage('sources/index.tsx')

    expect(sources).toContain('const [importWizardOpen, setImportWizardOpen] = useState(false)')
    expect(sources).toContain("onClick={() => openImportWizard('upload')}")
    expect(sources).toContain('open={isEnterprise && importWizardOpen}')
    expect(sources).toContain('onCancel={closeImportWizard}')
  })

  it('keeps only one standard library primary AI decomposition entry point', () => {
    const sources = readPage('sources/index.tsx')

    expect(count(sources, 'AI 拆解任务')).toBe(1)
    expect(sources).toContain('onClick={() => goTaskGeneration()}')
  })

  it('keeps enterprise review details non-empty-shell, closable, and de-highlighted on close', () => {
    const reviews = readPage('reviews/index.tsx')

    expect(reviews).toContain('const closeDetail = () => {')
    expect(reviews).toContain('setDetailOpen(false)')
    expect(reviews).toContain('setDetail(null)')
    expect(reviews).toContain("event.key === 'Escape'")
    expect(reviews).toContain('aria-label="关闭审核详情"')
    expect(reviews).toContain('{isEnterprise && detail && <div')
    expect(reviews).toContain('detail?.submission.id === row.submission.id')
  })

  it('keeps review action enum values translated before display', () => {
    const reviews = readPage('reviews/index.tsx')

    expect(reviews).toContain("SUBMIT: '提交审核'")
    expect(reviews).toContain("APPROVE: '审核通过'")
    expect(reviews).toContain("REJECT: '审核驳回'")
    expect(reviews).toContain('REVIEW_ACTION_LABEL[log.action]')
  })
})
