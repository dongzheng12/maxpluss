/**
 * 行业标准推荐页 — 按行业分类查询适用标准
 * @date   2026-03-21
 */
const session = require('../../utils/session')
const request = require('../../utils/request')
const { API_BASE } = require('../../utils/config')

// 标准类型英文→中文映射（与 engine.py STANDARD_TYPE_KEYWORDS 一致）
const TYPE_NAMES = {
  terminology: '术语',
  symbol: '符号',
  classification: '分类',
  test_method: '试验方法',
  specification: '规范',
  code_of_practice: '规程',
  guide: '指南',
  product: '产品',
  management_system: '管理体系'
}

// 24个行业分类（与 PC Web IND 对象一致）
const INDUSTRIES = [
  { key: 'A_comprehensive', name: '综合' },
  { key: 'B_agriculture', name: '农业' },
  { key: 'C_medical', name: '医药卫生' },
  { key: 'D_mining', name: '矿业' },
  { key: 'E_petroleum', name: '石油' },
  { key: 'F_energy', name: '能源' },
  { key: 'G_chemical', name: '化工' },
  { key: 'H_metallurgy', name: '冶金' },
  { key: 'J_machinery', name: '机械' },
  { key: 'K_electrical', name: '电工电子' },
  { key: 'L_electronics_it', name: '信息技术' },
  { key: 'M_telecom', name: '通信' },
  { key: 'N_instruments', name: '仪器仪表' },
  { key: 'P_construction', name: '工程建设' },
  { key: 'Q_building_materials', name: '建筑材料' },
  { key: 'R_road_transport', name: '道路交通' },
  { key: 'S_railway', name: '铁路' },
  { key: 'T_vehicles', name: '车辆' },
  { key: 'U_marine', name: '船舶' },
  { key: 'V_aerospace', name: '航空航天' },
  { key: 'W_textile', name: '纺织' },
  { key: 'X_food', name: '食品' },
  { key: 'Y_consumer', name: '日用消费品' },
  { key: 'Z_environmental', name: '环保' }
]

Page({
  data: {
    keyword: '',
    loading: false,
    result: null,
    error: '',
    activeType: '',    // 中文显示名
    activeTypeKey: '',  // 英文原始key（用于by_type查询）
    // 行业下拉
    industries: INDUSTRIES,
    industryLabels: INDUSTRIES.map(i => i.name),
    selectedIndustryIndex: -1,
    // 热门标签
    hotTags: ['食品', '机械', '医药', '焊接', '建筑材料', '化工', '电气', '纺织'],
    allStandards: [],
    filteredList: [],
    page: 1,
    pageSize: 20,
    pagedList: [],
    totalPages: 0,
    typeList: []
  },

  onLoad(options) {
    if (options && options.keyword) {
      this.setData({ keyword: decodeURIComponent(options.keyword) })
      this.search()
    }
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  tapTag(e) {
    const tag = e.currentTarget.dataset.tag
    this.setData({ keyword: tag })
    this.search()
  },

  onIndustryPick(e) {
    const idx = Number(e.detail.value)
    const industry = INDUSTRIES[idx]
    this.setData({
      selectedIndustryIndex: idx,
      keyword: industry.name
    })
    // 选完自动搜索
    this.search()
  },

  search() {
    const q = (this.data.keyword || '').trim()
    if (!q) return

    // 需要登录
    if (!session.requireLogin(null, true)) {
      session.requireLogin()
      return
    }

    this.setData({ loading: true, error: '', result: null, activeType: '', activeTypeKey: '', page: 1 })

    request({
      url: `/api/v1/industry-standards?q=${encodeURIComponent(q)}`,
      method: 'GET',
      success: (res) => {
        const data = res.data
        if (!data || !data.matched) {
          this.setData({
            loading: false,
            error: `未找到"${q}"相关行业，试试其他关键词`
          })
          return
        }
        const all = [...(data.mandatory || []), ...(data.recommended || [])].filter(s => s.status !== '废止')
        this.setData({
          loading: false,
          result: data,
          allStandards: all
        })
        this.applyFilter()
      },
      fail: () => {
        this.setData({ loading: false, error: '查询失败，请检查网络后重试' })
      }
    })
  },

  tapType(e) {
    const name = e.currentTarget.dataset.type
    const key = e.currentTarget.dataset.key || ''
    if (this.data.activeType === name) {
      this.setData({ activeType: '', activeTypeKey: '', page: 1 })
    } else {
      this.setData({ activeType: name, activeTypeKey: key, page: 1 })
    }
    this.applyFilter()
  },

  applyFilter() {
    let list = this.data.allStandards
    const activeType = this.data.activeType
    const activeTypeKey = this.data.activeTypeKey
    if (activeType && activeType !== '全部') {
      const byType = this.data.result.by_type || {}
      // 用英文key查by_type，回退用type_tags匹配
      list = byType[activeTypeKey] || list.filter(s => (s.type_tags || []).indexOf(activeTypeKey) >= 0)
    }

    const totalPages = Math.ceil(list.length / this.data.pageSize) || 1
    const page = Math.min(this.data.page, totalPages)
    const start = (page - 1) * this.data.pageSize
    const pagedList = list.slice(start, start + this.data.pageSize)

    // 构建类型筛选列表
    const typeDistribution = this.data.result ? this.data.result.type_distribution || {} : {}
    const typeList = [{ name: '全部', key: '', count: this.data.allStandards.length }]
    for (const key in typeDistribution) {
      typeList.push({ name: TYPE_NAMES[key] || key, key: key, count: typeDistribution[key] })
    }

    this.setData({ filteredList: list, pagedList, totalPages, typeList, page })
  },

  prevPage() {
    if (this.data.page <= 1) return
    this.setData({ page: this.data.page - 1 })
    this.applyFilter()
  },

  nextPage() {
    if (this.data.page >= this.data.totalPages) return
    this.setData({ page: this.data.page + 1 })
    this.applyFilter()
  },

  openDetail(e) {
    const code = e.currentTarget.dataset.code
    wx.navigateTo({ url: `/pages/detail/index?id=${encodeURIComponent(code)}` })
  }
})
