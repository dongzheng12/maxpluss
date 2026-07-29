import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  DashboardOutlined,
  BookOutlined,
  ScheduleOutlined,
  AuditOutlined,
  CheckSquareOutlined,
  FolderOpenOutlined,
  WarningOutlined,
  TeamOutlined,
  RobotOutlined,
  UnorderedListOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  QuestionCircleOutlined,
  LockOutlined,
  LogoutOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  ApiOutlined,
  PartitionOutlined,
} from '@ant-design/icons'
import { Tooltip, Dropdown, Modal, Form, Input, message } from 'antd'
import { nodeApi } from '../api/client'
import { changePassword } from '../api/app'
import { SEPageProvider } from '../contexts/SEPageProvider'
import { SE_UI_ENABLED } from '../config/featureFlags'
import { useAuth } from '../contexts/AuthContext'
import styles from './EnterpriseLayout.module.css'
import SEAIFloatingBubble from '../components/SEAIFloatingBubble'

type EnterpriseMe = {
  enterpriseId: string | null
  enterpriseRole: string | null
  enterpriseName: string | null
  enterpriseStatus: string | null
  isAdminBypass: boolean
  user: { id: string; phone?: string | null; name?: string | null; role: string }
}

const NAV_ITEMS: Array<{ key: string; path: string; icon: React.ReactNode; label: string; section?: string }> = [
  { key: 'my-tasks',     path: '/enterprise/my-tasks',     icon: <UnorderedListOutlined />, label: '我的任务',  section: '员工' },
  { key: 'dashboard',    path: '/enterprise/dashboard',    icon: <DashboardOutlined />,    label: '执行总览',  section: '管理' },
  { key: 'intelligence-dashboard', path: '/enterprise/intelligence-dashboard', icon: <BarChartOutlined />, label: '数据看板' },
  { key: 'compliance-matrix', path: '/enterprise/compliance-matrix', icon: <PartitionOutlined />, label: '合规矩阵' },
  { key: 'sources',      path: '/enterprise/sources',      icon: <BookOutlined />,         label: '标准库' },
  { key: 'requirements', path: '/enterprise/requirements', icon: <AppstoreOutlined />,     label: '控制点库' },
  { key: 'tasks',        path: '/enterprise/tasks',        icon: <ScheduleOutlined />,     label: '任务管理' },
  { key: 'reviews',      path: '/enterprise/reviews',      icon: <AuditOutlined />,        label: '合规审核台' },
  { key: 'records',      path: '/enterprise/records',      icon: <CheckSquareOutlined />,  label: '证据库' },
  { key: 'packages',     path: '/enterprise/packages',     icon: <FolderOpenOutlined />,   label: '审计包管理' },
  { key: 'risks',        path: '/enterprise/risks',        icon: <WarningOutlined />,      label: '合规雷达' },
  { key: 'question-banks', path: '/enterprise/question-banks', icon: <QuestionCircleOutlined />, label: '题库管理' },
  { key: 'members',      path: '/enterprise/members',      icon: <TeamOutlined />,         label: '组织与成员' },
  { key: 'open-api',     path: '/enterprise/open-api',     icon: <ApiOutlined />,          label: '开放 API' },
  { key: 'ai-assistant', path: '/enterprise/ai-assistant', icon: <RobotOutlined />,        label: '呼叫小智' },
]

const ROUTE_TITLE_OVERRIDES: Array<{ path: string; label: string }> = [
  { path: '/enterprise/workbench', label: '文档拆解工作台' },
  { path: '/enterprise/task-generation', label: '文档拆解工作台' },
  { path: '/enterprise/plans', label: '合规周期' },
]

