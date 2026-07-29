/**
 * 呼叫小智 — 对话路由（SSE 流式响应）
 * SSE 协议 v2：严格按产出设计方案-v2 事件名
 */
import { Router } from 'express'
import { prisma } from '../db.js'
import { requireAuth, type AuthRequest } from '../auth.js'
import { checkGuardrail, createOutboundGuard, SYSTEM_GUARDRAIL } from '../services/chatGuardrail.js'
import { detectUnsafeContent, SAFETY_BLOCKED_REPLY } from '../services/contentSafety.js'
import { detectIntent } from '../services/chatIntent.js'
import { buildZeroResultReply, buildZeroResultSuggestions, searchStandards, shouldFallbackToWeb, streamRelatedSummary, streamSearchSummary } from '../services/chatSearch.js'
import { callLLM, callLLMStream, callQwenWithSearchStream, LLM_FALLBACK_REPLY, type SearchSource } from '../services/llm.js'
import { streamWriteOutline, streamWriteFramework, fetchReferenceStandards } from '../services/chatStdWriting.js'
import { extractStandardCodes, verifyStandardCodes } from '../services/stdReferenceValidator.js'
import { buildStdFrameworkDocx } from '../services/stdFrameworkDocx.js'
import { trackServerEvent, trackSearchSuccess, markUserActive } from '../tracker.js'

const router = Router()

// 所有对话接口需要登录
router.use(requireAuth)

// ─── 新建会话 ─────────────────────────────────────────────

router.post('/conversations', async (req: AuthRequest, res) => {
  try {
    const conv = await prisma.conversation.create({
      data: { userId: req.userId! },
    })
    res.json(conv)
  } catch (err) {
    console.error('[Chat] 创建会话失败', err)
    res.status(500).json({ error: '创建会话失败' })
  }
})

// ─── 会话列表 ─────────────────────────────────────────────

router.get('/conversations', async (req: AuthRequest, res) => {
  try {
    const list = await prisma.conversation.findMany({
      where: { userId: req.userId! },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })
    res.json(list)
  } catch (err) {
    console.error('[Chat] 获取会话列表失败', err)
    res.status(500).json({ error: '获取会话列表失败' })
  }
})

// ─── 重命名会话 ───────────────────────────────────────────

router.patch('/conversations/:conversationId', async (req: AuthRequest, res) => {
  try {
    const convId = req.params.conversationId as string
    const rawTitle = typeof req.body?.title === 'string' ? req.body.title : ''
    const title = rawTitle.trim().slice(0, 50)
    if (!title) return res.status(400).json({ error: '标题不能为空' })

    const conv = await prisma.conversation.findFirst({
      where: { id: convId, userId: req.userId! },
    })
    if (!conv) return res.status(404).json({ error: '会话不存在' })

    const updated = await prisma.conversation.update({
      where: { id: convId },
      data: { title, updatedAt: new Date() },
    })
    res.json(updated)
  } catch (err) {
    console.error('[Chat] 重命名会话失败', err)
    res.status(500).json({ error: '重命名会话失败' })
  }
})

// ─── 删除会话 ─────────────────────────────────────────────

router.delete('/conversations/:conversationId', async (req: AuthRequest, res) => {
  try {
    const convId = req.params.conversationId as string
    const conv = await prisma.conversation.findFirst({
      where: { id: convId, userId: req.userId! },
    })
    if (!conv) return res.status(404).json({ error: '会话不存在' })

    // 先删消息，再删会话
    await prisma.chatMessage.deleteMany({ where: { conversationId: convId } })
    await prisma.conversation.delete({ where: { id: convId } })
    res.json({ success: true })
  } catch (err) {
    console.error('[Chat] 删除会话失败', err)
    res.status(500).json({ error: '删除会话失败' })
  }
})

// ─── 对话历史 ─────────────────────────────────────────────

router.get('/history/:conversationId', async (req: AuthRequest, res) => {
  try {
    const conv = await prisma.conversation.findFirst({
      where: { id: req.params.conversationId as string, userId: req.userId! },
    })
    if (!conv) return res.status(404).json({ error: '会话不存在' })

    const messages = await prisma.chatMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    res.json(messages)
  } catch (err) {
    console.error('[Chat] 获取历史失败', err)
    res.status(500).json({ error: '获取对话历史失败' })
  }
})

// ─── SSE 辅助 ─────────────────────────────────────────────

function setupSSE(res: any) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  return (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
}

// ─── 发送消息（SSE 流式响应）──────────────────────────────

// 用户级频率限制：同一用户 2 秒内不能重复发送
const chatLastSend = new Map<string, number>()

// IP 级速率限制：防止同一 IP 多账号刷 LLM 额度（20 req/min/IP）
const chatIpBuckets = new Map<string, { count: number; resetAt: number }>()
const CHAT_IP_MAX = 20
const CHAT_IP_WINDOW = 60_000

