/**
 * 模拟数据
 * @date   2026-03-21
 */
const heroStats = [
  { label: '标准元数据', value: '可检索' },
  { label: '技术委员会', value: '1800+' },
  { label: '注册用户', value: '-' }
]

const notices = [
  { id: 'n1', title: '【新增】2026年3月新标准上线', date: '2026-03-08' },
  { id: 'n2', title: '国家标准委发布最新标准目录', date: '2026-03-05' }
]

const membershipPlans = [
  {
    id: 'personal',
    name: '个人会员',
    price: 598,
    originPrice: 898,
    features: ['标准元数据不限次检索', '公开范围标准摘要查阅', '标准官方渠道导航', '标准状态更新提醒', '全库相似度分析 10 次/年（含分析报告）'],
    note: '一对一比对为会员专属功能。不含团标授权阅读权益。'
  },
  {
    id: 'pro',
    name: '专业会员',
    price: 998,
    originPrice: 1598,
    badge: '推荐',
    features: ['个人会员全部权益', '全库相似度分析不限次（含分析报告）', '已授权团体标准摘要查阅', '标准官方渠道导航', '标准状态更新提醒', '专属客服支持'],
    note: '团标阅读和获取方式以官方开放范围和平台授权范围为准。'
  },
  {
    id: 'enterprise',
    name: '企业版',
    price: 0,
    features: ['多席位协作管理', '私有标准库接入', '定制化标准服务', '采购与发票支持'],
    note: '适合机构统一采购、团队协作和企业内部标准能力建设。'
  }
]

