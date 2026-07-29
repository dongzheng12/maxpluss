/**
 * 销售工作台独立 Layout
 * 不共用主应用的顶部导航 / sider，销售登录后看到的完全是独立界面
 */
import { Layout, Menu, Dropdown, Avatar, Space, Typography } from 'antd'
import { LogoutOutlined, DashboardOutlined, IdcardOutlined, ShoppingCartOutlined, GiftOutlined } from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

const { Header, Content } = Layout
const { Text } = Typography

const NAV_ITEMS = [
  { key: '/sales/dashboard', icon: <DashboardOutlined />, label: '工作台' },
  { key: '/sales/profile', icon: <IdcardOutlined />, label: '推广资料' },
  { key: '/sales/material', icon: <GiftOutlined />, label: '推广素材' },
  { key: '/sales/data', icon: <ShoppingCartOutlined />, label: '订单数据' },
]

export default function SalesLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const { user, logout } = useAuth()

  const displayName = user?.nickName || user?.phone || '销售顾问'

  const userMenuItems = [
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
  ]

  const handleMenu = ({ key }: { key: string }) => {
    if (key.startsWith('/')) nav(key)
  }
  const handleUserMenu = ({ key }: { key: string }) => {
    if (key === 'logout') {
      // 销售退出回主站首页，不进 admin login（v3 RBAC 后销售不再共用 admin 登录页）
      logout('/')
    }
  }

  return (
    <Layout style={{ minHeight: '100vh', background: '#f5f7fa' }}>
      <Header style={{
        background: '#fff',
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        {/* 左侧：logo + 标题 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: 'linear-gradient(135deg, #3b82f6, #06b6d4)',
            position: 'relative', overflow: 'hidden', flexShrink: 0,
          }}>
            <div style={{
              position: 'absolute', inset: 4,
              backgroundImage: 'url(/logo-smart-standard.png)',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'left center',
              backgroundSize: 'auto 85%',
              filter: 'invert(1) brightness(2)',
            }} />
          </div>
          <Text strong style={{ fontSize: 16 }}>销售工作台</Text>
        </div>

        {/* 中间：导航 tab */}
        <Menu
          mode="horizontal"
          items={NAV_ITEMS}
          selectedKeys={[loc.pathname]}
          onClick={handleMenu}
          style={{ flex: 1, justifyContent: 'center', border: 'none', minWidth: 0 }}
        />

        {/* 右侧：访问主站 + 销售姓名 + 退出 */}
        <Space size={16}>
          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#8c9bac', fontSize: 13 }}
          >
            访问标准小智 →
          </a>
          <Dropdown menu={{ items: userMenuItems, onClick: handleUserMenu }} placement="bottomRight">
            <Space style={{ cursor: 'pointer' }}>
              <Avatar size="small" src={user?.avatarUrl || '/bxz-logo-mark.png'} style={{ background: '#fff' }} />
              <Text>{displayName}</Text>
            </Space>
          </Dropdown>
        </Space>
      </Header>

      <Content style={{ padding: 0 }}>
        <Outlet />
      </Content>
    </Layout>
  )
}