// ─── 来源置信度三级标注（方案 §3.5）─────────────────────────
// SSE 协议 confidence_marker 事件载荷，在 intent_detected 之后、answer_chunk
// 之前发出，前端用 emoji + 文字 badge 渲染在 message 顶部，告知用户本次回答
// 的信息来源可信度。
//
//   🟢 high   ── 本地标准元数据库直接命中（search exact/related）
//   🟡 medium ── 联网搜索结果（web fallback 成功返回 sources）
//   🔴 low    ── 纯 LLM 推理 / AI 辅助生成（chat 闲聊兜底 / write 起草 /
//                web fallback 失败降级到本地引导词）
type ConfidenceLevel = 'high' | 'medium' | 'low'
interface ConfidenceMarker {
  level: ConfidenceLevel
  emoji: '🟢' | '🟡' | '🔴'
  label: string          // 顶部 badge 文字
  disclaimer: string     // 文末固定提示（兜底拼接，独立 answer_chunk）
}
const CONFIDENCE_MARKERS: Record<ConfidenceLevel, ConfidenceMarker> = {
  high: {
    level: 'high',
    emoji: '🟢',
    label: '本地标准库',
    disclaimer: '\n\n---\n*🟢 本回答基于本地标准元数据库（仅含编号 / 名称 / 状态等基本信息），标准正文需通过官方渠道获取。*',
  },
  medium: {
    level: 'medium',
    emoji: '🟡',
    label: '联网搜索',
    disclaimer: '\n\n---\n*🟡 以上信息来自联网搜索，请以官方原文为准；不同来源结论可能存在出入。*',
  },
  low: {
    level: 'low',
    emoji: '🔴',
    label: 'AI 推断',
    disclaimer: '\n\n---\n*🔴 以上为 AI 推断 / 辅助生成，未对接权威数据源，请专家审核确认；不构成正式标准或合规建议。*',
  },
}

/**
 * 在每个 intent 分支结束前调用：发 confidence_marker SSE event +
 * 兜底拼接 disclaimer 作为最后一个 answer_chunk。
 *
 * 调用方需把返回的 disclaimer 拼到 fullReply（保证 saveMessages 入库的
 * assistant 内容也含末尾标注，复显历史时一致）。
 */
function emitConfidence(
  sendEvent: (e: Record<string, unknown>) => void,
  level: ConfidenceLevel,
): string {
  const m = CONFIDENCE_MARKERS[level]
  sendEvent({
    type: 'confidence_marker',
    level: m.level,
    emoji: m.emoji,
    label: m.label,
  })
  sendEvent({ type: 'answer_chunk', content: m.disclaimer })
  return m.disclaimer
}

/**
 * 判断文本是否涉及"标准/规范"主题。
 * 用于 chat 默认（闲聊）分支：纯闲聊不打 disclaimer，仅当 intent 误判把标准类问题
 * 落到闲聊时（含 GB/HJ/YY/ISO 等代号或"标准/规范/规程/国标..."关键词）才标 🔴。
 */
function containsStandardTopic(text: string): boolean {
  if (!text) return false
  if (/(标准|规范|规程|通则|国标|行标|地标|团标|企标|国家标准|行业标准|地方标准|团体标准|企业标准)/.test(text)) return true
  if (/\b(?:GB|GBZ|JJF|JJG|HJ|YY|YS|YD|DB|JG|JGJ|CJJ|CJ|JC|JT|JTG|JTS|NB|SY|SH|SL|LY|NY|WS|JY|QB|SN|TB|SJ|MH|DZ|EJ|FZ|XF|GA|GJB|HG|DL|EN|ISO|IEC|IEEE|ASTM|ANSI|JIS|DIN|BS)(?:\s*\/\s*[A-Z]+)?[\s\-]?\d{2,}/i.test(text)) return true
  return false
}

function getChatClientIp(req: any): string {
  const xff = req.headers['x-forwarded-for']
  return (Array.isArray(xff) ? xff[0] : xff?.split(',')[0]) || req.socket?.remoteAddress || 'unknown'
}
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of chatIpBuckets.entries()) {
    if (now > v.resetAt) chatIpBuckets.delete(k)
  }
}, 5 * 60 * 1000)

