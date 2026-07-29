/**
 * 小程序端模拟数据与报告生成
 * @date   2026-03-21
 */
export type LibraryKey = 'national' | 'group'

export type StandardRecord = {
  id: string
  library: LibraryKey
  code: string
  title: string
  subtitle: string
  organization: string
  society?: string
  status: '现行' | '即将实施' | '已废止' | '被替代'
  publishDate: string
  implementDate: string
  ccs: string
  ics: string
  icsPath?: string[]
  summary: string
  accessType: 'metadata' | 'abstract' | 'chapter' | 'fulltext'
  fulltextAvailable: boolean
  previewPrice?: number
  downloadPrice?: number
  source?: 'mock' | 'openstd'
  tags: string[]
  highlights: string[]
  chapters: Array<{ id: string; title: string; locked?: boolean; paragraphs: string[] }>
  timeline: Array<{ code: string; label: string; year: string; state: 'history' | 'current' }>
  officialPreviewUrl?: string
  officialDownloadUrl?: string
}

export type IcsCatalogNode = {
  code: string
  name: string
  count: number
  children?: IcsCatalogNode[]
}

export const membershipPlans = [
  {
    id: 'personal',
    name: '个人包年会员',
    price: 598,
    originalPrice: 998,
    priceUnit: 59800,
    unit: '年',
    color: '#1677ff',
    bg: '#f0f5ff',
    badge: '',
    description: '面向个人用户的完整能力包。',
    features: ['知识库检索与详情页不限次', '呼叫小智对话与一句话生架构不限次', '标准框架生成 3 次/天', '全库相似度分析 10 次/年'],
    note: '一对一比对不限次（所有登录用户均可使用）。'
  },
  {
    id: 'pro',
    name: '专业包年会员',
    price: 998,
    originalPrice: 1698,
    priceUnit: 99800,
    unit: '年',
    color: '#faad14',
    bg: 'linear-gradient(180deg, #fffbe6 0%, #fff 40%)',
    badge: '推荐',
    description: '在个人会员基础上升级的专业能力。',
    features: ['包含个人会员全部权益', '标准框架生成不限次', '全库相似度分析不限次', '专属客服'],
    note: '一对一比对不限次（所有登录用户均可使用）。'
  },
]

export const heroStats: { label: string; value: string }[] = []

export const announcements = [
  { id: 'notice-1', title: '国家标准近期公告更新', date: '2026-03-09' },
  { id: 'notice-2', title: '团体标准合作学会上线批次新增 42 份', date: '2026-03-08' },
  { id: 'notice-3', title: '文档比对规则引擎升级完成', date: '2026-03-06' }
]

export const icsCatalog: IcsCatalogNode[] = [
  {
    code: '13',
    name: '环保、保健和安全',
    count: 1397,
    children: [
      {
        code: '13.020',
        name: '环境保护',
        count: 32,
        children: [
          { code: '13.020.01', name: '环境和环境保护综合', count: 8 },
          { code: '13.020.10', name: '环境管理', count: 5 },
          { code: '13.020.20', name: '环境经济', count: 4 }
        ]
      },
      {
        code: '13.220',
        name: '消防',
        count: 184,
        children: [
          { code: '13.220.01', name: '消防综合', count: 18 },
          { code: '13.220.20', name: '防火', count: 22 },
          { code: '13.220.50', name: '建筑材料和构件的阻燃与燃烧性能', count: 11 }
        ]
      }
    ]
  },
  {
    code: '43',
    name: '道路车辆工程',
    count: 267,
    children: [
      {
        code: '43.040',
        name: '道路车辆装置',
        count: 79,
        children: [
          { code: '43.040.10', name: '电气和电子设备', count: 9 },
          { code: '43.040.40', name: '制动系统', count: 6 },
          { code: '43.040.60', name: '车身及车身构件', count: 8 }
        ]
      }
    ]
  },
  {
    code: '67',
    name: '食品技术',
    count: 581,
    children: [
      {
        code: '67.040',
        name: '食品综合',
        count: 42,
        children: [{ code: '67.040', name: '食品综合', count: 42 }]
      },
      {
        code: '67.100',
        name: '奶和奶制品',
        count: 21,
        children: [
          { code: '67.100.01', name: '奶和奶制品综合', count: 6 },
          { code: '67.100.10', name: '牛奶及加工奶制品', count: 8 },
          { code: '67.100.30', name: '冰淇淋和冰冻甜食', count: 2 }
        ]
      }
    ]
  },
  {
    code: '91',
    name: '建筑材料和建筑物',
    count: 164,
    children: [
      {
        code: '91.040',
        name: '建筑物',
        count: 12,
        children: [
          { code: '91.040.01', name: '建筑物综合', count: 3 },
          { code: '91.040.10', name: '公共建筑物', count: 2 },
          { code: '91.040.30', name: '住宅建筑', count: 3 }
        ]
      },
      {
        code: '91.120',
        name: '建筑物的防护',
        count: 17,
        children: [
          { code: '91.120.10', name: '建筑物绝热', count: 5 },
          { code: '91.120.20', name: '建筑物声学', count: 3 },
          { code: '91.120.25', name: '地震和振动防护', count: 2 }
        ]
      }
    ]
  }
]