const standards = [
  {
    id: 'gbt-1-1-2020',
    library: 'national',
    category: 'national',
    code: 'GB/T 1.1-2020',
    title: '标准化工作导则 第1部分：标准化文件的结构和起草规则',
    status: '现行',
    typeLabel: '推荐性国家标准',
    publishDate: '2020-03-31',
    implementDate: '2020-04-01',
    organization: '国家市场监督管理总局、国家标准化管理委员会',
    ccs: 'A00',
    ics: '01.120',
    pages: 56,
    summary: '适用于标准化文件的结构、编写和表述规则，是标准起草与审查的基础规范。',
    downloadPrice: 28,
    previewPrice: 0,
    canPreview: true,
    canDownload: true,
    deliveryMode: 'official_redirect',
    copyrightStatus: 'official_open',
    copyrightLabel: '官方公开范围',
    accessLabel: '官方来源',
    accessTone: 'blue',
    sourceLabel: '国家标准全文公开系统',
    accessNotice: '该标准全文访问以官方公开范围为准。平台当前不缓存、不二次分发受版权限制的全文内容，可查看元数据、摘要与官方来源入口。',
    replacement: '本标准替代 GB/T 1.1-2009',
    committeeId: 'tc-standardization',
    committeeCode: 'SAC/TC 1',
    committeeName: '全国标准化原理与方法标准化技术委员会',
    industryKey: 'general',
    industryName: '通用基础',
    relationCount: 5
  },
  {
    id: 'gb-5749-2022',
    library: 'national',
    category: 'national',
    code: 'GB 5749-2022',
    title: '生活饮用水卫生标准',
    status: '即将实施',
    typeLabel: '强制性标准',
    publishDate: '2022-10-01',
    implementDate: '2023-04-01',
    organization: '国家卫生健康委员会',
    ccs: 'C51',
    ics: '13.060.20',
    pages: 42,
    summary: '围绕生活饮用水卫生指标和监测要求建立统一规范。',
    downloadPrice: 28,
    previewPrice: 0,
    canPreview: true,
    canDownload: true,
    deliveryMode: 'metadata_only',
    copyrightStatus: 'restricted',
    copyrightLabel: '受版权限制',
    accessLabel: '目录/摘要',
    accessTone: 'orange',
    sourceLabel: '官方来源获取指引',
    accessNotice: '当前仅展示元数据、目录和摘要信息。未获得平台内全文授权前，不提供正文缓存或下载分发，需按官方来源或采购指引获取。',
    replacement: '本标准替代 GB 5749-2006',
    committeeId: 'tc-drinking-water',
    committeeCode: 'SAC/TC 414',
    committeeName: '全国饮用水卫生标准化技术委员会',
    industryKey: 'water',
    industryName: '饮用水与公共卫生',
    relationCount: 4
  },
  {
    id: 't-cecs-10001-2020',
    library: 'group',
    category: 'group',
    code: 'T/CECS 10001-2020',
    title: '建筑给水排水设计标准',
    status: '现行',
    typeLabel: '独家',
    publishDate: '2020-08-01',
    implementDate: '2020-10-01',
    organization: '中国工程建设标准化协会',
    ccs: 'P40',
    ics: '91.140.60',
    pages: 63,
    summary: '本标准规定了建筑给水排水系统的设计原则、基本要求和技术措施。',
    downloadPrice: 69,
    previewPrice: 19,
    canPreview: true,
    canDownload: true,
    deliveryMode: 'platform_download',
    copyrightStatus: 'licensed',
    copyrightLabel: '已获授权',
    accessLabel: '授权下载',
    accessTone: 'green',
    sourceLabel: '学会授权分发',
    accessNotice: '标准全文获取请通过官方渠道。当前样例展示标准元数据与摘要信息。',
    committeeId: 'tc-building-water',
    committeeCode: 'CECS/TC 64',
    committeeName: '中国工程建设标准化协会建筑给水排水专业委员会',
    industryKey: 'building',
    industryName: '建筑工程',
    relationCount: 6
  },
  {
    id: 't-cab-0001-2018',
    library: 'group',
    category: 'group',
    code: 'T/CAB 0001-2018',
    title: '建筑碳排放计算标准',
    status: '现行',
    typeLabel: '团体标准',
    publishDate: '2018-01-01',
    implementDate: '2018-03-01',
    organization: '中国建筑节能协会',
    ccs: 'P30',
    ics: '91.040.01',
    pages: 38,
    summary: '规定了建筑碳排放的计算方法和评价指标。',
    downloadPrice: 49,
    previewPrice: 15,
    canPreview: true,
    canDownload: true,
    deliveryMode: 'platform_read',
    copyrightStatus: 'licensed',
    copyrightLabel: '已获授权',
    accessLabel: '授权阅读',
    accessTone: 'purple',
    sourceLabel: '合作团标专区',
    accessNotice: '该团标已取得平台内阅读授权，但下载权限需以具体授权范围判断。当前样例提供平台内阅读和获取方式说明。',
    committeeId: 'tc-building-carbon',
    committeeCode: 'CAB/TC 12',
    committeeName: '中国建筑节能协会建筑碳管理标准工作组',
    industryKey: 'building',
    industryName: '建筑工程',
    relationCount: 4
  },
  {
    id: 'jb-t-10001-2021',
    library: 'national',
    category: 'industry',
    code: 'JB/T 10001-2021',
    title: '工业泵用机械密封技术条件',
    status: '现行',
    typeLabel: '行业标准',
    publishDate: '2021-06-01',
    implementDate: '2021-10-01',
    organization: '工业和信息化部',
    ccs: 'J16',
    ics: '23.080',
    pages: 24,
    summary: '规定工业泵用机械密封的技术要求、检验方法和验收规则。',
    downloadPrice: 0,
    previewPrice: 0,
    canPreview: false,
    canDownload: false,
    deliveryMode: 'purchase_guide',
    copyrightStatus: 'restricted',
    copyrightLabel: '受版权限制',
    accessLabel: '获取方式',
    accessTone: 'orange',
    sourceLabel: '行业标准采购指引',
    accessNotice: '该行业标准当前仅提供元数据、摘要与采购获取方式，不提供平台内正文阅读或下载。',
    committeeId: 'tc-mechanical-seal',
    committeeCode: 'SAC/TC 74/SC 1',
    committeeName: '全国泵标准化技术委员会机械密封分技术委员会',
    industryKey: 'machinery',
    industryName: '装备制造',
    relationCount: 3
  },
  {
    id: 'db31-t-1001-2024',
    library: 'national',
    category: 'local',
    code: 'DB31/T 1001-2024',
    title: '公共建筑节能运行管理规范',
    status: '现行',
    typeLabel: '地方标准',
    publishDate: '2024-05-10',
    implementDate: '2024-09-01',
    organization: '上海市市场监督管理局',
    ccs: 'P31',
    ics: '91.120.10',
    pages: 30,
    summary: '适用于公共建筑节能运行管理与能耗监测评价。',
    downloadPrice: 0,
    previewPrice: 0,
    canPreview: false,
    canDownload: false,
    deliveryMode: 'official_redirect',
    copyrightStatus: 'official_open',
    copyrightLabel: '官方公开范围',
    accessLabel: '官方来源',
    accessTone: 'blue',
    sourceLabel: '地方标准公开平台',
    accessNotice: '该地方标准访问方式以地方标准公开平台为准，平台提供元数据与官方来源跳转。',
    committeeId: 'tc-building-energy',
    committeeCode: 'DB31/TC 09',
    committeeName: '上海市公共建筑节能标准技术委员会',
    industryKey: 'building',
    industryName: '建筑工程',
    relationCount: 4
  },
  {
    id: 'q-abc-002-2025',
    library: 'national',
    category: 'enterprise',
    code: 'Q/ABC 002-2025',
    title: '食品接触材料内部控制规范',
    status: '待评审',
    typeLabel: '企业标准',
    publishDate: '2025-12-01',
    implementDate: '暂未实施',
    organization: '某制造企业标准委员会',
    ccs: 'X09',
    ics: '67.250',
    pages: 18,
    summary: '企业内部使用的产品控制规范，当前处于评审阶段。',
    downloadPrice: 0,
    previewPrice: 0,
    canPreview: false,
    canDownload: false,
    deliveryMode: 'metadata_only',
    copyrightStatus: 'restricted',
    copyrightLabel: '仅元数据展示',
    accessLabel: '题录信息',
    accessTone: 'orange',
    sourceLabel: '企业标准备案信息',
    accessNotice: '企业标准当前仅展示备案元数据，不展示正文全文。',
    committeeId: 'tc-food-contact',
    committeeCode: 'QB/TC 203',
    committeeName: '食品接触材料企业标准技术工作组',
    industryKey: 'food',
    industryName: '食品与包装',
    relationCount: 2
  },
  {
    id: 'iso-22000-2018',
    library: 'national',
    category: 'international',
    code: 'ISO 22000:2018',
    title: 'Food safety management systems — Requirements for any organization in the food chain',
    status: '现行',
    typeLabel: '国际标准',
    publishDate: '2018-06-19',
    implementDate: '2018-06-19',
    organization: 'ISO',
    ccs: 'A00',
    ics: '03.100.70',
    pages: 39,
    summary: '食品安全管理体系国际标准，适用于食品链条中的组织。',
    downloadPrice: 0,
    previewPrice: 0,
    canPreview: false,
    canDownload: false,
    deliveryMode: 'purchase_guide',
    copyrightStatus: 'restricted',
    copyrightLabel: '受版权限制',
    accessLabel: '购买指引',
    accessTone: 'orange',
    sourceLabel: '国际标准购买渠道',
    accessNotice: '国际标准与采标标准正文受版权限制，平台仅展示题录、摘要与获取指引。',
    committeeId: 'tc-food-systems',
    committeeCode: 'ISO/TC 34',
    committeeName: 'ISO 食品产品技术委员会',
    industryKey: 'food',
    industryName: '食品与包装',
    relationCount: 3
  }
]

