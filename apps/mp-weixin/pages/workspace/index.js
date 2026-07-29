/**
 * 工作台 — 全部工具（长按拖拽排序）+ 个人数据入口
 * @date   2026-03-21
 *
 * 1.0.2 改动：工具列表从后端 /api/app/workbench/entries 拉取（动态化），
 * 1 小时本地缓存兜底；接口失败/首次启动无缓存时 fallback 到本地 tools-config.js。
 * 个人拖拽排序逻辑不变（session.getToolOrder 仍按 key 工作）。
 *
 * SE 改动：onShow 检查 /api/enterprise/me，企业成员额外显示「我的执行任务」入口。
 */
const session = require('../../utils/session')
const request = require('../../utils/request')
const TC = require('../../utils/tools-config')
const ICONS = require('../../utils/tool-icons')
const config = require('../../utils/config')

const ENTRIES_CACHE_KEY = 'workbench_entries_cache_v1'
const ENTRIES_CACHE_TTL_MS = 60 * 60 * 1000 // 1 小时

// 接口返回 entry 适配为本地 ALL_TOOLS 风格（{key,label,iconImg,route,isTab}）
function adaptEntry(e) {
  var nextLabel = e.label
  if (e.key === 'standards') nextLabel = '标准信息查询'
  return {
    key: e.key,
    label: nextLabel,
    iconImg: ICONS[e.icon] || ICONS.compare, // 未知 icon 用 compare 兜底
    route: e.path,
    isTab: !!e.isTab,
  }
}

function filterVisibleTools(items) {
  return (items || []).filter(function (tool) { return tool && tool.key !== 'outline' })
}

// 每行 4 个，每个格子尺寸(rpx)
const COLS = 4
const CELL_W = 165  // (750 - 24*2 - 16*3) / 4 ≈ 165
const CELL_H = 160
const GAP = 16

