/**
 * 标准列表页 — 双 Tab:关键词搜索 / 按行业推荐
 *   - keyword Tab(默认): 沿用 doSearch + CAT_LIST 左侧分类 + 顶部状态筛选
 *   - industry Tab: port 自 /pages/industry/index, 24 行业分类 + by_type 类型筛选 + 分页
 *   - onLoad 读 options.mode='industry' 自动落到行业推荐 Tab
 *
 * @date   2026-04-30 (合并自 industry/index.js,行业入口由 tools-config 走 ?mode=industry)
 */
const session = require('../../utils/session')
const request = require('../../utils/request')

const { API_BASE } = require('../../utils/config')

// 标准类型英文 → 中文映射(industry by_type 用)
const TYPE_NAMES = {
  terminology: '术语', symbol: '符号', classification: '分类',
  test_method: '试验方法', specification: '规范', code_of_practice: '规程',
  guide: '指南', product: '产品', management_system: '管理体系'
}

// 状态 → 标签色调（与卡片样式 tag-* class 对齐）
function statusTone(s) {
  if (s === '现行') return 'green'
  if (s === '即将实施' || s === '暂不实施') return 'orange'
  if (s === '废止' || s === '作废' || s === '被代替') return 'gray'
  return 'gray'
}

// match_type → 标签：仅对「精准」命中（code_match）显示 tag；
// fts_match / name_match 不展示「模糊」标签（保留 match_type 接收用于内部逻辑）
function matchTypeBadge(mt) {
  if (mt === 'code_match') return { label: '精准', tone: 'blue' }
  return null
}

// 排序选项（与 engine.py search() sort_by 参数对齐）
const SORT_OPTIONS = [
  { value: '',                label: '默认排序' },
  { value: 'impl_date_desc',  label: '按实施时间 ↓' },
  { value: 'impl_date_asc',   label: '按实施时间 ↑' }
]

// keyword Tab — 左侧分类配置
const CAT_LIST = [
  { key: 'all', label: '全部' },
  { key: 'national', label: '国标' },
  { key: 'group', label: '团标' },
  { key: 'industry', label: '行标' },
  { key: 'local', label: '地标' },
  { key: 'enterprise', label: '企业' },
  { key: 'international', label: '国际' }
]

// industry Tab — 24 个行业分类(与 PC Web IND 对象一致)
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

function typeLabel(item) {
  if (item.is_mandatory) return '强制性国家标准'
  if (item.code.startsWith('GB/T')) return '推荐性国家标准'
  if (item.code.startsWith('GB')) return '国家标准'
  if (item.code.startsWith('DB')) return '地方标准'
  if (item.code.startsWith('T/')) return '团体标准'
  return '行业标准'
}