const committees = [
  {
    id: 'tc-standardization',
    code: 'SAC/TC 1',
    name: '全国标准化原理与方法标准化技术委员会',
    secretariat: '中国标准化研究院',
    scope: '标准化原理、方法、术语和文件结构',
    nationalCount: 46,
    industryCount: 5,
    planCount: 8,
    standardIds: ['gbt-1-1-2020']
  },
  {
    id: 'tc-drinking-water',
    code: 'SAC/TC 414',
    name: '全国饮用水卫生标准化技术委员会',
    secretariat: '中国疾病预防控制中心环境所',
    scope: '饮用水卫生指标、检测方法和参考评价',
    nationalCount: 12,
    industryCount: 2,
    planCount: 3,
    standardIds: ['gb-5749-2022']
  },
  {
    id: 'tc-building-water',
    code: 'CECS/TC 64',
    name: '中国工程建设标准化协会建筑给水排水专业委员会',
    secretariat: '中国建筑设计研究院有限公司',
    scope: '建筑给排水、消防给水和管网系统设计',
    nationalCount: 9,
    industryCount: 4,
    planCount: 2,
    standardIds: ['t-cecs-10001-2020']
  },
  {
    id: 'tc-building-carbon',
    code: 'CAB/TC 12',
    name: '中国建筑节能协会建筑碳管理标准工作组',
    secretariat: '中国建筑节能协会',
    scope: '建筑碳排放核算、节能评价和绿色低碳标准',
    nationalCount: 6,
    industryCount: 3,
    planCount: 2,
    standardIds: ['t-cab-0001-2018', 'db31-t-1001-2024']
  },
  {
    id: 'tc-mechanical-seal',
    code: 'SAC/TC 74/SC 1',
    name: '全国泵标准化技术委员会机械密封分技术委员会',
    secretariat: '沈阳水泵研究所有限公司',
    scope: '泵类产品、机械密封和配套测试规范',
    nationalCount: 18,
    industryCount: 20,
    planCount: 4,
    standardIds: ['jb-t-10001-2021']
  },
  {
    id: 'tc-food-contact',
    code: 'QB/TC 203',
    name: '食品接触材料企业标准技术工作组',
    secretariat: '某食品材料研究中心',
    scope: '食品接触材料、包装安全和企业内部控制',
    nationalCount: 4,
    industryCount: 1,
    planCount: 2,
    standardIds: ['q-abc-002-2025']
  },
  {
    id: 'tc-food-systems',
    code: 'ISO/TC 34',
    name: 'ISO 食品产品技术委员会',
    secretariat: 'ISO Central Secretariat',
    scope: '食品链管理、食品安全体系和国际标准协调',
    nationalCount: 0,
    industryCount: 0,
    planCount: 5,
    standardIds: ['iso-22000-2018']
  }
]

