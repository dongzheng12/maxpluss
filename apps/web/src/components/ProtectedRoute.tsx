import { useAuth } from '../contexts/AuthContext'
import { usePermission } from '../contexts/PermissionContext'
import { Result } from 'antd'
import { Navigate, Outlet, useLocation } from 'react-router-dom'

interface ProtectedRouteProps {
  children?: React.ReactNode
  requiredRole?: 'admin' | 'user' | 'sales'
}

export function ProtectedRoute({ children, requiredRole = 'user' }: ProtectedRouteProps) {
  const { user, isLoggedIn, isAdmin, loading } = useAuth()
  const perm = usePermission()
  const location = useLocation()

  if (loading) {
    return (
      <Result
        status="info"
        title="加载中..."
        style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      />
    )
  }

  if (!isLoggedIn) {
    if (requiredRole === 'admin') {
      return <Navigate to="/admin/login" state={{ from: location.pathname }} replace />
    }
    // 未登录统一跳 /login 并带 redirect 参数，登录后回原页
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  // admin 路由：放行规则
  // - admin 系统身份：放行
  // - sales 系统身份：放行（通过用户菜单进入，菜单按白名单过滤）
  // - role=user 但有 ACTIVE AdminUserRole 的 staff：放行
  // - 其它：跳首页
  if (requiredRole === 'admin' && !isAdmin) {
    // sales 角色：仅允许进入 /admin/sales/* 子路由（销售工作台、推广资料、推广素材、订单数据等）
    // 任何非 /admin/sales/ 开头的 admin 路径一律重定向到 workspace。
    // 取消旧白名单：默认 deny + 仅 /admin/sales/ 放行，避免新加 admin 路由忘记加白名单导致越权。
    if (user?.role === 'sales') {
      if (!location.pathname.startsWith('/admin/sales/')) {
        // sales 用户访问非 /admin/sales/* 路径：按其 menuPaths 精准放行
        // —— 普通销售 menuPaths 不含该路径，重定向回 workspace；
        //    持有额外 RBAC 后台角色（如运营管理）的销售 menuPaths 含具体路径，放行后由
        //    AdminLayout 的菜单守卫做下一层路径校验。
        if (perm.loading) {
          return (
            <Result
              status="info"
              title="加载中..."
              style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            />
          )
        }
        // 精准检查：当前路径是否在该用户的 menuPaths 授权范围内
        // （普通销售 menuPaths 只有 /admin + /admin/sales/workspace，不在则拒绝；
        //  有额外后台角色的销售（如运营管理）menuPaths 含具体路径，则放行）
        const hasCoverage =
          perm.menuPaths.includes('*') ||
          perm.menuPaths.some(
            (p) => location.pathname === p || location.pathname.startsWith(p + '/')
          )
        if (!hasCoverage) {
          return <Navigate to="/admin/sales/workspace" replace />
        }
      }
      return <>{children ?? <Outlet />}</>
    }
    if (perm.loading) {
      return (
        <Result
          status="info"
          title="加载中..."
          style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        />
      )
    }
    if (perm.isStaff && perm.hasAdminAccess) return <>{children}</>
    return <Navigate to="/" replace />
  }

  // sales 路由：admin 或 三信号识别为销售（role=sales / AdminUserRole销售 ACTIVE /
  // SalesProfile != DISABLED 任一为真）即放行；否则跳首页
  if (requiredRole === 'sales' && !isAdmin && !perm.isSales) {
    return <Navigate to="/" replace />
  }

  // 支持两种用法：
  // 1. 作为 layout route：<Route element={<ProtectedRoute />}><Route .../></Route> → 渲染 Outlet
  // 2. 包裹子组件：<ProtectedRoute><SomeLayout /></ProtectedRoute> → 渲染 children
  return <>{children ?? <Outlet />}</>
}
