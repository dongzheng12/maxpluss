/**
 * 后台菜单 / 操作权限配置（v3.1 嵌套版）。
 *
 * v3.1 重组：把菜单与其下挂的操作权限合并到 ADMIN_MENU_PERMISSIONS 一棵树。
 * 角色配置 Drawer 按菜单分组展示，便于"全选本菜单权限"。
 *
 * 历史扁平导出 ADMIN_MENU_TREE / ADMIN_ACTION_PERMISSIONS 仍以派生形式保留，
 * 旧调用方继续可用，逐步迁移。
 */

export interface AdminMenuPermissionItem {
  key: string
  label: string
}

export interface AdminMenuNode {
  /** 菜单 key（与 AdminLayout siderMenuItems 同步维护，亦是路径白名单的元素） */
  key: string
  label: string
  /** 该菜单下挂的操作权限；空数组表示菜单本身可见即足够（如数据概览） */
  permissions: readonly AdminMenuPermissionItem[]
}

/**
 * 菜单 + 操作权限统一来源。
 *
 * 增减菜单/操作时务必两处一起改：
 *   - 此处的 ADMIN_MENU_PERMISSIONS
 *   - apps/web/src/admin/AdminLayout.tsx 的 siderMenuItems
 *
 * 操作权限 key 命名约定：admin.<module>.<verb>，与后端 requirePermission 严格一致。
 */
export const ADMIN_MENU_PERMISSIONS: readonly AdminMenuNode[] = [
  {
    key: '/admin',
    label: '数据概览',
    permissions: [
      { key: 'admin.dashboard.read', label: '查看数据概览' },
    ],
  },
  {
    key: '/admin/users',
    label: '用户管理',
    permissions: [
      { key: 'admin.users.read',   label: '查看用户列表' },
      { key: 'admin.users.toggle', label: '启用/禁用用户' },
    ],
  },
  {
    key: '/admin/orders',
    label: '订单管理',
    permissions: [
      { key: 'admin.orders.read',    label: '查看订单列表' },
      { key: 'admin.orders.export',  label: '导出订单' },
      { key: 'admin.orders.confirm', label: '确认/驳回支付凭证' },
      { key: 'admin.orders.refund',  label: '退款操作' },
    ],
  },
  {
    key: '/admin/compare-tasks',
    label: '比对任务',
    permissions: [],
  },
  {
    key: '/admin/invoices',
    label: '发票管理',
    permissions: [
      { key: 'admin.invoices.read',   label: '查看发票申请' },
      { key: 'admin.invoices.issue',  label: '开票操作' },
      { key: 'admin.invoices.reject', label: '驳回发票申请' },
    ],
  },
  {
    key: '/admin/bookings',
    label: '服务预约',
    permissions: [
      { key: 'admin.bookings.read',   label: '查看服务预约' },
      { key: 'admin.bookings.manage', label: '更新预约状态' },
    ],
  },
  {
    key: '/admin/expert-votes',
    label: '专家投票管理',
    permissions: [
      { key: 'admin.expertVotes.read',           label: '查看专家投票申请' },
      { key: 'admin.expertVotes.assignExperts',  label: '录入专家名单' },
      { key: 'admin.expertVotes.confirmMeeting', label: '回填并确认会议安排' },
      { key: 'admin.expertVotes.notifyExperts',  label: '通知专家（站内消息 / 文案下发）' },
      { key: 'admin.expertVotes.manageVoting',   label: '管理投票整理（开启 / 录入 / 关闭）' },
      { key: 'admin.expertVotes.manageDelivery', label: '管理交付文件（生成 / 上传 / 完成）' },
    ],
  },
  {
    key: '/admin/gifts',
    label: '销售赠送',
    permissions: [],
  },
  {
    key: '/admin/coupons',
    label: '优惠券',
    permissions: [
      { key: 'admin.coupons.read', label: '查看优惠券' },
    ],
  },
  {
    key: '/admin/sales',
    label: '销售推广',
    permissions: [
      { key: 'admin.sales.read', label: '查看销售推广' },
    ],
  },
  {
    key: '/admin/sales/overview',
    label: '销售数据看板',
    permissions: [],
  },
  {
    key: '/admin/announcements',
    label: '公告管理',
    permissions: [
      { key: 'admin.announcements.manage', label: '管理公告' },
    ],
  },
  {
    key: '/admin/content-config',
    label: '展示内容',
    permissions: [
      { key: 'admin.content.manage', label: '管理展示内容' },
    ],
  },
  {
    key: '/admin/sales/workspace',
    label: '我的推广主页',
    permissions: [],
  },
  {
    key: '/admin/enterprise-applications',
    label: '企业申请',
    permissions: [],
  },
  {
    key: '/admin/admins',
    label: '人员权限管理',
    permissions: [],
  },
  {
    key: '/admin/roles',
    label: '角色管理',
    permissions: [],
  },
]

// ─── 历史扁平导出（派生，保持调用方兼容） ───────────────────────

export interface AdminMenuTreeItem {
  key: string
  label: string
}

export interface AdminActionPermission {
  key: string
  label: string
}

export const ADMIN_MENU_TREE: readonly AdminMenuTreeItem[] = ADMIN_MENU_PERMISSIONS.map(
  ({ key, label }) => ({ key, label }),
)

export const ADMIN_ACTION_PERMISSIONS: readonly AdminActionPermission[] = ADMIN_MENU_PERMISSIONS.flatMap(
  (m) => m.permissions,
)