const knowledgeGraphs = {
  'gbt-1-1-2020': {
    summary: '围绕标准化文件结构建立起草、术语与编写规则的基础图谱。',
    replacementChain: [
      { code: 'GB/T 1.1-2009', title: '标准化工作导则 旧版' },
      { code: 'GB/T 1.1-2020', title: '标准化工作导则 第1部分', current: true }
    ],
    relatedNodes: [
      { code: 'GB/T 20000.1-2014', title: '标准化工作指南 第1部分', relation: '方法关联' },
      { code: 'GB/T 20001.5-2017', title: '标准编写规则 第5部分', relation: '编写关联' },
      { code: 'GB/T 20004.1-2016', title: '团体标准化工作导则', relation: '应用关联' }
    ],
    libraryRefs: ['t-cecs-10001-2020'],
    citedSummary: '作为标准起草基础规范，常被团体标准和企业标准的编写规则引用。 '
  },
  'gb-5749-2022': {
    summary: '围绕饮用水卫生安全形成现行标准、检测方法和公共卫生管理的关系链。',
    replacementChain: [
      { code: 'GB 5749-2006', title: '生活饮用水卫生标准 旧版' },
      { code: 'GB 5749-2022', title: '生活饮用水卫生标准', current: true }
    ],
    relatedNodes: [
      { code: 'GB/T 5750.1-2023', title: '生活饮用水标准检验方法 总则', relation: '检验方法' },
      { code: 'WS/T 1000-2024', title: '饮用水卫生风险评估指南', relation: '卫生配套' },
      { code: 'CJ/T 206-2022', title: '城镇供水水质监测', relation: '运行关联' }
    ],
    libraryRefs: ['iso-22000-2018'],
    citedSummary: '常与水质检测、供水运行和公共卫生评价标准配套引用。'
  },
  't-cecs-10001-2020': {
    summary: '以建筑给排水为核心，连接公共建筑、给水系统和相关节能标准。',
    replacementChain: [
      { code: 'T/CECS 10001-2020', title: '建筑给水排水设计标准', current: true }
    ],
    relatedNodes: [
      { code: 'GB 50015-2019', title: '建筑给水排水设计标准', relation: '国标对标' },
      { code: 'DB31/T 1001-2024', title: '公共建筑节能运行管理规范', relation: '运行联动' },
      { code: 'T/CAB 0001-2018', title: '建筑碳排放计算标准', relation: '低碳关联' }
    ],
    libraryRefs: ['t-cab-0001-2018', 'db31-t-1001-2024'],
    citedSummary: '适合团标/企标起草前做同类建筑标准关系摸底。'
  },
  't-cab-0001-2018': {
    summary: '围绕建筑碳核算、节能管理和公共建筑运行评价建立推荐关系。',
    replacementChain: [
      { code: 'T/CAB 0001-2018', title: '建筑碳排放计算标准', current: true }
    ],
    relatedNodes: [
      { code: 'GB/T 51366-2019', title: '建筑碳排放计算标准', relation: '计算方法' },
      { code: 'DB31/T 1001-2024', title: '公共建筑节能运行管理规范', relation: '节能运行' },
      { code: 'T/CECS 10001-2020', title: '建筑给水排水设计标准', relation: '工程配套' }
    ],
    libraryRefs: ['t-cecs-10001-2020', 'db31-t-1001-2024'],
    citedSummary: '可辅助建筑行业标准立项和低碳标准参考。'
  },
  'jb-t-10001-2021': {
    summary: '以机械密封为核心，关联泵类产品、试验规范和装备制造标准。',
    replacementChain: [
      { code: 'JB/T 10001-2021', title: '工业泵用机械密封技术条件', current: true }
    ],
    relatedNodes: [
      { code: 'GB/T 6556-2020', title: '机械密封型式与基本尺寸', relation: '结构关联' },
      { code: 'JB/T 4127-2021', title: '泵产品试验方法', relation: '试验关联' },
      { code: 'GB/T 9239.1-2021', title: '机械振动 转子平衡', relation: '制造关联' }
    ],
    libraryRefs: [],
    citedSummary: '适合装备制造行业做行标对标和比对目标选择。'
  },
  'db31-t-1001-2024': {
    summary: '连接地方节能管理、公共建筑运行和建筑碳核算标准。',
    replacementChain: [
      { code: 'DB31/T 1001-2024', title: '公共建筑节能运行管理规范', current: true }
    ],
    relatedNodes: [
      { code: 'T/CAB 0001-2018', title: '建筑碳排放计算标准', relation: '低碳衔接' },
      { code: 'T/CECS 10001-2020', title: '建筑给水排水设计标准', relation: '建筑配套' },
      { code: 'JGJ/T 154-2021', title: '公共建筑节能检测标准', relation: '检测关联' }
    ],
    libraryRefs: ['t-cecs-10001-2020', 't-cab-0001-2018'],
    citedSummary: '适合地方项目标准参考和建筑运维标准推荐。'
  },
  'q-abc-002-2025': {
    summary: '展示企业标准与食品安全、包装接触材料要求之间的关联。',
    replacementChain: [
      { code: 'Q/ABC 002-2025', title: '食品接触材料内部控制规范', current: true }
    ],
    relatedNodes: [
      { code: 'GB 4806.1-2016', title: '食品安全国家标准 食品接触材料及制品通用安全要求', relation: '法规依据' },
      { code: 'ISO 22000:2018', title: 'Food safety management systems', relation: '体系关联' }
    ],
    libraryRefs: ['iso-22000-2018'],
    citedSummary: '适合企业标准审查前做食品接触材料法规与体系标准梳理。'
  },
  'iso-22000-2018': {
    summary: '围绕食品安全管理体系，关联 HACCP、饮用水和企业内部控制标准。',
    replacementChain: [
      { code: 'ISO 22000:2005', title: 'Food safety management systems 旧版' },
      { code: 'ISO 22000:2018', title: 'Food safety management systems', current: true }
    ],
    relatedNodes: [
      { code: 'GB 5749-2022', title: '生活饮用水卫生标准', relation: '前提方案' },
      { code: 'Q/ABC 002-2025', title: '食品接触材料内部控制规范', relation: '企业落地' },
      { code: 'CAC/RCP 1-1969', title: '食品卫生通则', relation: '国际规则' }
    ],
    libraryRefs: ['gb-5749-2022', 'q-abc-002-2025'],
    citedSummary: '适合食品行业企业做管理体系和法规配套梳理。'
  }
}

