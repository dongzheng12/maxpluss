/**
 * 企业工作台 — 按 enterpriseRole 展示入口
 *  - ADMIN：我的任务 / 任务管理 / 成员管理
 *  - MANAGER：我的任务 / 任务管理
 *  - REVIEWER：我的任务
 * 入口由企业版登录（login）或 workspace「我的执行任务」按角色路由进入。
 */
const session = require('../../utils/session')

const ROLE_LABEL = { ADMIN: '管理员', MANAGER: '负责人', REVIEWER: '审核人', EMPLOYEE: '员工' }

Page({
  data: {
    roleLabel: '',
    entries: [],
  },

  onShow() {
    if (!session.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index?tab=enterprise' })
      return
    }
    const user = session.getUser() || {}
    const role = user.enterpriseRole || 'EMPLOYEE'
    this.setData({ roleLabel: ROLE_LABEL[role] || role, entries: this._entriesForRole(role) })
  },

  _entriesForRole(role) {
    const myTasks = { key: 'tasks', label: '我的任务', desc: '查看并完成分配给我的执行任务', icon: '📋' }
    const taskMgmt = { key: 'task-mgmt', label: '任务管理', desc: '查看合规周期与任务分配', icon: '🗂' }
    const memberMgmt = { key: 'members', label: '成员管理', desc: '查看企业成员', icon: '👥' }
    const changePwd = { key: 'change-password', label: '修改密码', desc: '修改本人登录密码', icon: '🔑' }
    if (role === 'ADMIN') return [myTasks, taskMgmt, memberMgmt, changePwd]
    if (role === 'MANAGER') return [myTasks, taskMgmt, changePwd]
    return [myTasks, changePwd] // REVIEWER / 其他
  },

  tapEntry(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'tasks') {
      wx.navigateTo({ url: '/pages/standard-execution/tasks/index' })
    } else if (key === 'change-password') {
      wx.navigateTo({ url: '/pages/change-password/index' })
    } else {
      // 任务管理 / 成员管理子页面即将上线，当前引导至管理后台
      wx.showToast({ title: '该功能请在管理后台使用', icon: 'none', duration: 2500 })
    }
  },

  onShareAppMessage() {
    return { title: '标准小智 — 企业工作台', path: '/pages/enterprise-home/index' }
  },
})
