/**
 * 我的推广主页（统一 AdminLayout 下的 Tabs 容器）
 *
 * 四个 Tab 分别复用现有销售页面组件：
 *   - 工作台   (SalesDashboardPage, 原 /sales/dashboard         数据看板/我的推广码/资料完成度等)
 *   - 推广资料 (SalesProfilePage,   原 /admin/sales/profile)
 *   - 推广素材 (SalesMaterialPage,  原 /admin/sales/material)
 *   - 订单数据 (SalesDataPage,      原 /admin/sales/data)
 *
 * 适用：
 *   - sales 用户：自己的推广主页
 *   - admin/superAdmin：自己也想开通推广主页时（点「立即开通」走 init 接口）
 *
 * 当前用户无 SalesProfile 时显示空态：
 *   - admin → 显示「立即开通」按钮（调 POST /api/app/sales/profile/init，仅 admin 可调）
 *   - 其它 → 提示联系管理员
 *
 * 旧路由 /admin/sales/profile / material / data 仍可访问（向下兼容）。
 */
import { useEffect, useState } from 'react'
import { Tabs, Card, Button, Empty, message, Spin, Typography } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { nodeApi } from '../../../../api/client'
import { useAuth } from '../../../../contexts/AuthContext'
import { usePermission } from '../../../../contexts/PermissionContext'
import SalesDashboardPage from '../../../sales-dashboard'
import SalesProfilePage from '../../../sales-profile'
import SalesMaterialPage from '../../../sales-material'
import SalesDataPage from '../../../sales-data'

const { Text } = Typography

const TABS = [
  { key: 'workspace', label: '工作台', children: <SalesDashboardPage /> },
  { key: 'profile', label: '推广资料', children: <SalesProfilePage /> },
  { key: 'material', label: '推广素材', children: <SalesMaterialPage /> },
  { key: 'data', label: '订单数据', children: <SalesDataPage /> },
]

export default function AdminSalesWorkspacePage() {
  const [params, setParams] = useSearchParams()
  const active = params.get('tab') || 'workspace'
  const { user } = useAuth()
  const perm = usePermission()

  // 检测当前用户是否已有 SalesProfile（404 → 空态，200 → 正常 Tabs）
  const [hasProfile, setHasProfile] = useState<boolean | null>(null)
  const [initing, setIniting] = useState(false)

  const checkProfile = async () => {
    setHasProfile(null)
    try {
      await nodeApi.get('/api/app/sales/profile')
      setHasProfile(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const status = e?.response?.status
      if (status === 404) {
        // 真正"没建过"才进空态
        setHasProfile(false)
      } else if (status === 401) {
        // 401 — token 失效,axios 拦截器已派发 bxz-auth-expired,
        // 保持 loading 让 AuthContext 把 user 清掉触发重定向,不渲染假空态
        setHasProfile(null)
      } else {
        // 其它（403/500/网络等）→ 提示 + 进空态（admin 仍能开通救援）
        message.error(e?.response?.data?.error || '加载推广主页失败,请刷新重试')
        setHasProfile(false)
      }
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { checkProfile() }, [])

  const handleInit = async () => {
    setIniting(true)
    try {
      await nodeApi.post('/api/app/sales/profile/init')
      message.success('推广主页已开通')
      await checkProfile()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '开通失败')
    }
    setIniting(false)
  }

  const onChange = (key: string) => {
    setParams({ tab: key }, { replace: true })
  }

  if (hasProfile === null) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spin />
        </div>
      </Card>
    )
  }

  if (hasProfile === false) {
    // 自助开通条件：admin OR 已被分配销售身份(perm.isSales)
    // sales 身份用户已经被 admin 通过 RBAC 授权,允许补齐 SalesProfile 兜底死锁
    // 普通 user 仍走"联系管理员"路径(后端 init 接口同步拒普通 user)
    const canInit = user?.role === 'admin' || perm.isSales
    return (
      <Card>
        <Empty
          description={
            <div style={{ marginTop: 12 }}>
              <Text strong style={{ fontSize: 16 }}>您尚未开通推广主页</Text>
              <div style={{ marginTop: 8, color: '#8c8c8c' }}>
                {canInit
                  ? '开通后即可获得专属推广链接并追踪推广数据。'
                  : '推广主页需由管理员开通；如有疑问请联系管理员。'}
              </div>
            </div>
          }
        >
          {canInit && (
            <Button type="primary" loading={initing} onClick={handleInit}>
              立即开通
            </Button>
          )}
        </Empty>
      </Card>
    )
  }

  return (
    <div>
      <Tabs activeKey={active} onChange={onChange} items={TABS} size="large" />
    </div>
  )
}
