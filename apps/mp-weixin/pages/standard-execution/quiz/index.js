/**
 * 答题考核页
 * 路由: /pages/standard-execution/quiz/index?taskId=xxx
 *
 * 流程：
 *  1. onLoad → 拉取题目（不含答案）
 *  2. 员工作答（单选 / 多选）
 *  3. 全部作答后点「提交」→ 后端评分 → 展示结果
 *  4. 结果页展示：得分、是否通过、各题对错 + 正确答案
 */
const se = require('../../../utils/standardExecution')

Page({
  data: {
    taskId: '',
    loading: true,
    error: '',
    // 题库信息
    quizTitle: '',
    questions: [],       // [{id, type, text, opts, score}]
    // 作答状态：questionId → number[] (selected indices)
    selectedMap: {},
    // 计时
    startTime: 0,
    // 结果
    submitted: false,
    result: null,        // {score, totalScore, correctCount, wrongCount, passed, correctAnswers}
    submitting: false,
  },

  onLoad(opts) {
    const taskId = opts && opts.taskId
    if (!taskId) {
      this.setData({ loading: false, error: '缺少任务 ID' })
      return
    }
    this.setData({ taskId })
    this._load(taskId)
  },

  _load(taskId) {
    this.setData({ loading: true, error: '' })
    se.getQuiz(taskId)
      .then((data) => {
        // 初始化 selectedMap：每题 → 空数组
        const selectedMap = {}
        const questions = data.questions || []
        questions.forEach((q) => { selectedMap[q.id] = [] })
        this.setData({
          loading: false,
          quizTitle: data.title || '答题考核',
          questions,
          selectedMap,
          startTime: Date.now(),
        })
      })
      .catch((e) => {
        this.setData({ loading: false, error: e.message || '题目加载失败' })
      })
  },

  // 选择选项
  tapOption(e) {
    if (this.data.submitted) return
    const { qid, qtype } = e.currentTarget.dataset
    // dataset 取出是字符串，必须转数字：否则与 number[] 选中态(wxml indexOf)/提交 selected 不匹配
    const oidx = Number(e.currentTarget.dataset.oidx)
    const map = { ...this.data.selectedMap }
    const cur = map[qid] ? [...map[qid]] : []

    if (qtype === 'single') {
      // 单选：直接替换
      map[qid] = [oidx]
    } else {
      // 多选：切换
      const pos = cur.indexOf(oidx)
      if (pos >= 0) {
        cur.splice(pos, 1)
      } else {
        cur.push(oidx)
        cur.sort((a, b) => a - b)
      }
      map[qid] = cur
    }
    this.setData({ selectedMap: map })
  },

  // 提交答卷
  submit() {
    if (this.data.submitting || this.data.submitted) return
    const { questions, selectedMap, startTime, taskId } = this.data

    // 检查是否全部作答
    const unanswered = questions.filter((q) => !(selectedMap[q.id] && selectedMap[q.id].length > 0))
    if (unanswered.length > 0) {
      wx.showModal({
        title: '还有题目未作答',
        content: `第 ${unanswered.map((q, _) => questions.indexOf(q) + 1).join('、')} 题未选择答案，确认提交吗？`,
        confirmText: '仍然提交',
        success: (res) => {
          if (res.confirm) this._doSubmit()
        },
      })
      return
    }
    this._doSubmit()
  },

  _doSubmit() {
    const { questions, selectedMap, startTime, taskId } = this.data
    const timeUsedSec = Math.round((Date.now() - startTime) / 1000)
    const answers = questions.map((q) => ({
      questionId: q.id,
      selected: selectedMap[q.id] || [],
    }))

    this.setData({ submitting: true })
    se.submitQuiz(taskId, { answers, timeUsedSec })
      .then((res) => {
        try { wx.setStorageSync(`se_quiz_done_${taskId}`, true) } catch (e) { /* ignore */ }
        // 构建每题结果：{ isCorrect, correctAnswer, exp, selectedAnswer }
        const questionResultMap = {}
        if (res.correctAnswers) {
          res.correctAnswers.forEach((ca) => {
            const selected = selectedMap[ca.questionId] || []
            const correct = ca.answer || []
            // 判断对错：set 比较
            const correctSet = correct.slice().sort().join(',')
            const selectedSet = selected.slice().sort().join(',')
            questionResultMap[ca.questionId] = {
              isCorrect: correctSet === selectedSet && correct.length > 0,
              correctAnswer: correct,
              exp: ca.exp || '',
            }
          })
        }
        this.setData({
          submitted: true,
          submitting: false,
          result: {
            score: res.score,
            totalScore: res.totalScore,
            correctCount: res.correctCount,
            wrongCount: res.wrongCount,
            passed: res.passed,
            questionResultMap,
          },
        })
      })
      .catch((e) => {
        this.setData({ submitting: false })
        wx.showToast({ title: e.message || '提交失败', icon: 'none' })
      })
  },

  // 返回任务详情（不及格，可重新作答）
  goBack() {
    wx.navigateBack()
  },

  // 答题通过 → 任务已完成，跳回「我的任务」列表（越过详情页），栈不足时 reLaunch
  goTaskList() {
    const pages = getCurrentPages()
    if (pages.length >= 3) {
      wx.navigateBack({ delta: 2 })
    } else {
      wx.reLaunch({ url: '/pages/standard-execution/tasks/index' })
    }
  },
})