router.post('/send', async (req: AuthRequest, res) => {
  const { conversationId, message } = req.body
  if (!conversationId || !message || typeof message !== 'string' || message.length > 2000) {
    return res.status(400).json({ error: '参数错误' })
  }

  // IP 级限速（防同 IP 多账号刷接口）
  const ip = getChatClientIp(req)
  const now = Date.now()
  const bucket = chatIpBuckets.get(ip)
  if (!bucket || now > bucket.resetAt) {
    chatIpBuckets.set(ip, { count: 1, resetAt: now + CHAT_IP_WINDOW })
  } else if (bucket.count >= CHAT_IP_MAX) {
    return res.status(429).json({ error: '当前网络请求过于频繁，请稍后再试' })
  } else {
    bucket.count++
  }

  // 用户级频率限制
  const lastSend = chatLastSend.get(req.userId!) || 0
  if (now - lastSend < 2000) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
  }
  chatLastSend.set(req.userId!, now)

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: req.userId! },
  })
  if (!conv) return res.status(404).json({ error: '会话不存在' })

  // 每日额度检查（免费用户 5 次/天）
  const quotaCheck = await checkDailyQuota(req.userId!)
  if (!quotaCheck.allowed) {
    return res.status(429).json({ error: quotaCheck.message })
  }

  // 先保存用户消息 + 空 assistant 占位（防止流中断丢消息）
  const [savedUserMsg, savedAssistantMsg] = await prisma.$transaction([
    prisma.chatMessage.create({ data: { conversationId, role: 'user', content: message, intent: 'pending' } }),
    prisma.chatMessage.create({ data: { conversationId, role: 'assistant', content: '', intent: 'pending' } }),
  ])

  const sendEvent = setupSSE(res)

  // 监听客户端断开，设置中止标志
  let aborted = false
  req.on('close', () => { aborted = true })

  try {
    // session_started
    sendEvent({ type: 'session_started', conversationId })

    // 1. 红线拦截
    const guard = checkGuardrail(message)
    if (guard.blocked) {
      console.log(`[Chat] blocked: userId=${req.userId}`)
      await updateSavedMessages(savedUserMsg.id, savedAssistantMsg.id, message, guard.reply!, 'blocked')
      sendEvent({ type: 'intent_detected', intent: 'blocked' })
      sendEvent({
        type: 'guardrail_blocked',
        content: '抱歉，我无法提供标准正文、具体条款或技术参数内容。\n\n根据版权规定，标准全文需通过官方渠道获取：',
        officialLinks: [
          { label: '国家标准全文公开系统', url: 'https://openstd.samr.gov.cn' },
          { label: '中国标准出版社', url: 'https://www.spc.org.cn' },
          { label: '全国标准信息公共服务平台', url: 'https://std.samr.gov.cn' },
        ],
        suggestions: ['帮我查一下该标准的基本信息', '该标准目前是什么状态'],
      })
      await sendQuotaInfo(sendEvent, req.userId!)
      await sendConversationUpdated(sendEvent, conv, conversationId, message)
      sendEvent({ type: 'done' })
      res.end()
      return
    }

    // 1b. 内容安全（政治 / 色情 / 涉枪涉爆）
    const safety = detectUnsafeContent(message)
    if (safety) {
      console.log(`[Chat] safety_blocked: userId=${req.userId} category=${safety.category} hit=${safety.hit}`)
      await updateSavedMessages(savedUserMsg.id, savedAssistantMsg.id, message, SAFETY_BLOCKED_REPLY, 'blocked')
      sendEvent({ type: 'intent_detected', intent: 'blocked' })
      sendEvent({
        type: 'guardrail_blocked',
        content: SAFETY_BLOCKED_REPLY,
        category: safety.category,
        suggestions: ['请换一种表述', '查询某个具体标准的基本信息'],
      })
      await sendQuotaInfo(sendEvent, req.userId!)
      await sendConversationUpdated(sendEvent, conv, conversationId, message)
      sendEvent({ type: 'done' })
      res.end()
      return
    }

    // 2. 意图识别
    const intent = await detectIntent(message)
    console.log(`[Chat] intent: userId=${req.userId} intent=${intent.intent} keywords=[${(intent.keywords || []).join(',')}]`)
    sendEvent({ type: 'intent_detected', intent: intent.intent, keywords: intent.keywords })

    // 2b. 统一加载历史（在意图分流前一次性拉 + 压缩，所有分支共用）
    //     排除当前刚 save 的 user/assistant 占位行
    const chatHistory = await loadChatHistory(conversationId, [savedUserMsg.id, savedAssistantMsg.id])
    console.log(`[Chat] history: userId=${req.userId} msgs=${chatHistory.length} chars=${chatHistory.reduce((s, m) => s + m.content.length, 0)}`)

    // 3. 根据意图分流处理
    let fullReply = ''

    // 连续 0 结果计数 + 已失败推荐词追踪（从本会话历史推断）
    let zeroCount = 0
    const failedTerms = new Set<string>()
    if (intent.intent === 'search') {
      try {
        const recentMsgs = await prisma.chatMessage.findMany({
          where: { conversationId, intent: 'search' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { role: true, content: true },
        })
        // 从最近的 assistant 消息中检测连续 0 结果
        for (const m of recentMsgs) {
          if (m.role === 'assistant' && (m.content.includes('没有直接匹配') || m.content.includes('没有直接命中') || m.content.includes('仍然没有'))) {
            zeroCount++
          } else if (m.role === 'assistant') {
            break // 遇到非 0 结果的 assistant 消息就停
          }
          // 收集用户已发送过的搜索词（即失败过的词）
          if (m.role === 'user') {
            failedTerms.add(m.content.trim())
          }
        }
      } catch { /* 查询失败不影响主流程 */ }
    }

    switch (intent.intent) {
      case 'search': {
        sendEvent({ type: 'search_started', message: '正在检索标准库...', stage: 'search' })
        const query = intent.standardNo || (intent.keywords || []).join(' ')
        const { hits, searchResultsEvent, matchQuality, searchTimedOut } = await searchStandards(query, intent.keywords || [])
        console.log(`[Chat] search: query="${query}" matchQuality=${matchQuality} hits=${hits.length} zeroCount=${zeroCount}`)

        // 埋点：search_success（仅有效命中才算成功；empty/timeout 不打）
        if (matchQuality !== 'empty' && !searchTimedOut) {
          trackSearchSuccess(req.userId, {
            keyword: query,
            resultCount: hits.length,
            matchQuality,
          }).catch(() => {})
        }

        if (matchQuality === 'empty' && searchTimedOut) {
          // ── 搜索超时 → 明确告知用户 ──
          fullReply = '搜索服务响应较慢，请稍后再试。您也可以换一个更简短的关键词重新搜索。'
          sendEvent({ type: 'answer_chunk', content: fullReply })
          fullReply += emitConfidence(sendEvent, 'low')
          break
        }

        if (matchQuality === 'empty') {
          // ── 无有效结果 → 优先尝试联网降级（方案 §3.2 web_search fallback）──
          // 走 Qwen DashScope 原生 + enable_search（不接 Serper，复用已有 SVC_LLM_FALLBACK_KEY）
          const fb = shouldFallbackToWeb(message, hits.length, matchQuality)
          if (fb.trigger) {
            sendEvent({ type: 'web_search_started', message: '本地未命中，正在联网搜索...', reason: fb.reason })
            let webContent = ''
            let webSources: SearchSource[] = []
            const t0 = Date.now()
            try {
              for await (const chunk of callQwenWithSearchStream(
                [
                  { role: 'system', content: '你是标准小智，专业标准化领域助手。基于联网搜索的结果回答用户问题，明确指出信息来源；如果引用的标准编号、发布日期、状态等关键信息无法在搜索结果中找到，必须直接说"未在搜索结果中找到"，不要编造。回答末尾追加一句提示："以上信息来自网络搜索，请以官方原文为准"。' },
                  ...chatHistory,
                  { role: 'user', content: message },
                ],
                { onSources: (s) => { webSources = s } },
              )) {
                if (aborted) break
                webContent += chunk
                fullReply += chunk
                sendEvent({ type: 'answer_chunk', content: chunk })
              }
              console.log(`[Chat] web_search: reason=${fb.reason} chars=${webContent.length} sources=${webSources.length} dur=${Date.now() - t0}ms`)
            } catch (err) {
              console.warn(`[Chat] web_search 异常: ${err instanceof Error ? err.message : err}`)
            }

            if (webContent && webContent !== LLM_FALLBACK_REPLY) {
              // 联网命中 → 把来源结构化推给前端（UI 渲染卡片列表，置信度 🟡）
              if (webSources.length > 0) {
                sendEvent({
                  type: 'web_search_results',
                  items: webSources.map(s => ({
                    title: s.title,
                    url: s.url,
                    site_name: s.site_name || '',
                    index: s.index,
                  })),
                  note: '网络结果置信度为 🟡，仅作参考',
                })
              }
              fullReply += emitConfidence(sendEvent, 'medium')
              break
            }
            console.log(`[Chat] web_search 0 结果或失败 → 降级到本地引导词`)
          }

          // ── Fallback：本地引导词 ──
          const currentZero = zeroCount + 1
          const suggestions = await buildZeroResultSuggestions(message, intent.keywords || [], failedTerms, currentZero)
          fullReply = buildZeroResultReply(message, suggestions, currentZero)
          sendEvent({ type: 'answer_chunk', content: fullReply })
          for (const suggestion of suggestions) {
            sendEvent({
              type: 'action_suggested',
              action: 'send_message',
              text: suggestion.text,
              label: suggestion.label,
            })
          }
          fullReply += emitConfidence(sendEvent, 'low')
          break
        }

        if (matchQuality === 'related') {
          // ── 相近结果 → LLM 引导总结（强调非精确匹配）+ 卡片 ──
          const outboundGuardRelated = createOutboundGuard()
          for await (const chunk of streamRelatedSummary(hits, message, searchResultsEvent.total, chatHistory)) {
            if (aborted) break
            const blocked = outboundGuardRelated.check(chunk)
            if (blocked) {
              sendEvent({ type: 'answer_chunk', content: blocked })
              fullReply += blocked
              break
            }
            fullReply += chunk
            sendEvent({ type: 'answer_chunk', content: chunk })
          }
          sendEvent(searchResultsEvent)
          sendEvent({ type: 'action_suggested', action: 'redirect', url: searchResultsEvent.moreUrl, label: `查看更多相关结果` })
          // 额外给 suggestion 帮用户收窄（排除当前搜索词）
          const narrowTerms = new Set([...failedTerms, message.trim(), ...(intent.keywords || [])])
          const narrowSuggestions = await buildZeroResultSuggestions(message, intent.keywords || [], narrowTerms, 1)
          for (const s of narrowSuggestions.slice(0, 3)) {
            sendEvent({ type: 'action_suggested', action: 'send_message', text: s.text, label: s.label })
          }
          fullReply += emitConfidence(sendEvent, 'high')
          break
        }

        // ── exact: 精确命中 → LLM 结论句 + 结构化卡片 ──
        const outboundGuardExact = createOutboundGuard()
        for await (const chunk of streamSearchSummary(hits, message, searchResultsEvent.total, chatHistory)) {
          if (aborted) break
          const blocked = outboundGuardExact.check(chunk)
          if (blocked) {
            sendEvent({ type: 'answer_chunk', content: blocked })
            fullReply += blocked
            break
          }
          fullReply += chunk
          sendEvent({ type: 'answer_chunk', content: chunk })
        }
        sendEvent(searchResultsEvent)
        sendEvent({ type: 'action_suggested', action: 'redirect', url: searchResultsEvent.moreUrl, label: `查看完整结果(${searchResultsEvent.total}条)` })
        fullReply += emitConfidence(sendEvent, 'high')
        break
      }

      case 'compare': {
        fullReply = '您可以在文档比对页面上传文件进行分析：\n- 全库相似度分析：上传文件，自动与全库标准比对\n- 一对一比对：上传两个文件，逐段对比差异\n比对完成后可在「我的任务」中查看报告。'
        sendEvent({ type: 'answer_chunk', content: fullReply })
        sendEvent({ type: 'action_suggested', action: 'redirect', url: '/compare', label: '前往比对页面' })
        break
      }

      case 'scan': {
        fullReply = '扫一扫识别功能可以帮您快速识别标准封面。该功能目前支持微信小程序端，请打开标准小智小程序，进入「扫一扫」拍照识别。识别后系统将自动匹配标准信息。'
        sendEvent({ type: 'answer_chunk', content: fullReply })
        // CTA 只给小程序用，Web 前端收到 /pages/ 开头的 url 不渲染
        sendEvent({ type: 'action_suggested', action: 'redirect', url: '/pages/scan/index', label: '前往扫一扫' })
        break
      }

      case 'write': {
        sendEvent({ type: 'search_started', message: '正在生成标准大纲...', stage: 'outline' })
        const outboundGuardWrite = createOutboundGuard()
        for await (const chunk of streamWriteOutline(message, chatHistory)) {
          if (aborted) break
          const blocked = outboundGuardWrite.check(chunk)
          if (blocked) {
            sendEvent({ type: 'answer_chunk', content: blocked })
            fullReply += blocked
            break
          }
          fullReply += chunk
          sendEvent({ type: 'answer_chunk', content: chunk })
        }
        // 大纲完成后追加相关标准作为参考文献
        if (!aborted) {
          const { prefixChunk, searchResultsEvent } = await fetchReferenceStandards(message, conversationId)
          if (prefixChunk) {
            fullReply += prefixChunk
            sendEvent({ type: 'answer_chunk', content: prefixChunk })
          }
          if (searchResultsEvent) {
            sendEvent(searchResultsEvent as Record<string, unknown>)
          }
        }
        sendEvent({ type: 'outline_done' })
        // 埋点：大纲生成（来自 chat write 分支）
        if (!aborted) {
          trackServerEvent('outline_generated', { type: 'chat_write', source: 'chat/send' }, req.userId)
          markUserActive(req.userId)
        }
        fullReply += emitConfidence(sendEvent, 'low')
        break
      }

      case 'task_status': {
        const tasks = await prisma.compareTask.findMany({
          where: { userId: req.userId! },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { taskNo: true, documentName: true, status: true, createdAt: true },
        })
        if (tasks.length === 0) {
          fullReply = '您目前没有比对任务记录。可以前往文档比对页面上传文件，发起比对分析。'
          sendEvent({ type: 'answer_chunk', content: fullReply })
          sendEvent({ type: 'action_suggested', action: 'redirect', url: '/compare', label: '前往比对页面' })
        } else {
          fullReply = '您最近的比对任务如下：'
          sendEvent({ type: 'answer_chunk', content: fullReply })
          sendEvent({
            type: 'task_list',
            tasks: tasks.map(t => ({
              taskNo: t.taskNo,
              documentName: t.documentName,
              status: t.status,
              createdAt: t.createdAt.toISOString(),
              reportUrl: t.status === 'COMPLETED' ? `/compare/report/${t.taskNo}` : null,
            })),
          })
        }
        break
      }

      case 'member': {
        const memberReply = await buildMemberReply(req.userId!)
        fullReply = memberReply.text
        sendEvent({ type: 'answer_chunk', content: fullReply })
        sendEvent({ type: 'action_suggested', action: 'redirect', url: memberReply.ctaUrl, label: memberReply.ctaLabel })
        break
      }

      default: {
        // 闲聊：纯闲聊不标 disclaimer，仅当回复涉及标准/规范内容时才标 🔴
        const outboundGuardChat = createOutboundGuard()
        for await (const chunk of streamChat(message, chatHistory, (from, to, reason) => {
          sendEvent({ type: 'provider_switched', from, to, reason })
        })) {
          if (aborted) break
          const blocked = outboundGuardChat.check(chunk)
          if (blocked) {
            sendEvent({ type: 'answer_chunk', content: blocked })
            fullReply += blocked
            break
          }
          fullReply += chunk
          sendEvent({ type: 'answer_chunk', content: chunk })
        }
        // 只检测用户提问本身是否涉及标准主题；
        // 不检测 LLM 回复，避免「LLM 自我介绍是『标准小智助手』」把闲聊误标 🔴
        if (containsStandardTopic(message)) {
          fullReply += emitConfidence(sendEvent, 'low')
        }
        break
      }
    }

    // 4. 更新预保存的消息内容
    await updateSavedMessages(savedUserMsg.id, savedAssistantMsg.id, message, fullReply, intent.intent)

    // 5. quota_info
    await sendQuotaInfo(sendEvent, req.userId!)

    // 6. conversation_updated（首条消息时）
    await sendConversationUpdated(sendEvent, conv, conversationId, message)

    // 埋点：chat_sent（每次 /chat/send 成功处理记 1 条，带 intent；search/write 分支可能已另打 search_success/outline_generated）
    trackServerEvent('chat_sent', { intent: intent.intent }, req.userId)
    markUserActive(req.userId)

    sendEvent({ type: 'done' })
  } catch (err) {
    console.error('[Chat] 处理消息失败', err)
    sendEvent({ type: 'error', message: '处理消息时出错，请稍后重试' })
  } finally {
    res.end()
  }
})

