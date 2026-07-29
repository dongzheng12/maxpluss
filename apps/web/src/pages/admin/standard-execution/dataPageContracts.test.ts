import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

const readSource = (relativePath: string) => readFileSync(path.join(here, relativePath), 'utf8')

describe('record, package, and member page product rulings', () => {
  const pages = {
    records: 'records/index.tsx',
    packages: 'packages/index.tsx',
    members: '../../enterprise/members/index.tsx',
  }

  it.each(Object.entries(pages))('keeps %s free of the removed CSV export action', (_name, relativePath) => {
    expect(readSource(relativePath)).not.toContain('导出 CSV')
  })

  it('keeps record detail closable and clears stale detail data', () => {
    const records = readSource(pages.records)

    expect(records).toContain('open={detailOpen}')
    expect(records).toContain('onClose={() => { setDetailOpen(false); setDetail(null) }}')
    expect(records).toContain('setDetail(res.data as RecordDetail)')
    expect(records).toContain('setDetailOpen(true)')
  })

  it('keeps record batch void behavior explainable for skipped records', () => {
    const records = readSource(pages.records)

    expect(records).toContain("title: '批量作废'")
    expect(records).toContain('已作废的自动跳过')
    expect(records).toContain('审计包会被标脏')
    // Batch actions only appear once a subset is actually selected, so the action
    // can never fire against an empty selection.
    expect(records).toContain('{selectedKeys.length > 0 && (')
    expect(records).toContain('setSelectedKeys([]); load()')
  })

  it('keeps record timeline enum values translated before display', () => {
    const records = readSource(pages.records)

    expect(records).toContain("REVIEW_APPROVE: '审核通过后自动沉淀'")
    expect(records).toContain("APPROVE: '审核通过'")
    expect(records).toContain('REVIEW_ACTION_LABEL[log.action]')
    expect(records).toContain('RECORD_SOURCE_LABEL[detail.createdFrom')
  })

  it('keeps package creation hidden until the new-package action opens it', () => {
    const packages = readSource(pages.packages)

    expect(packages).toContain('const [createOpen, setCreateOpen] = useState(false)')
    expect(packages).toContain('const openCreate = async')
    expect(packages).toContain('setCreateOpen(true)')
    expect(packages).toContain('open={createOpen}')
    expect(packages).toContain('onCancel={() => setCreateOpen(false)}')
    expect(packages).toContain('setCreateOpen(false)')
  })

  it('keeps package detail closable and clears stale detail data', () => {
    const packages = readSource(pages.packages)

    expect(packages).toContain('const closeDetail = () => {')
    expect(packages).toContain('setDetailOpen(false)')
    expect(packages).toContain('setDetail(null)')
    expect(packages).toContain('open={detailOpen}')
    expect(packages).toContain('onClose={closeDetail}')
  })

  it('keeps package batch void behavior explainable for skipped packages', () => {
    const packages = readSource(pages.packages)

    expect(packages).toContain("title: '批量作废'")
    expect(packages).toContain('已作废的自动跳过')
    expect(packages).toContain('disabled={selectedKeys.length === 0}')
    expect(packages).toContain('setSelectedKeys([]); load()')
  })

  it('keeps package display labels translated instead of leaking raw enums', () => {
    const packages = readSource(pages.packages)

    expect(packages).toContain('PACKAGE_SCENE_DISPLAY_LABEL')
    expect(packages).toContain('PACKAGE_STATUS_LABEL')
    expect(packages).toContain('FORMAT_LABEL')
    expect(packages).toContain("APPROVE: '审核通过'")
    expect(packages).toContain('REVIEW_ACTION_LABEL[log.action]')
  })

  it('keeps member creation hidden until the add-member action opens it', () => {
    const members = readSource(pages.members)

    expect(members).toContain('const [addOpen, setAddOpen] = useState(false)')
    expect(members).toContain('setAddOpen(true)')
    expect(members).toContain('open={addOpen}')
    expect(members).toContain('onClose={() => { setAddOpen(false); addForm.resetFields() }}')
    expect(members).toContain('destroyOnHidden')
  })

  it('keeps member add and cancel flows resetting the form', () => {
    const members = readSource(pages.members)

    expect(members).toContain('message.success(\'成员已添加\')')
    expect(members).toContain('setAddOpen(false)')
    expect(members).toContain('addForm.resetFields()')
    expect(members).toContain("initialValues={{ enterpriseRole: 'EMPLOYEE' }}")
  })

  it('keeps member search and role selectors searchable', () => {
    const members = readSource(pages.members)

    expect(members).toContain('allowClear')
    expect(members).toContain('showSearch')
    expect(members).toContain('optionFilterProp="label"')
    expect(members).toContain('ROLE_LABEL[item.role]')
  })
})