const industryGroups = [
  {
    key: 'building',
    label: '建筑工程',
    subtitle: '公共建筑、节能、给排水与低碳管理',
    tags: ['公共建筑', '节能运行', '给排水'],
    standardIds: ['t-cecs-10001-2020', 't-cab-0001-2018', 'db31-t-1001-2024']
  },
  {
    key: 'machinery',
    label: '装备制造',
    subtitle: '泵类、密封、机械测试与制造配套标准',
    tags: ['机械密封', '试验方法', '制造工程'],
    standardIds: ['jb-t-10001-2021']
  },
  {
    key: 'food',
    label: '食品与包装',
    subtitle: '食品安全、接触材料和企业内部控制',
    tags: ['食品安全', '接触材料', '体系管理'],
    standardIds: ['q-abc-002-2025', 'iso-22000-2018']
  },
  {
    key: 'water',
    label: '饮用水与公共卫生',
    subtitle: '围绕供水、检测和公共卫生的高频标准组合',
    tags: ['水质监测', '卫生指标', '供水管理'],
    standardIds: ['gb-5749-2022']
  },
  {
    key: 'general',
    label: '通用基础',
    subtitle: '标准立项、起草和评审阶段的基础性标准推荐',
    tags: ['标准起草', '文件结构', '术语定义'],
    standardIds: ['gbt-1-1-2020']
  }
]

