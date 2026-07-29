/**
 * 权限控制 hook — 跟小程序 session.js 逻辑对齐
 *
 * 三级权限：
 *   游客（未登录）→ 只能看首页、搜索结果概览，操作跳登录
 *   免费用户     → 每日每种高价值功能 5 次，一对一比对不限次
 *   付费会员     → personal 全功能不限次 + 全库相似度分析 10 次/年；pro 全功能不限次 + 全库相似度分析不限次
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from 'antd'
import { useAuth } from '../contexts/AuthContext'
import { getCompareFreeQuota } from '../api/app'

const USAGE_KEY = 'bxz_daily_usage'

interface DailyUsage {
  date: string
  counts: Record<string, number>
}

function getTodayUsage(): DailyUsage {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const data: DailyUsage = raw ? JSON.parse(raw) : { date: '', counts: {} }
    const today = new Date().toISOString().slice(0, 10)
    if (data.date !== today) return { date: today, counts: {} }
    return data
  } catch {
    return { date: new Date().toISOString().slice(0, 10), counts: {} }
  }
}

function saveTodayUsage(usage: DailyUsage) {
  localStorage.setItem(USAGE_KEY, JSON.stringify(usage))
}

export type Feature = 'search' | 'compare' | 'graph' | 'outline' | 'industry' | 'committee'

export function useAccess() {
  const { user, isLoggedIn } = useAuth()
  const nav = useNavigate()

  const memberTier = user?.memberTier || 'free'
  const isPaid = memberTier === 'personal' || memberTier === 'pro' || memberTier === 'enterprise'
  const isPro = memberTier === 'pro' || memberTier === 'enterprise'

  const [proQuota, setProQuota] = useState<{ used: number; limit: number; remaining: number }>({ used: 0, limit: 3, remaining: 3 })

  useEffect(() => {
    if (isPaid && isLoggedIn) {
      getCompareFreeQuota().then(data => {
        setProQuota({ used: data.used, limit: data.limit, remaining: data.remaining })
      }).catch(() => {})
    }
  }, [isPaid, isLoggedIn])

  /**
   * 要求登录，未登录弹窗引导
   * @returns true 如果已登录
   */
  const requireLogin = useCallback((): boolean => {
    if (isLoggedIn) return true
    Modal.info({
      title: '请先登录',
      content: '登录后即可使用完整功能',
      okText: '去登录',
      icon: null,
      centered: true,
      onOk: () => nav('/login'),
    })
    return false
  }, [isLoggedIn, nav])

  /**
   * 检查高价值功能是否可用（不消耗额度）
   */
  const canUseFeature = useCallback(
    (feature: Feature): boolean => {
      if (!isLoggedIn) return false
      if (isPaid) return true
      const usage = getTodayUsage()
      return (usage.counts[feature] || 0) < 5
    },
    [isLoggedIn, isPaid],
  )

  /**
   * 消耗一次功能使用额度
   */
  const consumeFeature = useCallback(
    (feature: Feature) => {
      if (isPaid) return
      const usage = getTodayUsage()
      usage.counts[feature] = (usage.counts[feature] || 0) + 1
      saveTodayUsage(usage)
    },
    [isPaid],
  )

  /**
   * 检查+消耗：未登录跳登录，超限跳会员页
   * @returns true 可以使用
   */
  const checkAndConsume = useCallback(
    (feature: Feature): boolean => {
      if (!requireLogin()) return false
      if (isPaid) return true
      if (!canUseFeature(feature)) {
        Modal.info({
          title: '今日免费次数已用完',
          content: '升级会员可无限使用该功能',
          okText: '查看会员',
          icon: null,
          centered: true,
          onOk: () => nav('/membership'),
        })
        return false
      }
      consumeFeature(feature)
      return true
    },
    [requireLogin, isPaid, canUseFeature, consumeFeature, nav],
  )

  /**
   * 全库相似度分析报告权限
   * - pro 会员：不限次
   * - personal：10 次/年
   * - free：不可用
   */
  const getCompareReportAccess = useCallback(() => {
    if (isPro) {
      return { allowed: true, needPay: false, remaining: -1 } // -1 = 不限次
    }
    if (isPaid) {
      // personal 会员走年度额度
      if (proQuota.remaining > 0) {
        return { allowed: true, needPay: false, remaining: proQuota.remaining }
      }
      return { allowed: false, needPay: false, remaining: 0 } // 额度用完，不可用
    }
    return { allowed: false, needPay: false, remaining: 0 }
  }, [isPaid, isPro, proQuota])

  /**
   * 要求付费会员，非付费弹窗引导
   */
  const requirePaid = useCallback((): boolean => {
    if (!requireLogin()) return false
    if (isPaid) return true
    Modal.info({
      title: '需要会员权限',
      content: '该功能仅限付费会员使用',
      okText: '查看会员计划',
      icon: null,
      centered: true,
      onOk: () => nav('/membership'),
    })
    return false
  }, [requireLogin, isPaid, nav])

  const refreshProQuota = useCallback(() => {
    if (isPaid && isLoggedIn) {
      getCompareFreeQuota().then(data => {
        setProQuota({ used: data.used, limit: data.limit, remaining: data.remaining })
      }).catch(() => {})
    }
  }, [isPaid, isLoggedIn])

  return {
    isLoggedIn,
    isPaid,
    isPro,
    memberTier,
    requireLogin,
    requirePaid,
    canUseFeature,
    consumeFeature,
    checkAndConsume,
    getCompareReportAccess,
    refreshProQuota,
  }
}