// ─── 辅助函数 ─────────────────────────────────────────────

async function updateSavedMessages(userMsgId: string, assistantMsgId: string, userContent: string, assistantContent: string, intent: string) {
  await prisma.$transaction([
    prisma.chatMessage.update({ where: { id: userMsgId }, data: { content: userContent, intent } }),
    prisma.chatMessage.update({ where: { id: assistantMsgId }, data: { content: assistantContent, intent } }),
  ])
}

async function saveMessages(conversationId: string, userMsg: string, assistantMsg: string, intent: string) {
  await prisma.chatMessage.createMany({
    data: [
      { conversationId, role: 'user', content: userMsg, intent },
      { conversationId, role: 'assistant', content: assistantMsg, intent },
    ],
  })
}

async function sendQuotaInfo(sendEvent: (data: Record<string, unknown>) => void, userId: string) {
  const membership = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE' },
  })
  if (membership) {
    const tier = membership.planId as string
    sendEvent({ type: 'quota_info', tier, remaining: null, limit: null })
    return
  }
  // 免费用户：重新计算
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const count = await prisma.chatMessage.count({
    where: { conversation: { userId }, role: 'user', createdAt: { gte: todayStart } },
  })
  sendEvent({ type: 'quota_info', tier: 'free', remaining: Math.max(0, 5 - count), limit: 5 })
}