const compareTasks = [
  {
    id: 'CMP-20260309-018',
    name: '预制菜工厂 设计说明书-v3.docx',
    createdAt: '2026-03-09 03:32',
    status: '报告已生成',
    mode: '全库相似度分析',
    unlocked: true
  }
]

const report = {
  id: 'CMP-20260309-018',
  title: '标准化工作导则-比对报告',
  reportNo: 'R20250309001',
  riskCount: 23,
  items: [
    { name: '引用文件风险', count: 8, tone: 'red' },
    { name: '术语风险', count: 5, tone: 'orange' },
    { name: '正文重复风险', count: 7, tone: 'orange' },
    { name: '高相似度标准', count: 3, tone: 'yellow' }
  ]
}

const orders = [
  {
    id: 'O20250309143056789',
    type: 'membership',
    title: '专业会员',
    status: '已支付',
    amount: 598,
    createdAt: '2025-03-09 14:30',
    payableAmount: 598,
    channel: '微信支付'
  },
  {
    id: 'O20250308101512345',
    type: 'download',
    title: 'GB/T 1.1-2020 标准',
    status: '已支付',
    amount: 28,
    createdAt: '2025-03-08 10:15',
    payableAmount: 28,
    channel: '微信支付'
  },
  {
    id: 'O20250307162088990',
    type: 'compare',
    title: '文档比对报告',
    status: '待支付',
    amount: 99,
    createdAt: '2025-03-07 16:20',
    payableAmount: 99,
    channel: '待支付'
  }
]

const bookingRecords = [
  {
    id: 'BK-001',
    title: '标准编制咨询',
    status: '已联系',
    createdAt: '2025-03-08 10:30',
    desc: '需要关于建筑行业团体标准的编制指导'
  },
  {
    id: 'BK-002',
    title: '技术审查服务',
    status: '待联系',
    createdAt: '2025-03-09 09:15',
    desc: '标准草案需要进行专业技术审查'
  }
]