export default function EnterpriseLayout() {
  const [me, setMe] = useState<EnterpriseMe | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const loc = useLocation()
  const { logout } = useAuth()
  const [changePwdOpen, setChangePwdOpen] = useState(false)
  const [pwdForm] = Form.useForm()

  // 复用成员页改密逻辑：仅当前登录用户改自己的密码
  const handleChangePwd = async () => {
    try {
      const values = await pwdForm.validateFields()
      await changePassword(values.oldPassword, values.newPassword)
      message.success('密码修改成功')
      setChangePwdOpen(false)
      pwdForm.resetFields()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  useEffect(() => {
    nodeApi.get<unknown, EnterpriseMe>('/api/enterprise/me').then((r) => setMe(r)).catch(() => {})
  }, [])

  // 员工角色只显示"我的任务"；管理员/经理/审核员显示全部
  const isEmployee = me !== null && me.enterpriseRole === 'EMPLOYEE' && !me.isAdminBypass
  const visibleNavItems = isEmployee
    ? NAV_ITEMS.filter((it) => it.key === 'my-tasks')
    : NAV_ITEMS

  const currentItem = useMemo(
    () =>
      ROUTE_TITLE_OVERRIDES.find((it) => loc.pathname.startsWith(it.path)) ||
      NAV_ITEMS.find((it) => loc.pathname.startsWith(it.path)) ||
      NAV_ITEMS[0],
    [loc.pathname],
  )

  const userInitial = (me?.user?.name || me?.user?.phone || '?').slice(0, 1).toUpperCase()
  const enterpriseName = me?.enterpriseName || '——'
  const roleLabel = me?.isAdminBypass ? '平台管理员（通配）' : (me?.enterpriseRole || '')

  const handleLogout = () => {
    // 用 logout 的 redirect 参数（window.location 硬跳转）绕过 EnterpriseRoute 守卫，
    // 否则 logout 清态触发重渲染，守卫会接管跳转；这里直接去统一登录页企业 tab。
    logout('/login?tab=enterprise')
  }

  return (
    <div className={`${styles.shell} ${collapsed ? styles.collapsed : ''}`}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarLogo}>
          <img src="/bxz-logo-mark.png" alt="标准小智" className={styles.logoMark} />
          <div className={styles.logoTextWrap}>
            <div className={styles.logoText}>标准小智</div>
            <div className={styles.logoSub}>SMART STANDARD</div>
          </div>
          <button className={styles.collapseToggle} onClick={() => setCollapsed((c) => !c)} title={collapsed ? '展开' : '收起'}>
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </div>
        <div className={styles.sidebarCompany}>
          企业：<strong>{enterpriseName}</strong>
        </div>
        <nav className={styles.sidebarNav}>
          {visibleNavItems.map((it, idx) => (
            <div key={it.key}>
              {it.section && (idx === 0 || visibleNavItems[idx - 1].section !== it.section) && (
                <div className={styles.navSectionLabel}>{it.section}</div>
              )}
              <Tooltip title={collapsed ? it.label : ''} placement="right">
                <NavLink
                  to={it.path}
                  className={({ isActive }) =>
                    `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                  }
                >
                  <span className={styles.navIcon}>{it.icon}</span>
                  <span className={styles.navLabel}>{it.label}</span>
                </NavLink>
              </Tooltip>
            </div>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <button className={styles.logoutBtn} onClick={handleLogout}>
            退出登录
          </button>
        </div>
      </aside>

      <SEPageProvider>
      <div className={styles.main}>
        <div className={styles.topbar}>
          <span className={styles.topbarTitle}>{currentItem.label}</span>
          <span className={styles.topbarSub}>{enterpriseName}{roleLabel ? ` · ${roleLabel}` : ''}</span>
          <div className={styles.topbarSpacer} />
          <Dropdown
            placement="bottomRight"
            menu={{ items: [
              { key: 'change-pwd', icon: <LockOutlined />, label: '修改密码', onClick: () => { pwdForm.resetFields(); setChangePwdOpen(true) } },
              { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: handleLogout },
            ] }}
          >
            <div className={styles.userInfo} style={{ cursor: 'pointer' }}>
              <span>{me?.user?.name || me?.user?.phone || '——'}</span>
              <div className={styles.avatar}>{userInitial}</div>
            </div>
          </Dropdown>
        </div>

        {me?.isAdminBypass && (
          <div className={styles.bypassBanner}>
            你以平台管理员身份进入企业版（通配放行），所有写操作仍受后端权限校验。
          </div>
        )}

        <div className={styles.pageContent}>
          <Outlet />
        </div>
      </div>
      {SE_UI_ENABLED && <SEAIFloatingBubble />}
      </SEPageProvider>

      <Modal
        title="修改密码"
        open={changePwdOpen}
        okText="确认修改"
        cancelText="取消"
        onOk={handleChangePwd}
        onCancel={() => { setChangePwdOpen(false); pwdForm.resetFields() }}
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true, message: '请输入旧密码' }]}>
            <Input.Password placeholder="请输入当前密码" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 6, message: '密码至少 6 位' }]}>
            <Input.Password placeholder="至少 6 位" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