async function sendConversationUpdated(
  sendEvent: (data: Record<string, unknown>) => void,
  conv: { title: string },
  conversationId: string,
  message: string,
) {
  if (conv.title === '新对话') {
    const cleaned = message.replace(/[\r\n\t\0]+/g, ' ').trim()
    const title = cleaned.length > 20 ? cleaned.slice(0, 20) + '...' : cleaned
    await prisma.conversation.update({ where: { id: conversationId }, data: { title } })
    sendEvent({ type: 'conversation_updated', conversationId, title })
  }
}

async function checkDailyQuota(userId: string): Promise<{ allowed: boolean; remaining?: number; message?: string }> {
  const membership = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE' },
  })
  if (membership) return { allowed: true }

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const count = await prisma.chatMessage.count({
    where: { conversation: { userId }, role: 'user', createdAt: { gte: todayStart } },
  })
  const remaining = Math.max(0, 5 - count)
  if (remaining <= 0) {
    return { allowed: false, remaining: 0, message: '今日免费对话额度已用完，升级会员享无限对话' }
  }
  return { allowed: true, remaining }
}

async function buildMemberReply(userId: string): Promise<{ text: string; ctaUrl: string; ctaLabel: string }> {
  const membership = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { planId: true, endAt: true },
  })

  if (!membership) {
    return {
      text: '您当前是免费用户。免费版每项功能每天可用 5 次，升级个人会员(¥598/年)解锁不限次使用，升级专业版(¥998/年)额外享受全库比对不限次和专属客服。',
      ctaUrl: '/membership',
      ctaLabel: '立即升级',
    }
  }

  const expireDate = membership.endAt ? new Date(membership.endAt).toLocaleDateString('zh-CN') : '未知'

  if (membership.planId === 'pro' || membership.planId === 'enterprise') {
    return {
      text: `您当前是专业包年会员，${expireDate} 到期，已享有全部权益，包括全功能不限次、全库比对不限次和专属客服。`,
      ctaUrl: '/membership/benefits',
      ctaLabel: '查看权益详情',
    }
  }

  // personal
  return {
    text: `您当前是个人包年会员，${expireDate} 到期。您已享有全功能不限次使用和全库比对 10 次/年。升级专业版可享受全库比对不限次和专属客服。`,
    ctaUrl: '/membership',
    ctaLabel: '升级专业版',
  }
}

