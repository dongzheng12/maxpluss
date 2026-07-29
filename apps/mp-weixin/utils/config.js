/**
 * 全局配置
 *
 * 正式小程序权威配置：
 *   - develop / trial / release 全部走生产 HTTPS 域名
 *   - 禁止在权威源内保留 IP:端口或本地 API，提审包和演示包均从此派生
 */

const PROD_API = 'https://api.biaozhunxiaozhi.com'

function pickApiBase() {
  return PROD_API
}

module.exports = {
  API_BASE: pickApiBase(),
  // full 提审/演示统一包含企业员工侧入口；后续不再维护独立 demo 拷贝。
  SE_UI_ENABLED: true,
}
