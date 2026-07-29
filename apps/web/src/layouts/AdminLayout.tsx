import { useEffect, useState } from 'react'
import { Layout, Menu, Typography, Button, theme, Dropdown, Space, Avatar } from 'antd'
import type { MenuProps } from 'antd'
import type { ReactNode } from 'react'
import {
  DashboardOutlined,
  TeamOutlined,
  ShoppingCartOutlined,
  FileTextOutlined,
  PhoneOutlined,
  DiffOutlined,
  GiftOutlined,
  TagOutlined,
  ShareAltOutlined,
  NotificationOutlined,
  AppstoreOutlined,
  LeftOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LogoutOutlined,
  UserOutlined,
  UserSwitchOutlined,
  BarChartOutlined,
  SafetyOutlined,
  SolutionOutlined,
  AuditOutlined,
  CheckSquareOutlined,
  FolderOpenOutlined,
  WarningOutlined,
  ScheduleOutlined,
  BookOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { usePermission } from '../contexts/PermissionContext'
import SEAIFloatingBubble from '../components/SEAIFloatingBubble'
import { SEPageProvider } from '../contexts/SEPageProvider'
import { SE_UI_ENABLED } from '../config/featureFlags'

const { Sider, Header, Content } = Layout
const { Text } = Typography

type AdminMenuLeaf = { type?: undefined; key: string; icon?: ReactNode; label: ReactNode; hidden?: boolean; danger?: boolean }
type AdminMenuGroup = { type: 'group'; key: string; label: ReactNode; hidden?: boolean; children: AdminMenuLeaf[] }
type AdminMenuDivider = { type: 'divider'; key?: string; hidden?: boolean }
type AdminMenuItem = AdminMenuLeaf | AdminMenuGroup | AdminMenuDivider

// SubMenu 分组结构（业务数据 / 营销中心 / 系统管理）
// 每个叶子项的 key 必须保持 route path,菜单白名单按 key 过滤(后端 menuPaths)
const siderMenuItems: AdminMenuItem[] = [
  { key: '/admin', icon: <DashboardOutlined />, label: '数据概览' },
  {
    type: 'group' as const,
    key: 'group-business',
    label: '业务数据',
    children: [
      { key: '/admin/users', icon: <TeamOutlined />, label: '用户管理' },
      { key: '/admin/orders', icon: <ShoppingCartOutlined />, label: '订单管理' },
      { key: '/admin/compare-tasks', icon: <DiffOutlined />, label: '比对任务' },
      { key: '/admin/invoices', icon: <FileTextOutlined />, label: '发票管理' },
      { key: '/admin/bookings', icon: <PhoneOutlined />, label: '服务预约' },
      { key: '/admin/expert-votes', icon: <SolutionOutlined />, label: '专家投票管理' },
    ],
  },
  {
    type: 'group' as const,
    key: 'group-marketing',
    label: '营销中心',
    children: [
      { key: '/admin/gifts', icon: <GiftOutlined />, label: '销售赠送' },
      { key: '/admin/coupons', icon: <TagOutlined />, label: '优惠券' },
      { key: '/admin/sales', icon: <ShareAltOutlined />, label: '销售推广' },
      { key: '/admin/sales/overview', icon: <BarChartOutlined />, label: '销售数据看板' },
      { key: '/admin/sales/workspace', icon: <SolutionOutlined />, label: '我的推广主页' },
      { key: '/admin/enterprise-applications', icon: <SolutionOutlined />, label: '企业申请' },
    ],
  },
  {
    type: 'group' as const,
    key: 'group-standard-execution',
    label: '标准执行管理',
    hidden: !SE_UI_ENABLED, // SE 灰度开关：关闭时整组隐藏（代码/路由仍在，仅入口不暴露）
    children: [
      { key: '/admin/standard-execution/dashboard', icon: <DashboardOutlined />, label: '执行总览' },
      { key: '/admin/standard-execution/intelligence-dashboard', icon: <BarChartOutlined />, label: '数据看板' },
      { key: '/admin/standard-execution/sources', icon: <BookOutlined />, label: '标准库' },
      { key: '/admin/standard-execution/tasks', icon: <ScheduleOutlined />, label: '任务管理' },
      { key: '/admin/standard-execution/reviews', icon: <AuditOutlined />, label: '合规审核台' },
      { key: '/admin/standard-execution/records', icon: <CheckSquareOutlined />, label: '证据库' },
      { key: '/admin/standard-execution/packages', icon: <FolderOpenOutlined />, label: '审计包管理' },
      { key: '/admin/standard-execution/risks', icon: <WarningOutlined />, label: '合规雷达' },
      { key: '/admin/standard-execution/industry-templates', icon: <AppstoreOutlined />, label: '行业模板库' },
    ],
  },
  {
    type: 'group' as const,
    key: 'group-system',
    label: '系统管理',
    children: [
      { key: '/admin/announcements', icon: <NotificationOutlined />, label: '公告管理' },
      { key: '/admin/content-config', icon: <AppstoreOutlined />, label: '展示内容' },
      { key: '/admin/admins', icon: <UserSwitchOutlined />, label: '人员权限管理' },
      { key: '/admin/roles', icon: <SafetyOutlined />, label: '角色管理' },
    ],
  },
]

// 按白名单过滤；'*' 表通配符返回全集；group 内子项按 menuPath 过滤,空 group 自动隐藏
// 任何 hidden:true 的菜单项一律不渲染（即使 admin 通配符也不展示），用于灰度功能预埋路由
function filterMenuByPaths(items: AdminMenuItem[], allowed: readonly string[]): AdminMenuItem[] {
  const wildcard = allowed.includes('*')
  const out: AdminMenuItem[] = []
  for (const m of items) {
    if (m.type === 'group' && Array.isArray(m.children)) {
      if (m.hidden) continue // group 级 hidden（灰度开关关闭）→ 整组不渲染
      const filteredChildren = m.children.filter((c) => {
        if (c.hidden) return false
        if (wildcard) return true
        return allowed.includes(c.key)
      })
      if (filteredChildren.length > 0) {
        out.push({ ...m, children: filteredChildren })
      }
      continue
    }
    if (m.type === 'divider') {
      if (out.length && out[out.length - 1].type !== 'divider') out.push(m)
      continue
    }
    if (m.hidden) continue
    if (wildcard || allowed.includes(m.key)) {
      out.push(m)
    }
  }
  while (out.length && out[out.length - 1].type === 'divider') out.pop()
  return out
}

export default function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const nav = useNavigate()
  const loc = useLocation()
  const { token } = theme.useToken()
  const { user, logout } = useAuth()
  const perm = usePermission()

  // 菜单与守卫数据源统一改为 PermissionContext.menuPaths
  const visibleMenuItems = filterMenuByPaths(siderMenuItems, perm.menuPaths)

  // 子路径白名单守卫：当前用户访问的 /admin/* 不在 menuPaths 内时拉回 /admin。
  // 通配符 '*' 直接放行；loading 期间不守卫（避免初次进入时误跳）。
  useEffect(() => {
    if (perm.loading) return
    if (perm.menuPaths.includes('*')) return
    // /admin 总是允许（首页壳）
    if (loc.pathname === '/admin') return
    // 前缀匹配：/admin/expert-votes 同时覆盖 /admin/expert-votes/EVR-xxx 等子路径
    const allowed = perm.menuPaths.some(
      (p) => loc.pathname === p || loc.pathname.startsWith(p + '/')
    )
    if (!allowed) {
      nav('/admin', { replace: true })
    }
  }, [perm.loading, perm.menuPaths, loc.pathname, nav])

  // 扁平化所有菜单 key（含 group 子项）用于匹配当前路由
  const allKeys = visibleMenuItems.flatMap((m) => (
    m.type === 'group' ? m.children.map((c) => c.key) : m.type === 'divider' ? [] : [m.key]
  ))
  // 最长匹配优先：避免 /admin/sales 吞掉 /admin/sales/workspace 或 /admin/sales/overview
  const activeKey =
    allKeys
      .filter((k: string) => k !== '/admin' && loc.pathname.startsWith(k))
      .sort((a: string, b: string) => b.length - a.length)[0] ||
    (loc.pathname === '/admin' ? '/admin' : '')

  // 仅 admin 角色登出回 admin 登录页；sales/staff 登出回主站首页（避免他们看到 admin login）
  const handleLogout = () => {
    const isAdminRole = user?.role === 'admin'
    logout(isAdminRole ? '/admin/login' : '/')
  }

  const userMenuItems: MenuProps['items'] = [
    { key: 'profile', icon: <UserOutlined />, label: `${user?.nickName || user?.phone || user?.email || '管理员'}` },
    { type: 'divider' as const },
    { key: 'frontend', icon: <LeftOutlined />, label: '返回前台' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
  ]

  return (
    <SEPageProvider>
    <Layout style={{ height: '100vh', minHeight: '100vh', overflow: 'hidden' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        width={220}
        style={{
          height: '100vh',
          overflow: 'hidden',
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              height: 64,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'space-between',
              padding: collapsed ? 0 : '0 16px',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            {!collapsed && (
              <Text strong style={{ fontSize: 16 }}>
                管理后台
              </Text>
            )}
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
            />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <Menu
              mode="inline"
              selectedKeys={[activeKey]}
              items={visibleMenuItems as MenuProps['items']}
              onClick={({ key }) => nav(key)}
              // 长菜单项保持单行 + 省略号,避免折行后破坏 sider 布局
              style={{ border: 'none' }}
              className="bxz-admin-menu"
            />
          </div>
        </div>
      </Sider>

      <Layout style={{ height: '100vh', minHeight: 0, overflow: 'hidden' }}>
        <Header
          style={{
            background: token.colorBgContainer,
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0,
          }}
        >
          <Button type="link" icon={<LeftOutlined />} onClick={() => nav('/')}>
            返回前台
          </Button>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
            <Text style={{ color: token.colorTextSecondary }}>标准小智 · 运营管理</Text>
            <Dropdown
              menu={{
                items: userMenuItems,
                onClick: ({ key }) => {
                  if (key === 'logout') handleLogout()
                  else if (key === 'frontend') nav('/')
                }
              }}
              placement="bottomRight"
            >
              <Space style={{ cursor: 'pointer' }}>
                <Avatar size="small" src={user?.avatarUrl || '/bxz-logo-mark.png'} style={{ background: '#fff' }} />
                <Text>{user?.nickName || user?.phone || '管理员'}</Text>
              </Space>
            </Dropdown>
          </div>
        </Header>

        <Content style={{ margin: 24, minHeight: 0, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
      {SE_UI_ENABLED && <SEAIFloatingBubble />}
    </Layout>
    </SEPageProvider>
  )
}
