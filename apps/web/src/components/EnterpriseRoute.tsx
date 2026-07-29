/**
 * 企业版路由守卫
 *
 * 规则（确认版）：
 *  - 未登录 → 跳统一登录页 /login?tab=enterprise
 *  - 已登录 + isAdminBypass=true → 放行（admin 通配）
 *  - 已登录 + enterpriseRole 非空 → 放行
 *  - 其它 → 跳统一登录页 /login?tab=enterprise&reason=no-enterprise-role
 */
import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Result } from 'antd'
import { useAuth } from '../contexts/AuthContext'
import { nodeApi } from '../api/client'

type EnterpriseMe = {
  enterpriseRole: string | null
  isAdminBypass: boolean
  passwordMustChange: boolean
}

export function EnterpriseRoute() {
  const { isLoggedIn, loading: authLoading, logout } = useAuth()
  const loc = useLocation()
  const [meLoading, setMeLoading] = useState(true)
  const [me, setMe] = useState<EnterpriseMe | null>(null)

  useEffect(() => {
    if (authLoading) return
    if (!isLoggedIn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMeLoading(false)
      return
    }
    let cancelled = false
    nodeApi
      .get('/api/enterprise/me')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((r: any) => {
        if (cancelled) return
        setMe({
          enterpriseRole: r?.enterpriseRole ?? null,
          isAdminBypass: !!r?.isAdminBypass,
          passwordMustChange: r?.user?.passwordMustChange === true,
        })
      })
      .catch((error) => {
        if (cancelled) return
        if (error?.response?.status === 401) {
          logout()
          setMe(null)
          return
        }
        setMe({ enterpriseRole: null, isAdminBypass: false, passwordMustChange: false })
      })
      .finally(() => {
        if (!cancelled) setMeLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, isLoggedIn, logout])

  useEffect(() => {
    const handlePasswordChanged = () => {
      setMe((prev) => prev ? { ...prev, passwordMustChange: false } : prev)
    }
    window.addEventListener('bxz-password-changed', handlePasswordChanged)
    return () => window.removeEventListener('bxz-password-changed', handlePasswordChanged)
  }, [])

  const loginTarget = (reason?: string) => {
    const redirect = `${loc.pathname}${loc.search}`
    const params = new URLSearchParams({ tab: 'enterprise', redirect })
    if (reason) params.set('reason', reason)
    return `/login?${params.toString()}`
  }

  if (authLoading || meLoading) {
    return (
      <Result
        status="info"
        title="加载中..."
        style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      />
    )
  }

  if (!isLoggedIn) {
    return <Navigate to={loginTarget()} replace />
  }

  if (!me?.isAdminBypass && !me?.enterpriseRole) {
    return <Navigate to={loginTarget('no-enterprise-role')} replace />
  }

  if (me.passwordMustChange && !(loc.pathname === '/enterprise/members' && loc.search.includes('forceChangePassword=1'))) {
    return <Navigate to="/enterprise/members?forceChangePassword=1" replace />
  }

  return <Outlet />
}