const CHAT_SYSTEM_PROMPT = `你是"标准小智"，一个专业的标准化服务 AI 助手，隶属于通标中研标准化研究院。

${SYSTEM_GUARDRAIL}

【角色定位】
- 你是标准化领域的助手，可以回答标准化相关常识问题
- 对于超出标准化领域的闲聊，礼貌引导回标准相关话题
- 保持专业、友好、简洁的风格
- 用中文回复`

// ─── 对话历史类型 + 加载 + 压缩 ─────────────────────────────
/** 压缩后传给 LLM 的历史消息（已在 chat.ts /send 顶部统一构建一次，
 *  下游 stream 函数纯接收，不再访问 prisma 或 buildCompressedHistory） */
export interface ChatHistoryMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const HISTORY_CHAR_THRESHOLD = 6000 // ≈ 3000 token
const HISTORY_KEEP_RECENT = 4
const HISTORY_FETCH_COUNT = 6

/**
 * 在 /send 主流程拉历史 + 压缩 + 排除占位行。返回已压缩、可直接拼到 messages 数组的
 * 列表。下游 stream 函数（streamSearchSummary / streamRelatedSummary /
 * streamWriteOutline / streamWriteFramework / callQwenWithSearchStream / streamChat）
 * 全部接收这个数组作为 history 参数。
 *
 * 排除规则：
 *   - 当前 saveUserMsg + savedAssistantMsg 占位（intent='pending' + 空内容）
 *   - intent='pending' 的旧占位（防中断遗留）
 *   - content='' 的空 assistant 占位
 */
