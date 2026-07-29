/**
 * 呼叫小智 — 小程序对话页
 */
const request = require('../../utils/request')
const config = require('../../utils/config')
const session = require('../../utils/session')
const remoteConfig = require('../../utils/remoteConfig')

/**
 * UTF-8 解码 Uint8Array → string
 * 不依赖 TextDecoder（体验版/真机 JSCore 可能没有）。
 * stream=true 时保留尾部不完整的多字节序列，下次调用继续拼。
 */
function createUtf8Decoder() {
  let pending = []
  return {
    decode: function (bytes, opts) {
      const input = pending.length ? pending.concat(Array.from(bytes)) : Array.from(bytes)
      pending = []
      const chars = []
      let i = 0
      while (i < input.length) {
        var b = input[i]
        var need = 0, cp = 0
        if (b < 0x80) { cp = b; need = 0 }
        else if ((b & 0xE0) === 0xC0) { cp = b & 0x1F; need = 1 }
        else if ((b & 0xF0) === 0xE0) { cp = b & 0x0F; need = 2 }
        else if ((b & 0xF8) === 0xF0) { cp = b & 0x07; need = 3 }
        else { i++; continue }
        if (i + 1 + need > input.length) {
          // 不够字节 → 留到下次
          if (opts && opts.stream) { pending = input.slice(i); break }
          else { i++; continue }
        }
        for (var j = 1; j <= need; j++) cp = (cp << 6) | (input[i + j] & 0x3F)
        if (cp <= 0xFFFF) chars.push(String.fromCharCode(cp))
        else {
          cp -= 0x10000
          chars.push(String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)))
        }
        i += 1 + need
      }
      return chars.join('')
    }
  }
}

