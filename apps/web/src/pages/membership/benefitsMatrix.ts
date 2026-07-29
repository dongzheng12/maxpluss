export type MembershipBenefitsColumnKey = 'guest' | 'free' | 'personal' | 'pro'

export type MembershipBenefitsMatrix = {
  version: number
  columns: Array<{ key: MembershipBenefitsColumnKey; label: string }>
  sections: Array<{
    key: string
    title: string
    rows: Array<{
      key: string
      name: string
      values: Record<MembershipBenefitsColumnKey, string>
    }>
  }>
  noteItems: string[]
}

export const fallbackBenefitsMatrix: MembershipBenefitsMatrix = {
  version: 1,
  columns: [
    { key: 'guest', label: '未登录' },
    { key: 'free', label: '免费用户' },
    { key: 'personal', label: '个人会员 ¥598/年' },
    { key: 'pro', label: '专业会员 ¥998/年' },
  ],
  sections: [
    {
      key: 'basic',
      title: '基础功能',
      rows: [
        {
          key: 'standard_search',
          name: '知识库检索',
          values: { guest: '不可用', free: '每天 5 次', personal: '不限次', pro: '不限次' },
        },
        {
          key: 'standard_graph',
          name: '知识图谱',
          values: { guest: '不可用', free: '每天 5 次', personal: '不限次', pro: '不限次' },
        },
        {
          key: 'technical_committee',
          name: '技术委员会查询',
          values: { guest: '不可用', free: '不限次', personal: '不限次', pro: '不限次' },
        },
      ],
    },
    {
      key: 'chat',
      title: '呼叫小智',
      rows: [
        {
          key: 'chat_assistant',
          name: '呼叫小智 / AI 编写辅助',
          values: { guest: '不可用', free: '每天 5 次', personal: '不限次', pro: '不限次' },
        },
      ],
    },
    {
      key: 'high_value',
      title: '高价值功能',
      rows: [
        {
          key: 'compare_one_to_one',
          name: '一对一比对（上传两份文档）',
          values: { guest: '不可用', free: '不可用', personal: '不限次', pro: '不限次' },
        },
        {
          key: 'compare_library',
          name: '全库相似度分析',
          values: { guest: '不可用', free: '不可用', personal: '10 次/年完整报告', pro: '不限次完整报告' },
        },
      ],
    },
  ],
  noteItems: [
    '免费用户各功能次数独立计算，互不影响。',
    '一对一比对为会员专属功能，需开通个人会员或专业会员方可使用。',
    '全库相似度分析为会员权益，完整报告按会员等级和套餐次数使用。',
    '个人会员的全库相似度分析次数为 10 次/年，自开通日起算；专业会员不限次。',
  ],
}

const COLUMN_KEYS: MembershipBenefitsColumnKey[] = ['guest', 'free', 'personal', 'pro']

function isStringRecord(values: unknown): values is Record<string, string> {
  return !!values &&
    typeof values === 'object' &&
    COLUMN_KEYS.every((key) => typeof (values as Record<string, unknown>)[key] === 'string')
}

export function isMembershipBenefitsMatrix(value: unknown): value is MembershipBenefitsMatrix {
  if (!value || typeof value !== 'object') return false
  const matrix = value as Record<string, unknown>
  if (typeof matrix.version !== 'number') return false
  if (!Array.isArray(matrix.columns) || !Array.isArray(matrix.sections) || !Array.isArray(matrix.noteItems)) return false

  const columnsValid = matrix.columns.every((column) => {
    if (!column || typeof column !== 'object') return false
    const col = column as Record<string, unknown>
    return COLUMN_KEYS.includes(col.key as MembershipBenefitsColumnKey) && typeof col.label === 'string'
  })
  if (!columnsValid) return false

  const sectionsValid = matrix.sections.every((section) => {
    if (!section || typeof section !== 'object') return false
    const s = section as Record<string, unknown>
    if (typeof s.key !== 'string' || typeof s.title !== 'string' || !Array.isArray(s.rows)) return false
    return s.rows.every((row) => {
      if (!row || typeof row !== 'object') return false
      const r = row as Record<string, unknown>
      return typeof r.key === 'string' && typeof r.name === 'string' && isStringRecord(r.values)
    })
  })
  if (!sectionsValid) return false

  return matrix.noteItems.every((item) => typeof item === 'string')
}

export function resolveBenefitsMatrix(value: unknown): MembershipBenefitsMatrix {
  return isMembershipBenefitsMatrix(value) ? value : fallbackBenefitsMatrix
}
