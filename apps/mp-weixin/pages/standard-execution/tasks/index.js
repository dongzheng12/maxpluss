/**
 * 我的任务列表 — Tab + 分页 + 下拉刷新
 * 路由参数：?tab=todo|review|done|closed（可选，缺省 todo）
 * 企业员工端固定四 Tab：待处理 / 审核中 / 已完成 / 已关闭。
 */
const se = require('../../../utils/standardExecution')
const session = require('../../../utils/session')

const ALL_TABS = [
  { key: 'todo', label: '待处理' },
  { key: 'review', label: '审核中' },
  { key: 'done', label: '已完成' },
  { key: 'closed', label: '已关闭' },
]

function tabsForRole() {
  return ALL_TABS
}

const PAGE_SIZE = 20
const RELOAD_FAILURE_COOLDOWN_MS = 4000

Page({
  _reloadPromise: null,
  _suppressNextShowReload: false,
  _lastFailureAt: 0,

  data: {
    tabs: ALL_TABS,
    activeTab: 'todo',
    items: [],
    page: 1,
    total: 0,
    loading: false,
    finished: false,
    empty: false,
  },

  onLoad(opts) {
    const user = session.getUser() || {}
    const tabs = tabsForRole(user.enterpriseRole)
    const defaultTab = tabs[0].key
    const tab = opts && opts.tab && tabs.find((t) => t.key === opts.tab) ? opts.tab : defaultTab
    this.setData({ tabs, activeTab: tab })
    this._suppressNextShowReload = true
    this._reload({ force: true })
  },

  // 企业版「首页」按钮 → 回到企业版首页（而非 C 端首页）
  onNavigateToHome() {
    wx.reLaunch({ url: '/pages/enterprise-home/index' })
  },

  // 顶部「修改密码」按钮 → 改密页（全角色可用，不依赖 enterprise-home）
  goChangePwd() {
    wx.navigateTo({ url: '/pages/change-password/index' })
  },

  onShow() {
    // 从详情 / 提交页返回时刷新当前 Tab，反映状态变更
    if (this._suppressNextShowReload) {
      this._suppressNextShowReload = false
      return
    }
    this._reload()
  },

  onPullDownRefresh() {
    this._reload({ force: true }).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.loading || this.data.finished) return
    this._loadMore()
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.activeTab) return
    this.setData({ activeTab: tab, items: [], page: 1, total: 0, finished: false, empty: false })
    this._reload({ force: true })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/standard-execution/task-detail/index?id=${id}` })
  },

  _reload(options) {
    const opts = options || {}
    if (this._reloadPromise) return this._reloadPromise
    const now = Date.now()
    if (!opts.force && this._lastFailureAt && now - this._lastFailureAt < RELOAD_FAILURE_COOLDOWN_MS) {
      return Promise.resolve(null)
    }

    this._reloadPromise = this._fetch(1).then((res) => {
      this.setData({
        items: (res && res.data) || [],
        total: (res && res.total) || 0,
        page: 1,
        finished: ((res && res.data) || []).length >= ((res && res.total) || 0),
        empty: !((res && res.data) || []).length,
      })
    }).catch((e) => {
      this._lastFailureAt = Date.now()
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
      this.setData({ empty: !this.data.items.length })
    }).finally(() => {
      this._reloadPromise = null
    })
    return this._reloadPromise
  },

  _loadMore() {
    const next = this.data.page + 1
    return this._fetch(next).then((res) => {
      const newItems = (res && res.data) || []
      const all = this.data.items.concat(newItems)
      this.setData({
        items: all,
        page: next,
        total: (res && res.total) || all.length,
        finished: all.length >= ((res && res.total) || all.length),
      })
    }).catch((e) => {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    })
  },

  _fetch(page) {
    this.setData({ loading: true })
    return se.listTasks({ tab: this.data.activeTab, page, pageSize: PAGE_SIZE })
      .finally(() => this.setData({ loading: false }))
  },
})
