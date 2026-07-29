import { useState, useEffect } from 'react'
import { Layout, Menu, Avatar, Dropdown, Button, Space, Typography, Drawer } from 'antd'
import {
  HomeOutlined,
  SearchOutlined,
  DiffOutlined,
  TeamOutlined,
  NodeIndexOutlined,
  AppstoreOutlined,
  PhoneOutlined,
  ShoppingCartOutlined,
  UserOutlined,
  CrownOutlined,
  SettingOutlined,
  LogoutOutlined,
  FileProtectOutlined,
  StarOutlined,
  SolutionOutlined,
  RobotOutlined,
  MenuOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { usePermission } from '../contexts/PermissionContext'
import NotificationBell from '../components/NotificationBell'

const { Header, Content, Footer } = Layout
const { Text } = Typography

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(window.innerWidth <= breakpoint)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [breakpoint])
  return mobile
}

const menuItems = [
  { key: '/', icon: <HomeOutlined />, label: '首页' },
  {
    key: 'service-group',
    icon: <SolutionOutlined />,
    label: '标准服务',
    children: [
      { key: '/standards', icon: <SearchOutlined />, label: '标准信息查询' },
      { key: '/committee', icon: <TeamOutlined />, label: '技术委员会' },
      { key: '/booking', icon: <PhoneOutlined />, label: '服务预约' },
      { key: '/expert-vote', icon: <SolutionOutlined />, label: '专家评审投票' },
    ],
  },
  {
    key: 'ai-group',
    icon: <AppstoreOutlined />,
    label: 'AI工具',
    children: [
      { key: '/graph', icon: <NodeIndexOutlined />, label: '标准图谱' },
      { key: '/compare', icon: <DiffOutlined />, label: '文档比对' },
      { key: '/chat', icon: <RobotOutlined />, label: '呼叫小智' },
    ],
  },
]