export const standards: StandardRecord[] = [
  {
    id: 'gb-48001-2026',
    source: 'openstd',
    library: 'national',
    code: 'GB 48001-2026',
    title: '汽车车门把手安全技术要求',
    subtitle: '国家标准库 / 官方预览样本',
    organization: '工业和信息化部',
    status: '即将实施',
    publishDate: '2026-01-28',
    implementDate: '2027-01-01',
    ccs: 'T26',
    ics: '43.040.60',
    icsPath: ['43', '43.040', '43.040.60'],
    summary: '来自国家标准信息公共服务平台，可跳转官方渠道获取。',
    accessType: 'fulltext',
    fulltextAvailable: true,
    tags: ['官方样本', '支持预览'],
    highlights: ['官方渠道获取', '道路车辆工程'],
    chapters: [
      { id: 'official', title: '官方预览', paragraphs: ['当前接入官方正文预览链接。'] }
    ],
    timeline: [{ code: 'GB 48001-2026', label: '汽车车门把手安全技术要求', year: '2026', state: 'current' }],
    officialPreviewUrl: 'http://c.gb688.cn/bzgk/gb/showGb?type=online&hcno=EB81F5A0707CB0422AF5FDB4CAA85174',
    officialDownloadUrl: 'http://c.gb688.cn/bzgk/gb/showGb?type=download&hcno=EB81F5A0707CB0422AF5FDB4CAA85174'
  },
  {
    id: 'gb-50016-2014-2018',
    library: 'national',
    code: 'GB 50016-2014（2018版）',
    title: '建筑设计防火规范',
    subtitle: '国家标准库 / 建筑防火',
    organization: '住房和城乡建设部',
    status: '现行',
    publishDate: '2018-03-27',
    implementDate: '2018-10-01',
    ccs: 'P16',
    ics: '13.220.50',
    icsPath: ['13', '13.220', '13.220.50'],
    summary: '适用于工业与民用建筑防火设计，是建筑设计、审查与验收常用基准规范。',
    accessType: 'chapter',
    fulltextAvailable: true,
    previewPrice: 29,
    downloadPrice: 89,
    tags: ['建筑', '消防', '国标公开'],
    highlights: ['替代关系完整', '章节预览可读', '可加入比对'],
    chapters: [
      { id: 'c1', title: '1 总则', paragraphs: ['本规范用于建筑防火设计的通用要求。', '涉及特殊工艺建筑时，应结合专项规范共同使用。'] },
      { id: 'c2', title: '3 厂房和仓库', paragraphs: ['厂房耐火等级、层数和面积应依据火灾危险性类别综合确定。'] },
      { id: 'c3', title: '5 民用建筑', paragraphs: ['高层公共建筑应设置避难层、消防电梯及自动灭火系统。'] }
    ],
    timeline: [
      { code: 'GBJ 16-87', label: '建筑设计防火规范', year: '1987', state: 'history' },
      { code: 'GB 50016-2006', label: '建筑设计防火规范', year: '2006', state: 'history' },
      { code: 'GB 50016-2014（2018版）', label: '建筑设计防火规范', year: '2018', state: 'current' }
    ]
  },
  {
    id: 'gb-t-19001-2016',
    library: 'national',
    code: 'GB/T 19001-2016',
    title: '质量管理体系 要求',
    subtitle: '国家标准库 / 质量体系',
    organization: '国家市场监督管理总局',
    status: '现行',
    publishDate: '2016-12-30',
    implementDate: '2017-07-01',
    ccs: 'A00',
    ics: '03.120.10',
    summary: '等同采用 ISO 9001:2015，是质量管理体系建立、认证与审查的核心依据。',
    accessType: 'metadata',
    fulltextAvailable: false,
    tags: ['质量管理', '体系', '仅元数据'],
    highlights: ['支持标准号快搜', '替代链可查', '详情含元数据'],
    chapters: [{ id: 'c1', title: '目录', paragraphs: ['本标准包括范围、规范性引用文件、术语和定义、质量管理体系要求等章节。'] }],
    timeline: [
      { code: 'GB/T 19001-2008', label: '质量管理体系 要求', year: '2008', state: 'history' },
      { code: 'GB/T 19001-2016', label: '质量管理体系 要求', year: '2016', state: 'current' }
    ]
  },
  {
    id: 't-cecs-10216-2024',
    library: 'group',
    code: 'T/CECS 10216-2024',
    title: '既有工业建筑低碳改造评价标准',
    subtitle: '团体标准库 / 学会授权',
    organization: '中国工程建设标准化协会',
    society: '中国工程建设标准化协会',
    status: '现行',
    publishDate: '2024-02-06',
    implementDate: '2024-04-01',
    ccs: 'P30',
    ics: '91.040.01',
    icsPath: ['91', '91.040', '91.040.01'],
    summary: '面向工业建筑节能改造项目，提供评价指标体系和分级规则。',
    accessType: 'fulltext',
    fulltextAvailable: true,
    previewPrice: 19,
    downloadPrice: 69,
    tags: ['独家团标', '低碳改造', '学会合作'],
    highlights: ['按次查阅付费', '专题馆资源', '可用于项目立项比对'],
    chapters: [
      { id: 'c1', title: '4 评价指标', paragraphs: ['评价体系从能效、碳排、材料循环、运维效率四个维度展开。'] },
      { id: 'c2', title: '6 分级方法', paragraphs: ['评分采用基础项与增项结合的方式。'] }
    ],
    timeline: [{ code: 'T/CECS 10216-2024', label: '既有工业建筑低碳改造评价标准', year: '2024', state: 'current' }]
  },
  {
    id: 't-cas-608-2023',
    library: 'group',
    code: 'T/CAS 608-2023',
    title: '预制菜冷链配送服务规范',
    subtitle: '团体标准库 / 食品冷链',
    organization: '中国标准化协会',
    society: '中国标准化协会',
    status: '现行',
    publishDate: '2023-09-18',
    implementDate: '2023-10-15',
    ccs: 'X10',
    ics: '67.040',
    icsPath: ['67', '67.040', '67.040'],
    summary: '围绕预制菜仓储、温控、配送和交付建立服务规范。',
    accessType: 'abstract',
    fulltextAvailable: true,
    previewPrice: 15,
    downloadPrice: 49,
    tags: ['冷链', '预制菜', '摘要公开'],
    highlights: ['摘要公开', '可单次购买', '食品行业热门'],
    chapters: [
      { id: 'c1', title: '前言', paragraphs: ['本文件规定了预制菜冷链配送服务的基本要求、过程控制和服务评价。'] },
      { id: 'c2', title: '5 过程控制', locked: true, paragraphs: ['冷链运输期间宜保持全程温湿度可追溯。'] }
    ],
    timeline: [{ code: 'T/CAS 608-2023', label: '预制菜冷链配送服务规范', year: '2023', state: 'current' }]
  }
]

