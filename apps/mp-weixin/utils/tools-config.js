/**
 * 工具配置 — 唯一数据源
 * 首页和工作台共用，禁止各自维护 ALL_TOOLS
 */
const ICONS = require('./tool-icons')

const ALL_TOOLS = [
  { key: 'chat',          label: '呼叫小智',     iconImg: ICONS.chat,          route: '/pages/chat/index',          isTab: false },
  { key: 'scan',          label: '扫一扫',       iconImg: ICONS.compare,       route: '/pages/scan/index',          isTab: false },
  { key: 'committee',     label: '技术委员会',   iconImg: ICONS.committee,     route: '/pages/committee/index',     isTab: false },
  { key: 'graph',         label: '标准图谱',     iconImg: ICONS.graph,         route: '/pages/graph/index',         isTab: false },
  { key: 'industry',      label: '行业推荐',     iconImg: ICONS.industry,      route: '/pages/standards/index?mode=industry', isTab: false },
  { key: 'compare',       label: '文档比对',     iconImg: ICONS.compare,       route: '/pages/compare/index',       isTab: true },
  { key: 'booking',       label: '标准服务预约', iconImg: ICONS.booking,       route: '/pages/booking/index',       isTab: false },
  { key: 'certification', label: '认证',         iconImg: ICONS.certification, route: '/pages/certification/index', isTab: false },
  { key: 'training',      label: '培训',         iconImg: ICONS.training,      route: '/pages/training/index',      isTab: false },
  { key: 'standards',     label: '标准信息查询', iconImg: ICONS.compare,       route: '/pages/standards/index',     isTab: false },
]

var VALID_KEYS = {}
ALL_TOOLS.forEach(function (t) { VALID_KEYS[t.key] = true })

var ROUTES = {}
ALL_TOOLS.forEach(function (t) { ROUTES[t.key] = t.route })

var TAB_ROUTES = ALL_TOOLS.filter(function (t) { return t.isTab }).map(function (t) { return t.route })
TAB_ROUTES.push('/pages/chat/index')

var DEFAULT_HOME_ORDER = ['scan', 'committee', 'graph', 'standards', 'compare']
var DEFAULT_FULL_ORDER = ALL_TOOLS.map(function (t) { return t.key })

/**
 * 从 storage 读取排序并清洗：去除无效 key，补齐缺失 key
 */
function getSanitizedOrder(rawOrder, defaultOrder) {
  if (!rawOrder || !Array.isArray(rawOrder)) return defaultOrder.slice()
  var cleaned = rawOrder.filter(function (k) { return VALID_KEYS[k] })
  // 补齐 defaultOrder 中有但 cleaned 中没有的 key
  defaultOrder.forEach(function (k) {
    if (cleaned.indexOf(k) === -1) cleaned.push(k)
  })
  return cleaned
}

/**
 * 1.0.2 工作台动态化用：合法 key 列表来自接口/缓存（不再依赖静态 VALID_KEYS）
 * defaultOrderKeys 即 allTools.map(t => t.key)，作为 valid 集合 + 补齐序列
 */
function getSanitizedOrderWithKeys(rawOrder, defaultOrderKeys) {
  var validSet = {}
  defaultOrderKeys.forEach(function (k) { validSet[k] = true })
  if (!rawOrder || !Array.isArray(rawOrder)) return defaultOrderKeys.slice()
  var cleaned = rawOrder.filter(function (k) { return validSet[k] })
  defaultOrderKeys.forEach(function (k) {
    if (cleaned.indexOf(k) === -1) cleaned.push(k)
  })
  return cleaned
}

module.exports = {
  ALL_TOOLS: ALL_TOOLS,
  VALID_KEYS: VALID_KEYS,
  ROUTES: ROUTES,
  TAB_ROUTES: TAB_ROUTES,
  DEFAULT_HOME_ORDER: DEFAULT_HOME_ORDER,
  DEFAULT_FULL_ORDER: DEFAULT_FULL_ORDER,
  getSanitizedOrder: getSanitizedOrder,
  getSanitizedOrderWithKeys: getSanitizedOrderWithKeys,
}