// 欢迎区示例问题（6 条，覆盖 6 个常见产业场景）
const WELCOME_EXAMPLES = [
  { text: '食品安全现行国标有哪些？' },
  { text: 'GB 18030 是什么标准？' },
  { text: '电动汽车充电接口标准' },
  { text: '帮我写一份健身器材可靠性试验标准' },
  { text: '智能家居通信协议' },
  { text: '建筑节能设计最新规范' },
]

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/chat/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    messages: [],
    conversations: [],
    currentConvId: null,
    inputValue: '',
    isStreaming: false,
    showWelcome: true,
    showHistory: false,
    scrollToId: '',
    remainingQuota: 5,
    isFree: true,
    inputPlaceholder: '问小智：标准号、名称或具体问题',
    welcomeExamples: WELCOME_EXAMPLES,
  },

  onLoad() {
    if (!session.getToken()) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    this._didAutoLoadLatest = false
    this.loadConversations()
    this._checkMemberTier()
  },

  onShow() {
    // 强刷会员状态
    if (session.getToken()) {
      this._refreshMemberFromServer()
    }
    // 接收首页 hero 通过 globalData 传入的 query（switchTab 不能带参数）
    var app = getApp()
    var pending = app.globalData && app.globalData.pendingChatQuery
    if (pending) {
      app.globalData.pendingChatQuery = null
      var self = this
      this.setData({ inputValue: pending })
      setTimeout(function () { self.sendMessage() }, 150)
    }
  },

  _refreshMemberFromServer() {
    const self = this
    request({ url: '/api/app/profile', method: 'GET' }).then(function (res) {
      const cached = session.getUser() || {}
      const m = res && res.data && res.data.membership
      if (m && m.status === 'ACTIVE' && m.plan) {
        cached.memberTier = m.plan.id || 'free'
        cached.memberExpire = m.endAt
      } else {
        cached.memberTier = 'free'
        cached.memberExpire = null
      }
      session.setUser(cached)
      self._checkMemberTier()
    }).catch(function () { /* 静默：网络失败时回退本地缓存，不阻塞页面 */ })
  },

  _checkMemberTier() {
    const user = session.getUser()
    const tier = user && user.memberTier
    const isFree = !tier || tier === 'free'
    this.setData({ isFree })
  },

  async loadConversations() {
    try {
      const res = await request({ url: '/api/app/chat/conversations', method: 'GET' })
      const list = res.data || []
      const conversations = list.map(c => ({
        ...c,
        timeLabel: _formatTime(c.updatedAt),
      }))
      this.setData({ conversations })

      // 进入页面后首次拉列表时，有历史则自动切到最近一条；无历史保持 welcome state
      // 守卫：只触发一次，避免之后 loadConversations（新建/发送后）覆盖用户意图
      if (!this._didAutoLoadLatest && conversations.length > 0 && !this.data.currentConvId) {
        this._didAutoLoadLatest = true
        await this._doSwitchConversation(conversations[0].id)
      }
    } catch (e) {
      console.error('加载会话失败', e)
    }
  },

  async createConversation() {
    try {
      const res = await request({ url: '/api/app/chat/conversations', method: 'POST' })
      const conv = res.data || res
      this.setData({
        currentConvId: conv.id,
        messages: [],
        showWelcome: true,
        showHistory: false,
      })
      this.loadConversations()
    } catch (e) {
      console.error('创建会话失败', e)
    }
  },

  async switchConversation(e) {
    const convId = e.currentTarget.dataset.id
    await this._doSwitchConversation(convId)
  },

  async _doSwitchConversation(convId) {
    this.setData({ currentConvId: convId, showHistory: false })
    try {
      const res = await request({ url: `/api/app/chat/history/${convId}`, method: 'GET' })
      const data = res.data || []
      const messages = data.map(m => ({
        role: m.role,
        content: m.content,
        intent: m.intent,
      }))
      this.setData({
        messages,
        showWelcome: messages.length === 0,
      })
      this.scrollToBottom()
    } catch (e) {
      console.error('加载历史失败', e)
    }
  },

  toggleHistory() {
    this.setData({ showHistory: !this.data.showHistory })
  },

  // ── 会话管理：长按弹出操作菜单 ──
  onConvLongPress(e) {
    const convId = e.currentTarget.dataset.id
    const convTitle = e.currentTarget.dataset.title || '新对话'
    const that = this
    wx.showActionSheet({
      itemList: ['重命名', '删除'],
      success(res) {
        if (res.tapIndex === 0) {
          that._renameConversation(convId, convTitle)
        } else if (res.tapIndex === 1) {
          that._deleteConversation(convId)
        }
      },
    })
  },

  _renameConversation(convId, oldTitle) {
    const that = this
    wx.showModal({
      title: '重命名会话',
      editable: true,
      placeholderText: '输入新标题',
      content: oldTitle,
      success: async (res) => {
        if (!res.confirm) return
        const newTitle = (res.content || '').trim()
        if (!newTitle) {
          wx.showToast({ title: '标题不能为空', icon: 'none' })
          return
        }
        try {
          await request({
            url: `/api/app/chat/conversations/${convId}`,
            method: 'PATCH',
            data: { title: newTitle },
          })
          that.loadConversations()
        } catch (e) {
          wx.showToast({ title: '重命名失败', icon: 'none' })
        }
      },
    })
  },

  _deleteConversation(convId) {
    const that = this
    wx.showModal({
      title: '删除确认',
      content: '删除后不可恢复，确定删除？',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request({
            url: `/api/app/chat/conversations/${convId}`,
            method: 'DELETE',
          })
          // 如果删的是当前会话，清空消息区
          if (that.data.currentConvId === convId) {
            that.setData({
              currentConvId: null,
              messages: [],
              showWelcome: true,
            })
          }
          that.loadConversations()
        } catch (e) {
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      },
    })
  },

  onInputChange(e) {
    this.setData({ inputValue: e.detail.value })
  },

  async sendMessage() {
    const msg = this.data.inputValue.trim()
    if (!msg || this.data.isStreaming) return

    if (!session.getToken()) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }

    // 如果没有当前会话，先创建
    let convId = this.data.currentConvId
    if (!convId) {
      try {
        const res = await request({ url: '/api/app/chat/conversations', method: 'POST' })
        const conv = res.data || res
        convId = conv.id
        this.setData({ currentConvId: convId })
        this.loadConversations()
      } catch (e) {
        wx.showToast({ title: '创建会话失败', icon: 'none' })
        return
      }
    }

    const userMsg = { role: 'user', content: msg }
    const assistantMsg = { role: 'assistant', content: '', isStreaming: true }
    this.setData({
      inputValue: '',
      showWelcome: false,
      isStreaming: true,
      messages: [...this.data.messages, userMsg, assistantMsg],
    })
    this.scrollToBottom()

    const token = session.getToken()
    const user = session.getUser()
    const that = this
    let buffer = ''
    let assistantContent = ''

    const requestTask = wx.request({
      url: `${config.API_BASE}/api/app/chat/send`,
      method: 'POST',
      enableChunked: true,
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-user-id': user ? user.id : '',
      },
      data: { conversationId: convId, message: msg },
      timeout: 120000,
      success() {
        // 流式处理在 onChunkReceived 中完成
      },
      fail(err) {
        console.error('chat fail', err)
        that.setData({ isStreaming: false })
        wx.showToast({ title: '发送失败', icon: 'none' })
      },
    })

    const _decoder = createUtf8Decoder()

    requestTask.onChunkReceived(function(res) {
      const bytes = new Uint8Array(res.data)
      const text = _decoder.decode(bytes, { stream: true })
      buffer += text

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const json = line.slice(6).trim()
        if (!json) continue

        try {
          const event = JSON.parse(json)
          switch (event.type) {
            case 'answer_chunk': {
              assistantContent += event.content
              const msgs = that.data.messages.slice()
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: assistantContent }
              that.setData({ messages: msgs })
              that.scrollToBottom()
              break
            }
            case 'guardrail_blocked': {
              // 橙色警告文案 + 官方链接 + 建议词
              let blockedText = event.content || ''
              if (event.officialLinks && event.officialLinks.length > 0) {
                blockedText += '\n' + event.officialLinks.map(l => '• ' + l.label + ': ' + l.url).join('\n')
              }
              assistantContent = blockedText
              const blockedSuggestions = (event.suggestions || []).map(s => ({ text: s, label: s }))
              const msgs2 = that.data.messages.slice()
              msgs2[msgs2.length - 1] = { ...msgs2[msgs2.length - 1], content: blockedText, isBlocked: true, suggestions: blockedSuggestions }
              that.setData({ messages: msgs2 })
              break
            }
            case 'search_results': {
              if (event.items && event.items.length > 0) {
                const msgs3 = that.data.messages.slice()
                const lastMsg = msgs3[msgs3.length - 1]
                const searchItems = (lastMsg.searchItems || []).concat(event.items)
                msgs3[msgs3.length - 1] = { ...lastMsg, searchItems }
                that.setData({ messages: msgs3 })
                that.scrollToBottom()
              }
              break
            }
            case 'web_search_started': {
              const msgsW1 = that.data.messages.slice()
              msgsW1[msgsW1.length - 1] = { ...msgsW1[msgsW1.length - 1], statusMessage: event.message || '联网搜索中...' }
              that.setData({ messages: msgsW1 })
              break
            }
            case 'web_search_results': {
              if (event.items && event.items.length > 0) {
                const msgsW2 = that.data.messages.slice()
                const lastMsgW = msgsW2[msgsW2.length - 1]
                const webSearchItems = (event.items || []).map(s => ({
                  title: s.title || '',
                  url: s.url || '',
                  siteName: s.site_name || '',
                }))
                msgsW2[msgsW2.length - 1] = { ...lastMsgW, webSearchItems, webSearchNote: event.note || '' }
                that.setData({ messages: msgsW2 })
                that.scrollToBottom()
              }
              break
            }
            case 'confidence_marker': {
              // 三级置信度：🟢 本地标准库 / 🟡 联网搜索 / 🔴 AI 推断
              // 渲染到 message 顶部（wxml 中 message.confidenceEmoji + confidenceLabel）
              const msgsC = that.data.messages.slice()
              msgsC[msgsC.length - 1] = {
                ...msgsC[msgsC.length - 1],
                confidenceLevel: event.level,
                confidenceEmoji: event.emoji,
                confidenceLabel: event.label,
              }
              that.setData({ messages: msgsC })
              break
            }
            case 'task_list': {
              if (event.tasks && event.tasks.length > 0) {
                const statusMap = {
                  PENDING:    remoteConfig.getCopy('status', 'PENDING',    '排队中'),
                  PROCESSING: remoteConfig.getCopy('status', 'PROCESSING', '处理中'),
                  COMPLETED:  remoteConfig.getCopy('status', 'COMPLETED',  '已完成'),
                  FAILED:     remoteConfig.getCopy('status', 'FAILED',     '失败'),
                }
                const taskItems = event.tasks.map(t => ({
                  documentName: t.documentName,
                  taskNo: t.taskNo,
                  status: t.status,
                  statusLabel: statusMap[t.status] || t.status,
                }))
                const msgs4 = that.data.messages.slice()
                const lastMsg4 = msgs4[msgs4.length - 1]
                msgs4[msgs4.length - 1] = { ...lastMsg4, taskItems }
                that.setData({ messages: msgs4 })
                that.scrollToBottom()
              }
              break
            }
            case 'action_suggested': {
              if (event.action === 'send_message' && event.text) {
                const msgs5 = that.data.messages.slice()
                const lastMsg = msgs5[msgs5.length - 1] || {}
                const suggestions = Array.isArray(lastMsg.suggestions) ? lastMsg.suggestions.slice() : []
                suggestions.push({ text: event.text, label: event.label || event.text })
                msgs5[msgs5.length - 1] = { ...lastMsg, suggestions }
                that.setData({ messages: msgs5 })
                break
              }
              // 小程序：只处理 redirect 类型（/pages/ 开头可直接跳转）
              if (event.action === 'redirect' && event.url && event.url.startsWith('/pages/')) {
                that._pendingAction = { url: event.url, label: event.label }
              }
              break
            }
            case 'quota_info': {
              if (event.tier === 'free' && event.remaining !== null) {
                that.setData({ remainingQuota: event.remaining, isFree: true })
              } else {
                that.setData({ isFree: false })
              }
              break
            }
            case 'conversation_updated': {
              that.loadConversations()
              break
            }
            case 'intent_detected': {
              const msgs_id = that.data.messages.slice()
              msgs_id[msgs_id.length - 1] = { ...msgs_id[msgs_id.length - 1], intent: event.intent }
              that.setData({ messages: msgs_id })
              break
            }
            case 'search_started': {
              // 状态指示
              const msgs_ss = that.data.messages.slice()
              msgs_ss[msgs_ss.length - 1] = { ...msgs_ss[msgs_ss.length - 1], statusMessage: event.message }
              that.setData({ messages: msgs_ss })
              break
            }
            case 'outline_done': {
              const msgs_od = that.data.messages.slice()
              msgs_od[msgs_od.length - 1] = { ...msgs_od[msgs_od.length - 1], showOutlineActions: true }
              that.setData({ messages: msgs_od })
              break
            }
            case 'framework_done': {
              const msgs_fd = that.data.messages.slice()
              msgs_fd[msgs_fd.length - 1] = { ...msgs_fd[msgs_fd.length - 1], showFrameworkDone: true }
              that.setData({ messages: msgs_fd })
              break
            }
            case 'done': {
              const msgsEnd = that.data.messages.slice()
              msgsEnd[msgsEnd.length - 1] = { ...msgsEnd[msgsEnd.length - 1], isStreaming: false }
              that.setData({ messages: msgsEnd, isStreaming: false })
              break
            }
            case 'error': {
              wx.showToast({ title: event.message || '出错了', icon: 'none' })
              that.setData({ isStreaming: false })
              break
            }
          }
        } catch (e) { /* 忽略解析错误 */ }
      }
    })
  },

  scrollToBottom() {
    this.setData({ scrollToId: 'msg-bottom' })
  },

  onTapExample(e) {
    const text = e.currentTarget.dataset.text
    this.setData({ inputValue: text })
    this.sendMessage()
  },

  onTapSuggestion(e) {
    const text = e.currentTarget.dataset.text
    if (!text || this.data.isStreaming) return
    this.setData({ inputValue: text })
    this.sendMessage()
  },

  // 确认大纲 → 调后端生成框架
  async confirmOutline(e) {
    const msgIdx = e.currentTarget.dataset.msgidx
    const msg = this.data.messages[msgIdx]
    if (!msg || !msg.content || this.data.isStreaming) return

    // 隐藏大纲按钮
    const msgs = this.data.messages.slice()
    msgs[msgIdx] = { ...msgs[msgIdx], showOutlineActions: false }

    const userMsg = { role: 'user', content: '确认大纲，生成标准框架' }
    const assistantMsg = { role: 'assistant', content: '', isStreaming: true }
    this.setData({
      messages: [...msgs, userMsg, assistantMsg],
      isStreaming: true,
    })
    this.scrollToBottom()

    const token = session.getToken()
    const that = this
    let buffer = ''
    let assistantContent = ''

    const requestTask = wx.request({
      url: `${config.API_BASE}/api/app/chat/std-generate`,
      method: 'POST',
      enableChunked: true,
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      data: { conversationId: this.data.currentConvId, outline: msg.content },
      timeout: 120000,
      success(res) {
        // 403 = 免费用户无权限
        if (res.statusCode === 429 || res.statusCode === 403) {
          const allMsgs = that.data.messages.slice()
          allMsgs[allMsgs.length - 1] = {
            ...allMsgs[allMsgs.length - 1],
            content: '标准框架生成为会员专属功能，请升级会员后使用。',
            isStreaming: false,
          }
          that.setData({ messages: allMsgs, isStreaming: false })
        }
      },
      fail() {
        that.setData({ isStreaming: false })
        wx.showToast({ title: '生成失败', icon: 'none' })
      },
    })

    const _decoder2 = createUtf8Decoder()

    requestTask.onChunkReceived(function(res) {
      const bytes = new Uint8Array(res.data)
      const text = _decoder2.decode(bytes, { stream: true })
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const json = line.slice(6).trim()
        if (!json) continue
        try {
          const event = JSON.parse(json)
          if (event.type === 'answer_chunk') {
            assistantContent += event.content
            const allMsgs = that.data.messages.slice()
            allMsgs[allMsgs.length - 1] = { ...allMsgs[allMsgs.length - 1], content: assistantContent }
            that.setData({ messages: allMsgs })
            that.scrollToBottom()
          } else if (event.type === 'framework_done') {
            const allMsgs = that.data.messages.slice()
            allMsgs[allMsgs.length - 1] = { ...allMsgs[allMsgs.length - 1], showFrameworkDone: true }
            that.setData({ messages: allMsgs })
          } else if (event.type === 'done') {
            const allMsgs = that.data.messages.slice()
            allMsgs[allMsgs.length - 1] = { ...allMsgs[allMsgs.length - 1], isStreaming: false }
            that.setData({ messages: allMsgs, isStreaming: false })
          } else if (event.type === 'error') {
            wx.showToast({ title: event.message || '生成失败', icon: 'none' })
            that.setData({ isStreaming: false })
          }
        } catch (e) { /* ignore */ }
      }
    })
  },

  // 修改大纲 → 填入输入框
  editOutline(e) {
    const msgIdx = e.currentTarget.dataset.msgidx
    const msg = this.data.messages[msgIdx]
    if (!msg) return
    this.setData({
      inputValue: `请基于下面这个大纲帮我修改：\n\n${msg.content}\n\n我的修改要求是：`,
    })
  },

  goMembership() {
    wx.navigateTo({ url: '/pages/membership/index' })
  },

  onTapStandardCard(e) {
    const code = e.currentTarget.dataset.code
    if (code) {
      wx.navigateTo({ url: `/pages/detail/index?id=${encodeURIComponent(code)}` })
    }
  },
})

function _formatTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}-${day} ${h}:${min}`
}
