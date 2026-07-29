/* eslint-disable react-refresh/only-export-components */
/**
 * 后台权限 Context
 *
 * 用户登录后调用 GET /api/admin/me/permissions 拉取后台访问权限与菜单/操作权限集合。
 * 在 AdminLayout / ProtectedRoute / 后台页面里通过 usePermission() 读取。
 *
 * 通配符约定：menuPaths/actionKeys 含 '*' 表示全集（admin 系统身份）。
 *
 * 失效策略：未登录或 token 无效返回默认 hasAdminAccess=false 的状态。
 * 撤销实时性：用户当前 session 的 Context 数据保持，刷新或重新调用 refresh() 才更新。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { nodeApi } from '../api/client'
import { useAuth } from './AuthContext'

export interface PermissionState {
  loading: boolean
  hasAdminAccess: boolean
  isAdmin: boolean
  isSales: boolean
  isStaff: boolean
  menuPaths: string[]
  actionKeys: string[]
}

interface PermissionContextValue extends PermissionState {
  refresh: () => Promise<void>
  hasMenu: (path: string) => boolean
  hasAction: (key: string) => boolean
}

// 初始挂载：loading=true，路由守卫等权限拉完再决定是否跳转
const INITIAL_STATE: PermissionState = {
  loading: true,
  hasAdminAccess: false,
  isAdmin: false,
  isSales: false,
  isStaff: false,
  menuPaths: [],
  actionKeys: [],
}

// 未登录 / 拉取失败的终态：loading=false，守卫可立即判定
const RESET_STATE: PermissionState = {
  loading: false,
  hasAdminAccess: false,
  isAdmin: false,
  isSales: false,
  isStaff: false,
  menuPaths: [],
  actionKeys: [],
}

const PermissionContext = createContext<PermissionContextValue>({
  ...RESET_STATE,
  refresh: async () => {},
  hasMenu: () => false,
  hasAction: () => false,
})

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { isLoggedIn } = useAuth()
  const [state, setState] = useState<PermissionState>(INITIAL_STATE)

  const refresh = useCallback(async () => {
    if (!isLoggedIn) {
      setState(RESET_STATE)
      return
    }
    setState((s) => ({ ...s, loading: true }))
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/me/permissions')
      setState({
        loading: false,
        hasAdminAccess: !!res?.hasAdminAccess,
        isAdmin: !!res?.isAdmin,
        isSales: !!res?.isSales,
        isStaff: !!res?.isStaff,
        menuPaths: Array.isArray(res?.menuPaths) ? res.menuPaths : [],
        actionKeys: Array.isArray(res?.actionKeys) ? res.actionKeys : [],
      })
    } catch {
      setState(RESET_STATE)
    }
  }, [isLoggedIn])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [refresh])

  const value = useMemo<PermissionContextValue>(() => ({
    ...state,
    refresh,
    hasMenu: (path: string) => state.menuPaths.includes('*') || state.menuPaths.includes(path),
    hasAction: (key: string) => state.actionKeys.includes('*') || state.actionKeys.includes(key),
  }), [state, refresh])

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>
}

export function usePermission() {
  return useContext(PermissionContext)
}

/**
 * 路由切换时触发权限重拉，缓解「admin 给用户分配角色后用户端不刷新」问题。
 * 节流 30s 内最多调一次 /api/admin/me/permissions，避免快速点击导致多次请求。
 *
 * 必须挂在 BrowserRouter 内部（依赖 useLocation），与 PermissionProvider 位置
 * 解耦（Provider 在 Router 外，无法直接用 useLocation）。
 */
const ROUTE_REFRESH_THROTTLE_MS = 30_000

export function PermissionRouteRefresher() {
  const { refresh } = usePermission()
  const { isLoggedIn } = useAuth()
  const location = useLocation()
  const lastAtRef = useRef(0)

  useEffect(() => {
    if (!isLoggedIn) {
      lastAtRef.current = 0
      return
    }
    const now = Date.now()
    if (now - lastAtRef.current >= ROUTE_REFRESH_THROTTLE_MS) {
      lastAtRef.current = now
      refresh()
    }
  }, [location.pathname, isLoggedIn, refresh])

  return null
}