Page({
  data: {
    // ── Tab 切换 ──
    activeTab: 'keyword',  // 'keyword' | 'industry'

    // ═══ keyword Tab 字段 ═══
    keyword: '',
    searched: false,      // 是否已搜索过
    loading: false,
    catList: CAT_LIST,
    activeCat: 'all',
    catCounts: {},
    statusList: [],       // [{name, count}]
    activeStatus: '',
    standards: [],
    page: 1,
    pageSize: 20,
    total: 0,
    noMore: false,
    sortBy: '',
    sortIndex: 0,
    sortOptions: SORT_OPTIONS,
    sortOptionLabels: SORT_OPTIONS.map(function (o) { return o.label }),

    // ═══ industry Tab 字段(port 自 /pages/industry/index) ═══
    indKeyword: '',
    indLoading: false,
    indResult: null,
    indError: '',
    indActiveType: '',     // 中文显示名
    indActiveTypeKey: '',  // 英文原始 key(用于 by_type 查询)
    industries: INDUSTRIES,
    industryLabels: INDUSTRIES.map(function (i) { return i.name }),
    selectedIndustryIndex: -1,
    hotTags: ['食品', '机械', '医药', '焊接', '建筑材料', '化工', '电气', '纺织'],
    indAllStandards: [],
    indFilteredList: [],
    indPage: 1,
    indPageSize: 20,
    indPagedList: [],
    indTotalPages: 0,
    indTypeList: []
  },

  onLoad(options) {
    // 工具卡 ?mode=industry → 自动落到行业推荐 Tab
    if (options && options.mode === 'industry') {
      this.setData({ activeTab: 'industry' })
    }
  },

  onShow() {
    // 兼容外部页面通过 globalData.pendingKeyword 唤起 keyword Tab 搜索
    const app = getApp()
    const pendingKeyword = app.globalData && app.globalData.pendingKeyword
    if (pendingKeyword) {
      this.setData({
        activeTab: 'keyword',
        keyword: decodeURIComponent(pendingKeyword)
      })
      app.globalData.pendingKeyword = ''
      app.globalData.pendingCategory = ''
      this.doSearch(true)
    }
  },

  // ── Tab 切换 ──
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab !== 'keyword' && tab !== 'industry') return
    this.setData({ activeTab: tab })
  },

  // ════════════════════════════════════════════
  // ═══ keyword Tab — 关键词搜索 + 左侧分类 ═══
  // ════════════════════════════════════════════

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearch() {
    this.doSearch(true)
  },

  doSearch(reset) {
    const q = (this.data.keyword || '').trim()
    if (!q) {
      wx.showToast({ title: '请输入关键词', icon: 'none' })
      return
    }
    if (this.data.loading) return

    // 首次搜索需要登录 + 额度检查
    if (reset) {
      if (!session.requireLogin(null, true)) {
        session.requireLogin()
        return
      }
      if (!session.checkAndConsume('search')) return
    }

    const page = reset ? 1 : this.data.page + 1
    this.setData({ loading: true, searched: true })

    request({
      url: '/api/v1/standards',
      data: {
        q,
        category: this.data.activeCat,
        status: this.data.activeStatus,
        page,
        page_size: this.data.pageSize,
        sort_by: this.data.sortBy
      },
      success: (res) => {
        const d = res.data
        if (!d || !d.items) {
          this.setData({ loading: false, standards: reset ? [] : this.data.standards, total: 0 })
          return
        }

        const items = (d.items || []).map(function (s) {
          var mb = matchTypeBadge(s.match_type)
          return Object.assign({}, s, {
            title: s.name,
            typeLabel: typeLabel(s),
            publishDate: s.pub_date || '',
            implementDate: s.impl_date || '',
            statusTone: statusTone(s.status),
            matchTypeLabel: mb ? mb.label : '',
            matchTypeTone: mb ? mb.tone : ''
          })
        })

        const oldList = reset ? [] : this.data.standards
        const newList = oldList.concat(items)

        let statusList = this.data.statusList
        if (reset && d.status_counts) {
          statusList = Object.entries(d.status_counts)
            .map(function (entry) { return { name: entry[0], count: entry[1] } })
            .sort(function (a, b) { return b.count - a.count })
        }

        this.setData({
          loading: false,
          standards: newList,
          page,
          total: d.total || 0,
          noMore: newList.length >= (d.total || 0),
          catCounts: reset ? (d.categories || {}) : this.data.catCounts,
          statusList
        })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '查询失败', icon: 'none' })
      }
    })
  },

  switchCat(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ activeCat: key, activeStatus: '' })
    this.doSearch(true)
  },

  switchStatus(e) {
    const name = e.currentTarget.dataset.status
    const activeStatus = this.data.activeStatus === name ? '' : name
    this.setData({ activeStatus })
    this.doSearch(true)
  },

  onSortPick(e) {
    const idx = parseInt(e.detail.value, 10)
    if (isNaN(idx) || idx < 0 || idx >= this.data.sortOptions.length) return
    if (idx === this.data.sortIndex) return
    const sortBy = this.data.sortOptions[idx].value
    this.setData({ sortIndex: idx, sortBy })
    if (this.data.searched) this.doSearch(true)
  },

  onReachBottom() {
    // 仅 keyword Tab 走滚动加载;industry Tab 用分页按钮,不触发
    if (this.data.activeTab !== 'keyword') return
    if (!this.data.noMore && !this.data.loading && this.data.searched) {
      this.doSearch(false)
    }
  },

  toggleFavorite(e) {
    const code = e.currentTarget.dataset.code
    session.ensureLogin(() => {
      session.toggleFavorite(code)
      const standards = this.data.standards.map(function (s) {
        if (s.code === code) return Object.assign({}, s, { isFavorite: session.isFavorite(code) })
        return s
      })
      this.setData({ standards })
      wx.showToast({ title: session.isFavorite(code) ? '已收藏' : '已取消', icon: 'none' })
    })
  },

  // 共用 — 跳转标准详情
  openDetail(e) {
    const code = e.currentTarget.dataset.code
    wx.navigateTo({ url: `/pages/detail/index?id=${encodeURIComponent(code)}` })
  },

  // 仅 keyword Tab 用 — 跳转图谱
  openGraph(e) {
    const code = e.currentTarget.dataset.code
    wx.navigateTo({ url: `/pages/graph/index?code=${encodeURIComponent(code)}` })
  },

  // ════════════════════════════════════════════
  // ═══ industry Tab — 行业推荐(port 自 industry/index.js) ═══
  // ════════════════════════════════════════════

  onIndKeywordInput(e) {
    this.setData({ indKeyword: e.detail.value })
  },

  tapHotTag(e) {
    const tag = e.currentTarget.dataset.tag
    this.setData({ indKeyword: tag })
    this.indSearch()
  },

  onIndustryPick(e) {
    const idx = Number(e.detail.value)
    const industry = INDUSTRIES[idx]
    this.setData({
      selectedIndustryIndex: idx,
      indKeyword: industry.name
    })
    this.indSearch()
  },

  indSearch() {
    const q = (this.data.indKeyword || '').trim()
    if (!q) return

    if (!session.requireLogin(null, true)) {
      session.requireLogin()
      return
    }

    this.setData({
      indLoading: true,
      indError: '',
      indResult: null,
      indActiveType: '',
      indActiveTypeKey: '',
      indPage: 1
    })

    request({
      url: `/api/v1/industry-standards?q=${encodeURIComponent(q)}`,
      method: 'GET',
      success: (res) => {
        const data = res.data
        if (!data || !data.matched) {
          this.setData({
            indLoading: false,
            indError: `未找到"${q}"相关行业，试试其他关键词`
          })
          return
        }
        const all = [].concat(data.mandatory || [], data.recommended || [])
          .filter(function (s) { return s.status !== '废止' })
        this.setData({
          indLoading: false,
          indResult: data,
          indAllStandards: all
        })
        this.applyIndFilter()
      },
      fail: () => {
        this.setData({ indLoading: false, indError: '查询失败，请检查网络后重试' })
      }
    })
  },

  tapIndType(e) {
    const name = e.currentTarget.dataset.type
    const key = e.currentTarget.dataset.key || ''
    if (this.data.indActiveType === name) {
      this.setData({ indActiveType: '', indActiveTypeKey: '', indPage: 1 })
    } else {
      this.setData({ indActiveType: name, indActiveTypeKey: key, indPage: 1 })
    }
    this.applyIndFilter()
  },

  applyIndFilter() {
    let list = this.data.indAllStandards
    const activeType = this.data.indActiveType
    const activeTypeKey = this.data.indActiveTypeKey
    if (activeType && activeType !== '全部') {
      const byType = (this.data.indResult && this.data.indResult.by_type) || {}
      list = byType[activeTypeKey] || list.filter(function (s) {
        return (s.type_tags || []).indexOf(activeTypeKey) >= 0
      })
    }

    const totalPages = Math.ceil(list.length / this.data.indPageSize) || 1
    const page = Math.min(this.data.indPage, totalPages)
    const start = (page - 1) * this.data.indPageSize
    const pagedList = list.slice(start, start + this.data.indPageSize)

    const typeDistribution = (this.data.indResult && this.data.indResult.type_distribution) || {}
    const typeList = [{ name: '全部', key: '', count: this.data.indAllStandards.length }]
    for (const key in typeDistribution) {
      typeList.push({ name: TYPE_NAMES[key] || key, key: key, count: typeDistribution[key] })
    }

    this.setData({
      indFilteredList: list,
      indPagedList: pagedList,
      indTotalPages: totalPages,
      indTypeList: typeList,
      indPage: page
    })
  },

  indPrevPage() {
    if (this.data.indPage <= 1) return
    this.setData({ indPage: this.data.indPage - 1 })
    this.applyIndFilter()
  },

  indNextPage() {
    if (this.data.indPage >= this.data.indTotalPages) return
    this.setData({ indPage: this.data.indPage + 1 })
    this.applyIndFilter()
  }
})