export async function loadChatHistory(
  conversationId: string,
  excludeIds: string[] = [],
): Promise<ChatHistoryMsg[]> {
  const rawHistory = await prisma.chatMessage.findMany({
    where: {
      conversationId,
      ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
      intent: { not: 'pending' },
      NOT: { content: '' },
    },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_FETCH_COUNT,
    select: { role: true, content: true },
  })
  const compressed = await buildCompressedHistory(
    rawHistory.reverse().map((m) => ({ role: m.role, content: m.content })),
  )
  return compressed.map((m) => ({
    role: m.role as 'system' | 'user' | 'assistant',
    content: m.content,
  }))
}

/**
 * 对长对话历史进行 LLM 摘要压缩。
 * - 总字符 < 6000 → 直接返回原始历史
 * - 超阈值 → 保留最近 4 条原文，早期部分调 callLLM 摘要后作 system 消息置前
 * - 摘要失败（LLM 不可用/抛异常）→ 降级：丢弃早期消息，只返回最近 4 条
 */
export async function buildCompressedHistory(
  rawHistory: Array<{ role: string; content: string }>,
): Promise<Array<{ role: string; content: string }>> {
  const totalChars = rawHistory.reduce((sum, m) => sum + m.content.length, 0)
  if (totalChars <= HISTORY_CHAR_THRESHOLD) {
    return rawHistory
  }

  const keepCount = Math.min(HISTORY_KEEP_RECENT, rawHistory.length)
  const earlyMessages = rawHistory.slice(0, rawHistory.length - keepCount)
  const recentMessages = rawHistory.slice(rawHistory.length - keepCount)

  if (earlyMessages.length === 0) {
    return rawHistory
  }

  const earlyText = earlyMessages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n')

  try {
    const summary = await callLLM(
      [
        {
          role: 'user',
          content: `请用 100 字以内总结以下对话，保留关键信息、人物、决策、数字：\n\n${earlyText}`,
        },
      ],
      { maxTokens: 150, temperature: 0.3 },
    )

    if (summary === LLM_FALLBACK_REPLY) {
      console.warn(`[Chat] history compression failed → drop early ${earlyMessages.length} messages`)
      return recentMessages
    }

    return [
      { role: 'system', content: `[历史摘要] ${summary}` },
      ...recentMessages,
    ]
  } catch (err) {
    console.warn(`[Chat] history compression failed → drop early ${earlyMessages.length} messages`, err)
    return recentMessages
  }
}

async function* streamChat(
  userMessage: string,
  history: ChatHistoryMsg[],
  onProviderSwitched?: (from: string, to: string, reason: string) => void,
): AsyncGenerator<string> {
  // history 由 /send 主流程统一通过 loadChatHistory 提供（已排除当前占位 +
  // intent='pending' + 空内容，已经过 buildCompressedHistory 压缩）
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage },
  ]

  yield* callLLMStream(messages, { onProviderSwitched })
}

// ─── 标准编写：生成大纲 ─────────────────────────────────────

router.post('/std-outline', async (req: AuthRequest, res) => {
  const { conversationId, description } = req.body
  if (!conversationId || !description || typeof description !== 'string' || description.length > 2000) {
    return res.status(400).json({ error: '参数错误' })
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: req.userId! },
  })
  if (!conv) return res.status(404).json({ error: '会话不存在' })

  const quotaCheck = await checkOutlineQuota(req.userId!)
  if (!quotaCheck.allowed) {
    return res.status(429).json({ error: quotaCheck.message })
  }

  const sendEvent = setupSSE(res)

  try {
    sendEvent({ type: 'session_started', conversationId })
    sendEvent({ type: 'search_started', message: '正在生成标准大纲...', stage: 'outline' })
    // 加载历史（与 /send 同样规则）让 LLM 看到前面对话上下文
    const outlineHistory = await loadChatHistory(conversationId)
    let fullReply = ''
    for await (const chunk of streamWriteOutline(description, outlineHistory)) {
      fullReply += chunk
      sendEvent({ type: 'answer_chunk', content: chunk })
    }
    // 大纲完成后追加相关标准作为参考文献
    const { prefixChunk, searchResultsEvent } = await fetchReferenceStandards(description, conversationId)
    if (prefixChunk) {
      fullReply += prefixChunk
      sendEvent({ type: 'answer_chunk', content: prefixChunk })
    }
    if (searchResultsEvent) {
      sendEvent(searchResultsEvent as Record<string, unknown>)
    }
    // 起草内容标 🔴 AI 推断（要求专家审核）
    fullReply += emitConfidence(sendEvent, 'low')
    await saveMessages(conversationId, description, fullReply, 'write_outline')
    sendEvent({ type: 'outline_done' })
    // 埋点：大纲生成（独立接口）
    trackServerEvent('outline_generated', { type: 'std_outline', source: 'chat/std-outline' }, req.userId)
    markUserActive(req.userId)
    await sendQuotaInfo(sendEvent, req.userId!)
    sendEvent({ type: 'done' })
  } catch (err) {
    console.error('[Chat] 生成大纲失败', err)
    sendEvent({ type: 'error', message: '生成大纲时出错，请稍后重试' })
  } finally {
    res.end()
  }
})

// ─── 标准编写：生成全文框架 ──────────────────────────────────