const icsRootSeeds = [
  ['01', '通用、术语、标准化、文件'],
  ['03', '社会学、服务、公司（企业）组织与管理、行政、运输'],
  ['07', '数学、自然科学'],
  ['11', '卫生保健技术'],
  ['13', '环境、健康保护、安全'],
  ['17', '计量和测量、物理现象'],
  ['19', '试验'],
  ['21', '机械系统和通用件'],
  ['23', '流体系统和通用件'],
  ['25', '制造工程'],
  ['27', '能源和热传导工程'],
  ['29', '电气工程'],
  ['31', '电子学'],
  ['33', '电信、音频和视频工程'],
  ['35', '信息技术、办公机械'],
  ['37', '成像技术'],
  ['39', '精密机械、珠宝'],
  ['43', '道路车辆工程'],
  ['45', '铁路工程'],
  ['47', '造船和海洋结构物'],
  ['49', '航空器和航天器工程'],
  ['53', '材料储运设备'],
  ['55', '货物包装和调运'],
  ['59', '纺织和皮革技术'],
  ['61', '服装工业'],
  ['65', '农业'],
  ['67', '食品技术'],
  ['71', '化工技术'],
  ['73', '采矿和矿产品'],
  ['75', '石油及相关技术'],
  ['77', '冶金'],
  ['79', '木材技术'],
  ['81', '玻璃和陶瓷工业'],
  ['83', '橡胶和塑料工业'],
  ['85', '造纸技术'],
  ['87', '涂料和颜料工业'],
  ['91', '建筑材料和建筑物'],
  ['93', '土木工程'],
  ['95', '军事工程'],
  ['97', '家用和商用设备、娱乐、体育']
]

const detailedIcsRoots = {
  '01': {
    children: [
      {
        code: '01.120',
        name: '标准化.总则',
        children: [
          { code: '01.120.01', name: '标准化总则' },
          { code: '01.120.10', name: '文件起草规则' },
          { code: '01.120.20', name: '术语与定义' }
        ]
      }
    ]
  },
  '35': {
    children: [
      {
        code: '35.020',
        name: '信息技术（IT）综合',
        children: [
          { code: '35.020.01', name: '信息技术基础通则' },
          { code: '35.020.10', name: '信息技术架构与治理' }
        ]
      },
      {
        code: '35.240',
        name: '信息技术应用',
        children: [
          { code: '35.240.15', name: '识别卡和有关装置应用' },
          { code: '35.240.50', name: '信息技术在工业中的应用' },
          { code: '35.240.99', name: '信息技术应用其他方面' }
        ]
      }
    ]
  },
  '67': {
    children: [
      {
        code: '67.040',
        name: '食品综合',
        children: [
          { code: '67.040.01', name: '食品综合要求' },
          { code: '67.040.10', name: '食品标签与通则' }
        ]
      }
    ]
  },
  '91': {
    children: [
      {
        code: '91.040',
        name: '建筑物',
        children: [
          { code: '91.040.01', name: '建筑物综合' },
          { code: '91.040.30', name: '住宅建筑' }
        ]
      },
      {
        code: '91.140',
        name: '建筑安装',
        children: [
          { code: '91.140.60', name: '给水系统' },
          { code: '91.140.65', name: '水加热设备' }
        ]
      }
    ]
  }
}

function buildPlaceholderChildren(code, name) {
  return [
    {
      code: `${code}.01`,
      name: `${name}综合`,
      children: [
        { code: `${code}.01.01`, name: `${name}通用要求` },
        { code: `${code}.01.10`, name: `${name}分类与术语` }
      ]
    },
    {
      code: `${code}.13`,
      name: `${name}应用`,
      children: [
        { code: `${code}.13.01`, name: `${name}应用规范` },
        { code: `${code}.13.10`, name: `${name}测试与评价` }
      ]
    }
  ]
}

const icsRoots = icsRootSeeds.map(([code, name]) => ({
  code,
  name,
  children: detailedIcsRoots[code]?.children || buildPlaceholderChildren(code, name)
}))

function findStandard(id) {
  return standards.find((item) => item.id === id)
}

function getStandardsByIds(ids) {
  return (ids || []).map(findStandard).filter(Boolean)
}

function findCommittee(id) {
  return committees.find((item) => item.id === id)
}

function getCommitteeStandards(committeeId, category) {
  return standards.filter((item) => {
    const matchCommittee = !committeeId || item.committeeId === committeeId
    const matchCategory = !category || category === 'all' || item.category === category
    return matchCommittee && matchCategory
  })
}

