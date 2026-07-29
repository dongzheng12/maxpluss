const fallbackBenefitsMatrix = {
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

const COLUMN_KEYS = ['guest', 'free', 'personal', 'pro']

function isStringRecord(values) {
  return !!values &&
    typeof values === 'object' &&
    COLUMN_KEYS.every(function (key) { return typeof values[key] === 'string' })
}

function isMembershipBenefitsMatrix(value) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.version !== 'number') return false
  if (!Array.isArray(value.columns) || !Array.isArray(value.sections) || !Array.isArray(value.noteItems)) return false

  var columnsValid = value.columns.every(function (column) {
    return column &&
      typeof column === 'object' &&
      COLUMN_KEYS.indexOf(column.key) >= 0 &&
      typeof column.label === 'string'
  })
  if (!columnsValid) return false

  var sectionsValid = value.sections.every(function (section) {
    return section &&
      typeof section === 'object' &&
      typeof section.key === 'string' &&
      typeof section.title === 'string' &&
      Array.isArray(section.rows) &&
      section.rows.every(function (row) {
        return row &&
          typeof row === 'object' &&
          typeof row.key === 'string' &&
          typeof row.name === 'string' &&
          isStringRecord(row.values)
      })
  })
  if (!sectionsValid) return false

  return value.noteItems.every(function (item) { return typeof item === 'string' })
}

function resolveMembershipBenefitsMatrix(value) {
  return isMembershipBenefitsMatrix(value) ? value : fallbackBenefitsMatrix
}

function toMiniProgramSections(matrix) {
  return matrix.sections.map(function (section) {
    return {
      title: section.title,
      items: section.rows.map(function (row) {
        return {
          name: row.name,
          visitor: row.values.guest === '不可用' ? '-' : row.values.guest,
          free: row.values.free === '不可用' ? '-' : row.values.free,
          personal: row.values.personal === '不限次' ? '不限' : row.values.personal,
          pro: row.values.pro === '不限次' ? '不限' : row.values.pro,
        }
      }),
    }
  })
}

module.exports = {
  fallbackBenefitsMatrix,
  isMembershipBenefitsMatrix,
  resolveMembershipBenefitsMatrix,
  toMiniProgramSections,
}
