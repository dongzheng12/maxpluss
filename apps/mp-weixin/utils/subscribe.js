/**
 * 订阅消息授权入口 — 对接营销自动化任务二 POST /api/subscribe/grant
 *
 * 使用约定：
 *  - 非阻塞：调用方主流程（支付/识别）不等授权结果
 *  - 一次 wx.requestSubscribeMessage 同意 = 一次可发额度，后端 SubscribeQuota.quota+1
 *  - 用户拒绝或本次未同意：不报错，不 toast；静默记录 asked 标记避免反复弹
 *  - asked 标记只在"用户未同意时"写入，同意后不写（下次仍可再问以累积配额）
 *
 * 模板 ID 与后端 src/internal/rules/types.ts 保持同源。
 */
var request = require('./request')

var TEMPLATES = {
  R06_UNPAID_RECALL: 'xnZcI8RVPgkt4aXoWKETo-c7WupIorHVvG70zelPQEY',          // 订单待支付提醒
  R15_FIRST_SCAN_REWARD: '9rWcAqy1RFBdwrZqP9GjLE5lkEjMlW1TrbdEaQMxfdg',      // 会员时长奖励
  MEMBER_EXPIRE: '9iVB8CETXYt0SwQQCEOL06xXk6HUZnZtIq72ndqwSH8',              // R10/R11 到期提醒
  QUOTA_LOW: 'ZpOoHsHH5L_xhgH6n2oe7ZIZmalSaPNQbjlLulIM7mg',                  // R04/R05/R09 次数卡
  SERVICE_PROGRESS: 'cv2pRs2oospxtdkc2gbwKLwXZI8zd_iyaYZHD7RoFio',           // R01/R02/R07/R08/R12/R13 服务进度
  REFERRAL: 'UtPIdDEn7g_p8mcspWlie_cvq_QTqiZ1TcCkCI1KKuM',                   // R14 好友充能
}

// 本地"已问过但未同意"标记，14 天内不再打扰
var DECLINED_TTL_MS = 14 * 24 * 60 * 60 * 1000

function _declinedKey(templateId) {
  return '__subscribe_declined_' + templateId
}

function _isRecentlyDeclined(templateId) {
  try {
    var ts = wx.getStorageSync(_declinedKey(templateId))
    return ts && (Date.now() - Number(ts) < DECLINED_TTL_MS)
  } catch (e) {
    return false
  }
}

function _markDeclined(templateId) {
  try { wx.setStorageSync(_declinedKey(templateId), Date.now()) } catch (e) {}
}

/**
 * 发起一次订阅授权。
 * @param {string} templateId
 * @param {object} [opts]
 * @param {boolean} [opts.force]  忽略"最近已拒"本地标记（默认 false）
 * @param {Function} [opts.onAccepted]  用户同意后回调（可选）
 */
function requestSubscribe(templateId, opts) {
  opts = opts || {}
  if (!templateId) return

  if (!opts.force && _isRecentlyDeclined(templateId)) {
    return
  }

  if (!wx.requestSubscribeMessage) {
    // 老版本基础库无此 API
    return
  }

  wx.requestSubscribeMessage({
    tmplIds: [templateId],
    success: function (res) {
      var status = res[templateId]
      if (status === 'accept') {
        // 后端记 quota+1（不等返回）
        request({
          url: '/api/subscribe/grant',
          method: 'POST',
          data: { templateId: templateId },
          success: function () {
            if (opts.onAccepted) {
              try { opts.onAccepted() } catch (e) {}
            }
          },
          fail: function () { /* 静默，不影响主流程 */ }
        })
      } else {
        // reject / ban / filter → 记为"最近已拒"
        _markDeclined(templateId)
      }
    },
    fail: function () {
      // 场景：用户直接关闭、调用频率限制等。与拒绝一视同仁
      _markDeclined(templateId)
    }
  })
}

/**
 * 批量授权：一次 wx.requestSubscribeMessage 最多传 3 个 templateId（微信限制）。
 * 用户同意的每个模板调 POST /api/subscribe/grant 写 quota+1。
 *
 * @param {string[]} templateIds 最多 3 个
 * @param {object} [opts]
 * @param {Function} [opts.onResult] 每个 templateId 的授权结果回调: (templateId, status: 'accept'|'reject'|'ban'|'filter'|'error') => void
 * @param {Function} [opts.onDone] 全部处理完回调: (result: {accepted:string[], declined:string[]}) => void
 */
function requestSubscribeBatch(templateIds, opts) {
  opts = opts || {}
  if (!templateIds || templateIds.length === 0) {
    if (opts.onDone) opts.onDone({ accepted: [], declined: [] })
    return
  }
  if (templateIds.length > 3) {
    templateIds = templateIds.slice(0, 3)
  }
  if (!wx.requestSubscribeMessage) {
    if (opts.onDone) opts.onDone({ accepted: [], declined: templateIds })
    return
  }

  wx.requestSubscribeMessage({
    tmplIds: templateIds,
    success: function (res) {
      var accepted = []
      var declined = []
      for (var i = 0; i < templateIds.length; i++) {
        var tid = templateIds[i]
        var status = res[tid]
        if (opts.onResult) { try { opts.onResult(tid, status) } catch (e) {} }
        if (status === 'accept') {
          accepted.push(tid)
          // 后端记 quota+1（不等返回）
          request({
            url: '/api/subscribe/grant',
            method: 'POST',
            data: { templateId: tid },
            fail: function () { /* 静默 */ }
          })
        } else {
          declined.push(tid)
          _markDeclined(tid)
        }
      }
      if (opts.onDone) opts.onDone({ accepted: accepted, declined: declined })
    },
    fail: function () {
      for (var i = 0; i < templateIds.length; i++) _markDeclined(templateIds[i])
      if (opts.onDone) opts.onDone({ accepted: [], declined: templateIds })
    },
  })
}

module.exports = {
  TEMPLATES: TEMPLATES,
  requestSubscribe: requestSubscribe,
  requestSubscribeBatch: requestSubscribeBatch,
}