export function listStandards(params: {
  library?: string
  keyword?: string
  status?: string
  ics?: string
  society?: string
}) {
  const keyword = params.keyword?.trim().toLowerCase()
  return standards.filter((item) => {
    if (params.library && item.library !== params.library) return false
    if (params.status && item.status !== params.status) return false
    if (params.ics && !(item.ics === params.ics || item.icsPath?.includes(params.ics))) return false
    if (params.society && item.society !== params.society) return false
    if (!keyword) return true
    return [item.code, item.title, item.summary, item.organization, item.society].filter(Boolean).some((field) =>
      String(field).toLowerCase().includes(keyword)
    )
  })
}

export function getStandardById(id: string) {
  return standards.find((item) => item.id === id) || null
}

export function buildCompareReport(params: {
  taskNo: string
  documentName: string
  selectedStandardIds: string[]
  compareMode: string
}) {
  const targets = standards.filter((item) => params.selectedStandardIds.includes(item.id))
  const similarStandards = (targets.length ? targets : standards.filter((item) => item.library === 'group').slice(0, 2)).map(
    (item, index) => ({
      code: item.code,
      title: item.title,
      type: item.library === 'group' ? '团标' : '国标',
      titleSimilarity: 72 + index * 6,
      scopeSimilarity: 65 + index * 5,
      chapterSimilarity: 68 + index * 4,
      textSimilarity: 70 + index * 7,
      overallSimilarity: 74 + index * 5
    })
  )

  return {
    taskNo: params.taskNo,
    reportCode: `BZ-${params.taskNo.replace(/^CMP-/, '')}`,
    documentName: params.documentName,
    status: '分析完成',
    category: targets[0]?.icsPath?.join(' / ') || '食品技术 / 67.040',
    compareMode: params.compareMode,
    freeRisk: [
      '检测到 3 条已废止引用标准，建议优先修订引用清单。',
      '命中 2 条高相似度标准，存在重复建设风险。',
      '第 5 章和第 6 章存在悬置段，建议补齐章节归属。'
    ],
    summaryMetrics: [
      { label: '最高综合相似度', value: '78%', accent: 'orange', detail: '与团标和公开国标均存在高相似条款' },
      { label: '引用规范性问题', value: '6 项', accent: 'red', detail: '含 3 条作废标准、2 条题名错误、1 条未匹配' },
      { label: '术语疑似问题', value: '4 项', accent: 'teal', detail: '冷链履约、交付时效等术语定义不统一' },
      { label: '正文重复率', value: '31%', accent: 'blue', detail: '重点集中于配送要求和温控章节' }
    ],
    similarStandards,
    citationIssues: [
      {
        sourceCode: 'GB/T 19001-2008',
        sourceTitle: '质量管理体系 要求',
        matchedCode: 'GB/T 19001-2016',
        matchedTitle: '质量管理体系 要求',
        validity: '已废止',
        replacement: 'GB/T 19001-2016',
        result: '引用的标准已作废；可查到替代标准'
      }
    ],
    termIssues: [
      { term: '冷链履约', source: '企业文档术语', issue: '缺少来源标准号', suggestion: '补充标准来源或改用标准术语' },
      { term: '交付时效', source: '企业文档术语', issue: '术语相似', suggestion: '与现行团标定义不一致，建议统一' }
    ],
    duplicateParagraphs: [
      { section: '5.2 温控要求', similarity: 91, risk: '高重复' },
      { section: '6.1 配送流程', similarity: 84, risk: '中高重复' }
    ],
    hangingSections: [
      { section: '附录前说明段', reason: '未归属到明确章节', action: '建议归入前言或附录说明' },
      { section: '6 章尾部补充段', reason: '标题层级缺失', action: '建议补齐 6.3 小节标题' }
    ],
    parsedCategories: [
      { name: '范围与适用对象', description: '识别标准适用边界、对象、场景与排除项。', matched: true },
      { name: '规范性引用文件', description: '抽取文中引用的国标、行标、团标及版本信息。', matched: true },
      { name: '术语和定义', description: '识别术语列表、定义语句和来源标准号。', matched: true },
      { name: '技术要求', description: '提取核心要求条款、指标阈值和限制性描述。', matched: true },
      { name: '试验方法/验证方法', description: '识别检测方法、试验步骤和判定方式。', matched: true },
      { name: '检验规则与附录', description: '识别抽样规则、判定规则、附录与模板内容。', matched: false }
    ],
    tabs: [
      {
        key: 'overall',
        label: '总体结论',
        intro: '先给出是否建议继续使用当前草案的结论。',
        conclusions: [
          '当前草案不建议直接作为送审版本使用，需先完成引用标准和章节结构修订。',
          '整体内容已具备标准文本雏形，但核心条款仍偏业务说明书表达，不够标准化。',
          '建议优先修正引用文件、术语定义和正文层级。'
        ]
      },
      {
        key: 'structure',
        label: '结构完整性',
        intro: '检查固定结构类别是否齐全，以及每一类是否具备标准写法。',
        conclusions: [
          '“范围与适用对象”“规范性引用文件”“技术要求”三类已识别完整，可继续沿用。',
          '“检验规则与附录”信息不足，说明文档末尾仍缺少标准化收尾结构。',
          '建议补充检验规则、判定逻辑和附录模板。'
        ]
      },
      {
        key: 'citation',
        label: '引用文件',
        intro: '关注是否引用错误、作废或格式异常。',
        conclusions: [
          '已识别 6 条引用文件，其中 3 条存在版本或标准号问题。',
          '存在将旧版团标和现行版国标混用的情况，会影响送审合规性。',
          '建议将引用文件逐条校正到现行版本，并统一中文题名写法。'
        ]
      },
      {
        key: 'terms',
        label: '术语定义',
        intro: '关注术语是否有来源、定义是否可执行。',
        conclusions: [
          '部分术语更像业务口径，不是标准术语，容易在评审时被指出不规范。',
          '“冷链履约”“交付时效”两项定义缺少阈值，执行边界不清晰。',
          '建议优先改写为行业内已有标准术语，并补足来源标准号。'
        ]
      },
      {
        key: 'risk',
        label: '重复与风险',
        intro: '关注正文复用程度和潜在立项风险。',
        conclusions: [
          '第 5 章配送要求与现有团标文本高度接近，重复风险偏高。',
          '若以当前文本立项，存在与既有团标区分度不足的评审风险。',
          '建议对高重复段落做重写，并强化本标准独有的服务边界和管理要求。'
        ]
      }
    ]
  }
}