function getStandards(category, keyword, icsCode, committeeId) {
  return standards.filter((item) => {
    const matchCategory = !category || category === 'all' || item.category === category
    const query = (keyword || '').trim().toLowerCase()
    const haystack = [item.code, item.title, item.organization, item.committeeCode, item.committeeName]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    const matchKeyword = !query || haystack.includes(query)
    const matchIcs = !icsCode || item.ics.indexOf(icsCode) === 0
    const matchCommittee = !committeeId || item.committeeId === committeeId
    return matchCategory && matchKeyword && matchIcs && matchCommittee
  })
}

function getStandardCategories() {
  const seeds = [
    { key: 'all', label: '全部' },
    { key: 'national', label: '国标' },
    { key: 'industry', label: '行标' },
    { key: 'local', label: '地标' },
    { key: 'group', label: '团标' },
    { key: 'enterprise', label: '企标' },
    { key: 'international', label: '国际国外' }
  ]
  return seeds.map((item) => ({
    ...item,
    count: item.key === 'all' ? standards.length : standards.filter((standard) => standard.category === item.key).length
  }))
}

function searchCommittees(keyword) {
  const query = (keyword || '').trim().toLowerCase()
  if (!query) return committees
  return committees.filter((item) =>
    [item.code, item.name, item.secretariat, item.scope].join(' ').toLowerCase().includes(query)
  )
}

function searchGraphStandards(keyword) {
  const query = (keyword || '').trim().toLowerCase()
  const list = query
    ? standards.filter((item) => [item.code, item.title, item.committeeName].join(' ').toLowerCase().includes(query))
    : standards.slice(0, 4)
  return list.map((item) => ({
    id: item.id,
    code: item.code,
    title: item.title,
    committeeName: item.committeeName
  }))
}

function getStandardGraph(id) {
  const standard = findStandard(id)
  if (!standard) return null
  const graph = knowledgeGraphs[id] || {
    summary: '当前标准已建立基础关系图谱，可查看替代关系和相关标准。',
    replacementChain: [{ code: standard.code, title: standard.title, current: true }],
    relatedNodes: [],
    libraryRefs: [],
    citedSummary: '暂无更多关系说明。'
  }
  const committee = findCommittee(standard.committeeId)
  const industry = industryGroups.find((item) => item.key === standard.industryKey)
  const replacementHeadline =
    graph.replacementChain.length > 1
      ? standard.status === '即将实施'
        ? '版本演进 / 即将替代'
        : '版本演进 / 替代关系'
      : '标准关系总览'
  return {
    standard,
    committee,
    industry,
    summary: graph.summary,
    replacementChain: graph.replacementChain,
    relatedNodes: graph.relatedNodes,
    libraryStandards: getStandardsByIds(graph.libraryRefs),
    citedSummary: graph.citedSummary,
    nodeCount: graph.relatedNodes.length + graph.replacementChain.length + (committee ? 1 : 0),
    replacementHeadline,
    similarCount: graph.relatedNodes.length,
    relationMetrics: [
      { label: '版本节点', value: String(graph.replacementChain.length) },
      { label: '相近标准', value: String(graph.relatedNodes.length) },
      { label: '在库关联', value: String(graph.libraryRefs.length) },
      { label: '归口委员会', value: committee ? '1' : '0' }
    ]
  }
}

function getIndustryGroups() {
  return industryGroups.map((item) => ({
    ...item,
    count: item.standardIds.length
  }))
}

function getIndustryRecommendation(key) {
  const current = industryGroups.find((item) => item.key === key) || industryGroups[0]
  return current
    ? {
        ...current,
        standards: getStandardsByIds(current.standardIds)
      }
    : null
}

module.exports = {
  heroStats,
  notices,
  membershipPlans,
  standards,
  committees,
  compareTasks,
  report,
  orders,
  bookingRecords,
  icsRoots,
  findStandard,
  findCommittee,
  getStandards,
  getStandardsByIds,
  getCommitteeStandards,
  getStandardCategories,
  searchCommittees,
  searchGraphStandards,
  getStandardGraph,
  getIndustryGroups,
  getIndustryRecommendation
}