Page({
  data: {
    tools: [],
    toolsExpanded: true,
    favoriteCount: 0,
    listIcons: {
      orders: '/assets/list/my-orders.png',
      favorites: '/assets/list/my-favorites.png'
    },
    isEditing: false,
    dragIndex: -1,        // 当前拖拽的项
    dragStyle: '',        // 拖拽项浮动定位
    placeholderIndex: -1, // 占位目标位置
    seEnabled: false,     // 是否为企业成员（显示我的执行任务入口）
  },

  // ── 拖拽相关的临时变量（不放 data 避免频繁 setData）──
  _startX: 0,
  _startY: 0,
  _cellPx: 0,   // cell 宽 px
  _cellHPx: 0,  // cell 高 px
  _gapPx: 0,
  _gridRect: null,

  onShow() {
    // 企业成员（通过企业版登录进来的）点系统「首页」会落到 workspace，
    // 这里检测到 enterpriseRole 后 reLaunch 到企业版首页（enterprise-home），保持企业版体验一致。
    const user = session.getUser() || {}
    if (user.enterpriseRole && user.enterpriseId) {
      wx.reLaunch({ url: '/pages/enterprise-home/index' })
      return
    }
    this._loadEntries()
    this.setData({ favoriteCount: session.getFavorites().length })
    this._checkEnterprise()
  },

  // 检查当前用户是否为企业成员，是则显示「我的执行任务」入口
  _checkEnterprise() {
    if (!session.isLoggedIn()) {
      this.setData({ seEnabled: false })
      return
    }
    request({ url: '/api/enterprise/me', method: 'GET' })
      .then((res) => {
        var data = res.data || {}
        // SE 灰度开关 && enterpriseId 非 null（企业成员）双重判断；config.SE_UI_ENABLED=false 时入口一律隐藏
        var enabled = config.SE_UI_ENABLED && !!data.enterpriseId
        this.setData({ seEnabled: enabled })
        // 同步企业角色到 session，供 goSETasks 按角色路由
        if (enabled) {
          var u = session.getUser() || {}
          u.enterpriseId = data.enterpriseId
          u.enterpriseRole = data.enterpriseRole
          session.setUser(u)
        }
      })
      .catch(() => { /* 静默：不影响工作台其他功能 */ })
  },

  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/workspace/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  // 拉取工作台入口配置（先本地缓存渲染，再后台刷新；失败回退本地 tools-config.js）
  _loadEntries() {
    const self = this
    // ① 同步读缓存先渲染（首屏不卡）
    let cached = null
    try { cached = wx.getStorageSync(ENTRIES_CACHE_KEY) } catch (e) {}
    if (cached && cached.ts && Date.now() - cached.ts < ENTRIES_CACHE_TTL_MS && Array.isArray(cached.items)) {
      self._renderTools(filterVisibleTools(cached.items))
    } else {
      // 无有效缓存先用本地兜底（避免空白闪屏），后台仍发请求
      self._renderTools(filterVisibleTools(TC.ALL_TOOLS))
    }
    // ② 后台刷新
    wx.request({
      url: config.API_BASE + '/api/app/workbench/entries',
      method: 'GET',
      timeout: 8000,
      success(res) {
        if (res.statusCode !== 200 || !res.data || !Array.isArray(res.data.items)) return
        const adapted = filterVisibleTools(res.data.items.map(adaptEntry))
        if (adapted.length === 0) return // 接口空数组不覆盖兜底
        self._renderTools(adapted)
        try { wx.setStorageSync(ENTRIES_CACHE_KEY, { ts: Date.now(), items: adapted }) } catch (e) {}
      },
      fail() { /* 静默：保留兜底/缓存渲染 */ },
    })
  },

  _renderTools(allTools) {
    // 用户拖拽个人排序仍按 key 工作；用接口下发的 keys 作为 defaultOrder
    const allKeys = allTools.map(t => t.key)
    const order = TC.getSanitizedOrderWithKeys(session.getToolOrder(), allKeys)
    const tools = order.map(key => allTools.find(t => t.key === key)).filter(Boolean)
    this.setData({ tools })
  },

  toggleExpand() {
    this.setData({ toolsExpanded: !this.data.toolsExpanded })
  },

  tapTool(e) {
    if (this.data.isEditing) return
    const key = e.currentTarget.dataset.key
    // 1.0.2 改：route + isTab 从 this.data.tools 取（动态接口下发），不再依赖静态 TC.ROUTES
    const tool = (this.data.tools || []).find(t => t.key === key)
    if (!tool || !tool.route) return
    if (tool.isTab || TC.TAB_ROUTES.includes(tool.route)) {
      wx.switchTab({ url: tool.route })
    } else {
      wx.navigateTo({ url: tool.route })
    }
  },

  // ── 长按进入编辑模式 ──
  onLongPress(e) {
    if (this.data.isEditing) return
    wx.vibrateShort({ type: 'medium' })
    this.setData({ isEditing: true })
  },

  // 点击完成退出编辑
  finishEdit() {
    const order = this.data.tools.map(t => t.key)
    session.setToolOrder(order)
    this.setData({ isEditing: false, dragIndex: -1, dragStyle: '', placeholderIndex: -1 })
  },

  // ── 拖拽开始 ──
  onDragStart(e) {
    if (!this.data.isEditing) return
    const idx = e.currentTarget.dataset.idx
    const touch = e.touches[0]
    this._startX = touch.clientX
    this._startY = touch.clientY
    this._dragIdx = idx

    // rpx → px 换算
    const sysInfo = wx.getSystemInfoSync()
    const ratio = sysInfo.windowWidth / 750
    this._cellPx = CELL_W * ratio
    this._cellHPx = CELL_H * ratio
    this._gapPx = GAP * ratio

    // 获取 grid 容器位置
    const query = wx.createSelectorQuery()
    query.select('.tools-grid').boundingClientRect((rect) => {
      this._gridRect = rect
    }).exec()

    this.setData({ dragIndex: idx, placeholderIndex: idx })
    wx.vibrateShort({ type: 'light' })
  },

  // ── 拖拽移动 ──
  onDragMove(e) {
    if (this.data.dragIndex < 0 || !this._gridRect) return
    const touch = e.touches[0]
    const dx = touch.clientX - this._startX
    const dy = touch.clientY - this._startY

    // 浮动样式
    const dragStyle = `transform:translate(${dx}px,${dy}px) scale(1.12);z-index:999;opacity:0.85;`
    this.setData({ dragStyle })

    // 计算目标位置
    const rx = touch.clientX - this._gridRect.left
    const ry = touch.clientY - this._gridRect.top
    const col = Math.min(COLS - 1, Math.max(0, Math.floor(rx / (this._cellPx + this._gapPx))))
    const row = Math.max(0, Math.floor(ry / (this._cellHPx + this._gapPx)))
    let targetIdx = row * COLS + col
    targetIdx = Math.min(this.data.tools.length - 1, Math.max(0, targetIdx))

    if (targetIdx !== this.data.placeholderIndex) {
      this.setData({ placeholderIndex: targetIdx })
    }
  },

  // ── 拖拽结束 ──
  onDragEnd() {
    if (this.data.dragIndex < 0) return
    const from = this.data.dragIndex
    const to = this.data.placeholderIndex
    const tools = this.data.tools.slice()

    if (from !== to && to >= 0) {
      const item = tools.splice(from, 1)[0]
      tools.splice(to, 0, item)
    }

    this.setData({
      tools,
      dragIndex: -1,
      dragStyle: '',
      placeholderIndex: -1
    })
  },

  goFavorites() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/favorites/index' }))
  },

  goOrders() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/orders/index' }))
  },

  goSETasks() {
    const user = session.getUser() || {}
    const role = user.enterpriseRole
    // ADMIN / MANAGER / REVIEWER → 企业工作台；EMPLOYEE 或未知 → 直接进我的任务
    if (role && role !== 'EMPLOYEE') {
      session.ensureLogin(() => wx.navigateTo({ url: '/pages/enterprise-home/index' }))
    } else {
      session.ensureLogin(() => wx.navigateTo({ url: '/pages/standard-execution/tasks/index' }))
    }
  }
})