export default function UserLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const { user, isLoggedIn, isAdmin, logout } = useAuth()
  const perm = usePermission()
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Close drawer on route change
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setDrawerOpen(false) }, [loc.pathname])

  const userMenuItems = isLoggedIn
    ? [
        { key: 'profile', icon: <UserOutlined />, label: '个人中心' },
        { key: '/orders', icon: <ShoppingCartOutlined />, label: '我的订单' },
        { key: '/invoices', icon: <FileProtectOutlined />, label: '我的发票' },
        { key: '/favorites', icon: <StarOutlined />, label: '我的收藏' },
        { key: '/membership', icon: <CrownOutlined />, label: '会员中心' },
        { key: '/referral', icon: <TeamOutlined />, label: '邀请好友' },
        ...((isAdmin || user?.role === 'sales' || perm.hasAdminAccess) ? [{ key: '/admin', icon: <SettingOutlined />, label: '管理后台' }] : []),
        { type: 'divider' as const },
        { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
      ]
    : []

  const handleUserMenu = ({ key }: { key: string }) => {
    if (key === 'logout') {
      logout('/')
      return
    } else if (key === 'profile') {
      nav('/profile')
    } else {
      nav(key)
    }
  }

  const handleNavMenu = ({ key }: { key: string }) => {
    if (key.startsWith('/')) nav(key)
  }

  // Determine active menu key — check children groups too
  const allLeafKeys: string[] = []
  menuItems.forEach((m) => {
    if ('children' in m && m.children) {
      m.children.forEach((c) => allLeafKeys.push(c.key))
    } else {
      allLeafKeys.push(m.key)
    }
  })
  const activeKey = allLeafKeys.find((k) => k !== '/' && loc.pathname.startsWith(k)) || '/'

  // Flat menu items for mobile drawer (no nested submenus)
  const flatMenuItems = [
    { key: '/', icon: <HomeOutlined />, label: '首页' },
    { key: '/standards', icon: <SearchOutlined />, label: '标准信息查询' },
    { key: '/committee', icon: <TeamOutlined />, label: '技术委员会' },
    { key: '/booking', icon: <PhoneOutlined />, label: '服务预约' },
    { key: '/expert-vote', icon: <SolutionOutlined />, label: '专家评审投票' },
    { key: '/graph', icon: <NodeIndexOutlined />, label: '标准图谱' },
    { key: '/compare', icon: <DiffOutlined />, label: '文档比对' },
    { key: '/chat', icon: <RobotOutlined />, label: '呼叫小智' },
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
          padding: isMobile ? '0 16px' : '0 32px',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.03)',
          height: 64,
          lineHeight: '64px',
        }}
      >
        {/* Mobile hamburger */}
        {isMobile && (
          <Button
            type="text"
            icon={<MenuOutlined />}
            onClick={() => setDrawerOpen(true)}
            style={{ marginRight: 12, fontSize: 18 }}
          />
        )}

        <div
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', marginRight: isMobile ? 0 : 32 }}
          onClick={() => nav('/')}
        >
          <img
            src="/logo.png"
            alt="标准小智"
            style={{ height: 48, display: 'block' }}
          />
        </div>

        {/* Desktop horizontal menu */}
        {!isMobile && (
          <Menu
            mode="horizontal"
            selectedKeys={[activeKey]}
            items={menuItems}
            onClick={handleNavMenu}
            style={{ flex: 1, border: 'none' }}
          />
        )}

        {isMobile && <div style={{ flex: 1 }} />}

        <Space size={isMobile ? 4 : 12}>
          {isLoggedIn && <NotificationBell />}
          {isLoggedIn ? (
            <Dropdown menu={{ items: userMenuItems, onClick: handleUserMenu }} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar src={user?.avatarUrl || '/bxz-logo-mark.png'} />
                {!isMobile && <Text>{user?.nickName || user?.phone || '用户'}</Text>}
              </Space>
            </Dropdown>
          ) : (
            <Button type="primary" size={isMobile ? 'small' : 'middle'} onClick={() => nav('/login')}>
              登录
            </Button>
          )}
        </Space>
      </Header>

      {/* Mobile navigation drawer */}
      <Drawer
        title="标准小智"
        placement="left"
        width={280}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        closeIcon={<CloseOutlined />}
        styles={{ body: { padding: 0 } }}
      >
        <Menu
          mode="inline"
          selectedKeys={[activeKey]}
          items={flatMenuItems}
          onClick={(info) => { handleNavMenu(info); setDrawerOpen(false) }}
          style={{ border: 'none' }}
        />
        {isLoggedIn && (
          <>
            <div style={{ padding: '12px 16px 4px', color: '#999', fontSize: 12 }}>个人</div>
            <Menu
              mode="inline"
              selectedKeys={[]}
              items={userMenuItems}
              onClick={(info) => { handleUserMenu(info); setDrawerOpen(false) }}
              style={{ border: 'none' }}
            />
          </>
        )}
      </Drawer>

      <Content style={{ padding: isMobile ? '16px' : '28px 48px 40px', maxWidth: 1280, margin: '0 auto', width: '100%' }}>
        <Outlet />
      </Content>

      <Footer style={{ textAlign: 'center', color: '#999', background: '#fafafa', borderTop: '1px solid #f0f0f0', padding: isMobile ? '16px' : '20px 50px' }}>
        <div style={{ marginBottom: 10 }}>
          <Text type="secondary" style={{ fontSize: 12, lineHeight: '1.8' }}>
            网站平台主要提供标准题录信息、摘要介绍及相关获取指引。
            {!isMobile && <br />}
            标准全文的在线阅读、下载或来源跳转，以相关标准的版权状态、官方公开范围及平台授权情况为准。
            {!isMobile && <br />}
            {!isMobile && '对于国际标准、采标标准及其他受版权限制的内容，平台不提供站内全文展示，具体获取和使用请以权利人或官方渠道要求为准。'}
          </Text>
        </div>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            <a href="/privacy" style={{ color: '#999', marginRight: 16 }}>隐私政策</a>
            <a href="/terms" style={{ color: '#999', marginRight: 16 }}>服务条款</a>
          </Text>
        </div>
        <div style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            © {new Date().getFullYear()} 通标中研标准化研究院 标准小智 | <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" style={{ color: '#999' }}>京ICP备20023187号-8</a>
          </Text>
        </div>
      </Footer>
    </Layout>
  )
}
