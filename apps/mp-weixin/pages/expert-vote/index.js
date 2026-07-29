/**
 * 专家评审投票 — 列表页（P0-2A）
 *
 * 入口：受远程菜单 expert-vote.visible 控制（appRoutes.ts:1074），P0-2A 阶段保持 visible=false。
 * 本页仅做"查看已发起的申请"，发起申请 / 支付 / 取消 等动作放 P0-2B。
 */
const request = require('../../utils/request')
const session = require('../../utils/session')
const remoteConfig = require('../../utils/remoteConfig')

const STATUS_LABEL = {
  DRAFT: '草稿',
  PAYING: '支付中',
  EXPERT_ARRANGING: '专家组织中',
  MEETING_SCHEDULED: '会议已定',
  VOTING: '会后结果整理中',
  VOTED: '整理已完成',
  SIGNING: '确认文件处理中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

const STATUS_CLASS = {
  DRAFT: 'tag-default',
  PAYING: 'tag-warning',
  EXPERT_ARRANGING: 'tag-processing',
  MEETING_SCHEDULED: 'tag-cyan',
  VOTING: 'tag-blue',
  VOTED: 'tag-blue',
  SIGNING: 'tag-purple',
  COMPLETED: 'tag-success',
  CANCELLED: 'tag-default',
  REFUNDED: 'tag-warning',
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/expert-vote/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    items: [],
    loading: true,
    notLoggedIn: false,
    landingSubtitle: '多领域专家资源支持，协助企业组织线上评审与投票，会后交付专家意见与投票结果确认文件。',
    processSummary: '支付完成后，平台业务人员将组织专家并回填会议安排，会后形成最终交付文件。',
    ctaHint: '提交前可查看预计金额，最终费用以订单确认为准。',
  },
  onShow() {
    this._applyRemoteCopy()
    if (!session.getToken()) {
      this.setData({ notLoggedIn: true, loading: false, items: [] })
      return
    }
    this.load()
  },
  _applyRemoteCopy() {
    this.setData({
      landingSubtitle: remoteConfig.getCopy('expert_vote', 'landing_subtitle', '多领域专家资源支持，协助企业组织线上评审与投票，会后交付专家意见与投票结果确认文件。'),
      processSummary: remoteConfig.getCopy('expert_vote', 'process_summary', '支付完成后，平台业务人员将组织专家并回填会议安排，会后形成最终交付文件。'),
      ctaHint: remoteConfig.getCopy('expert_vote', 'cta_hint', '提交前可查看预计金额，最终费用以订单确认为准。'),
    })
  },
  load() {
    this.setData({ loading: true, notLoggedIn: false })
    request({
      url: '/api/app/expert-votes',
      method: 'GET',
    }).then((res) => {
      const items = (res.data && res.data.items) || []
      const enriched = items.map((it) => {
        const hasFinalFile = !!(it.finalDeliverablePath || it.signedPdfPath)
        return {
          ...it,
          statusLabel: STATUS_LABEL[it.status] || it.status,
          statusClass: STATUS_CLASS[it.status] || 'tag-default',
          // 状态机 × 操作项矩阵：每个状态只暴露 1 个主操作 + 必要次操作
          showEdit: it.status === 'DRAFT',                          // DRAFT 主：继续填写
          showPay: it.status === 'PAYING',                          // PAYING 主：去支付
          // 仅 MEETING_SCHEDULED 把"查看会议"作为主操作
          showMeetingBtn: it.status === 'MEETING_SCHEDULED',
          // COMPLETED 且最终交付文件已上传 → 主操作"下载最终交付文件"
          showDownload: it.status === 'COMPLETED' && hasFinalFile,
          // EXPERT_ARRANGING / VOTING / VOTED / SIGNING / COMPLETED(无文件) / CANCELLED / REFUNDED → 查看
          showDetail: ['EXPERT_ARRANGING', 'VOTING', 'VOTED', 'SIGNING', 'CANCELLED', 'REFUNDED'].indexOf(it.status) >= 0
            || (it.status === 'COMPLETED' && !hasFinalFile),
          amountYuan: typeof it.totalAmount === 'number' ? (it.totalAmount / 100).toFixed(0) : '-',
          desiredDateText: it.desiredDate ? formatDate(it.desiredDate) : '',
          createdAtText: it.createdAt ? formatDateTime(it.createdAt) : '',
        }
      })
      this.setData({ items: enriched, loading: false })
    }).catch(() => {
      this.setData({ loading: false })
    })
  },
  goCreate() {
    wx.navigateTo({ url: '/pages/expert-vote/edit/index' })
  },
  deleteDraft(e) {
    const no = e.currentTarget.dataset.no
    if (!no) return
    const self = this
    wx.showModal({
      title: '删除草稿？',
      content: '删除后无法恢复，已上传材料一并清除。',
      confirmText: '删除',
      confirmColor: '#f53f3f',
      cancelText: '取消',
      success(r) {
        if (!r.confirm) return
        request({
          url: `/api/app/expert-votes/${no}`,
          method: 'DELETE',
        }).then((res) => {
          if (res.statusCode === 200) {
            wx.showToast({ title: '草稿已删除' })
            self.load()
          } else {
            wx.showToast({ title: (res.data && res.data.error) || '删除失败', icon: 'none' })
          }
        }).catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
      },
    })
  },
  goEdit(e) {
    const no = e.currentTarget.dataset.no
    if (!no) return
    wx.navigateTo({ url: `/pages/expert-vote/edit/index?no=${no}` })
  },
  goPay(e) {
    const no = e.currentTarget.dataset.no
    const item = this.data.items.find((x) => x.requestNo === no)
    if (!item || !item.orderNo) {
      return wx.showToast({ title: '订单未生成', icon: 'none' })
    }
    const amountYuan = (item.totalAmount / 100).toFixed(2)
    const title = encodeURIComponent(item.projectName || '专家评审投票')
    wx.navigateTo({
      url: `/pages/payment/index?flow=expertVote&orderNo=${item.orderNo}&amount=${amountYuan}&title=${title}&requestNo=${no}`,
    })
  },
  goDetail(e) {
    const no = e.currentTarget.dataset.no
    if (!no) return
    wx.navigateTo({ url: `/pages/expert-vote/detail/index?no=${no}` })
  },
  goDownload(e) {
    const no = e.currentTarget.dataset.no
    if (!no) return
    const config = require('../../utils/config')
    const session = require('../../utils/session')
    const token = session.getToken()
    wx.showLoading({ title: '下载中...', mask: true })
    wx.downloadFile({
      url: `${config.API_BASE}/api/app/expert-votes/${no}/download-final`,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        wx.hideLoading()
        if (res.statusCode === 200) {
          wx.openDocument({
            filePath: res.tempFilePath,
            success() {},
            fail() { wx.showToast({ title: '打开失败，请稍后再试', icon: 'none' }) },
          })
        } else {
          wx.showToast({ title: '下载失败：' + res.statusCode, icon: 'none' })
        }
      },
      fail() {
        wx.hideLoading()
        wx.showToast({ title: '网络错误，下载失败', icon: 'none' })
      },
    })
  },
  goMeeting(e) {
    const no = e.currentTarget.dataset.no
    if (!no) return
    wx.navigateTo({ url: `/pages/expert-vote/meeting/index?no=${no}` })
  },
  goLogin() {
    wx.reLaunch({ url: '/pages/profile/index' })
  },
  onPullDownRefresh() {
    this.load()
    setTimeout(() => wx.stopPullDownRefresh(), 600)
  },
})

function pad(n) { return String(n).padStart(2, '0') }
function formatDate(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function formatDateTime(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