router.post('/std-generate', async (req: AuthRequest, res) => {
  const { conversationId, outline } = req.body
  if (!conversationId || !outline || typeof outline !== 'string') {
    return res.status(400).json({ error: '参数错误' })
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: req.userId! },
  })
  if (!conv) return res.status(404).json({ error: '会话不存在' })

  const quotaCheck = await checkFrameworkQuota(req.userId!)
  if (!quotaCheck.allowed) {
    return res.status(quotaCheck.statusCode || 429).json({ error: quotaCheck.message })
  }

  const sendEvent = setupSSE(res)

  try {
    sendEvent({ type: 'session_started', conversationId })
    sendEvent({ type: 'search_started', message: '正在生成标准文本框架...', stage: 'framework' })
    const frameworkHistory = await loadChatHistory(conversationId)
    let fullReply = ''
    for await (const chunk of streamWriteFramework(outline, frameworkHistory)) {
      fullReply += chunk
      sendEvent({ type: 'answer_chunk', content: chunk })
    }
    // 标准编号库验证（Phase C-2）：抽取 reply 中引用的所有编号，并发查 pyapi 实存性，
    // 失败/超时一律降级跳过，不阻塞框架完成。
    try {
      const codes = extractStandardCodes(fullReply)
      if (codes.length > 0) {
        const refs = await verifyStandardCodes(codes)
        sendEvent({
          type: 'verified_references',
          verified: refs.verified,
          unverified: refs.unverified,
          total: codes.length,
        })
      }
    } catch (e) {
      console.warn('[Chat] verifyStandardCodes 失败，降级跳过', (e as Error)?.message)
    }
    // 起草内容标 🔴 AI 推断（要求专家审核）
    fullReply += emitConfidence(sendEvent, 'low')
    await saveMessages(conversationId, '确认大纲，生成标准框架', fullReply, 'write_framework')
    sendEvent({ type: 'framework_done' })
    await sendQuotaInfo(sendEvent, req.userId!)
    sendEvent({ type: 'done' })
  } catch (err) {
    console.error('[Chat] 生成框架失败', err)
    sendEvent({ type: 'error', message: '生成框架时出错，请稍后重试' })
  } finally {
    res.end()
  }
})

// ─── 标准框架导出 Word（Phase C-3）─────────────────────────────
//
// 入参：{ conversationId, content?, title?, references? }
//   - content 缺省时，从最近一条 write_framework / write_outline 类型的 ChatMessage 取
//   - references 由前端透传 SSE verified_references 收到的数据，可缺省
// 鉴权：只允许导出自己的会话
//
router.post('/std-export-word', async (req: AuthRequest, res) => {
  const { conversationId, content, title, references } = req.body || {}
  if (!conversationId || typeof conversationId !== 'string') {
    return res.status(400).json({ error: '参数错误：conversationId' })
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: req.userId! },
    select: { id: true, title: true },
  })
  if (!conv) return res.status(404).json({ error: '会话不存在' })

  let finalContent: string = typeof content === 'string' && content.trim() ? content : ''
  if (!finalContent) {
    const msg = await prisma.chatMessage.findFirst({
      where: {
        conversationId,
        role: 'assistant',
        intent: { in: ['write_framework', 'write_outline'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    })
    if (!msg || !msg.content) return res.status(400).json({ error: '未找到可导出的标准框架内容' })
    finalContent = msg.content
  }

  try {
    const buffer = await buildStdFrameworkDocx({
      title: typeof title === 'string' && title.trim() ? title : conv.title || undefined,
      content: finalContent,
      references: references && typeof references === 'object' ? references : undefined,
    })
    const fileName = encodeURIComponent(`${conv.title || '标准框架'}_${new Date().toISOString().slice(0, 10)}.docx`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`)
    res.send(buffer)
  } catch (err) {
    console.error('[Chat] std-export-word 失败', err)
    res.status(500).json({ error: '导出失败' })
  }
})

// ─── 大纲额度检查 ────────────────────────────────────────────

async function checkOutlineQuota(userId: string): Promise<{ allowed: boolean; message?: string }> {
  const membership = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE' },
  })
  if (membership) return { allowed: true }

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const count = await prisma.chatMessage.count({
    where: { conversation: { userId }, role: 'assistant', intent: 'write_outline', createdAt: { gte: todayStart } },
  })
  if (count >= 1) {
    return { allowed: false, message: '今日免费大纲生成次数已用完，升级会员享无限使用' }
  }
  return { allowed: true }
}

// ─── 框架额度检查 ────────────────────────────────────────────

async function checkFrameworkQuota(userId: string): Promise<{ allowed: boolean; statusCode?: number; message?: string }> {
  const membership = await prisma.userMembership.findFirst({
    where: { userId, status: 'ACTIVE' },
  })

  if (!membership) {
    return { allowed: false, statusCode: 403, message: '标准框架生成为会员专属功能，请先升级会员' }
  }

  if (membership.planId === 'pro' || membership.planId === 'enterprise') {
    return { allowed: true }
  }

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const count = await prisma.chatMessage.count({
    where: { conversation: { userId }, role: 'assistant', intent: 'write_framework', createdAt: { gte: todayStart } },
  })
  if (count >= 3) {
    return { allowed: false, message: '今日框架生成次数已达上限（3 次/天），升级专业会员享无限使用' }
  }
  return { allowed: true }
}

export default router
