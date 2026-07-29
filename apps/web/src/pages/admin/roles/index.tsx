/**
 * 角色管理
 *
 * 接入 /api/admin/roles（v2.1 RBAC）。
 * - 列表：角色名/描述/状态/人员数
 * - 新建/编辑 Drawer：v3.1 起按菜单分组展示
 *   - 每组左侧勾"启用菜单"，右侧勾该菜单下的操作权限
 *   - 顶部"全选本菜单权限"快捷勾（仅有操作权限的菜单显示）
 *   - 没有操作权限的菜单（数据概览、比对任务、销售看板等）只显示菜单勾
 *   - 菜单勾选与操作权限是分开控制的两个集合
 * - 启停 / 删除（isSystem 或有人员则后端 409）
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Table, Card, Typography, Button, Space, Drawer, Form, Input,
  Checkbox, Tag, Popconfirm, Switch, message, Collapse,
} from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import { ADMIN_MENU_PERMISSIONS } from '../../../admin/config/menuPermissions'

const { Title, Text } = Typography

const SALES_BUILT_IN_ROLE_NAME = '销售'
const SALES_CORE_MENU_PATH = '/admin/sales/workspace'

interface RoleItem {
  id: string
  name: string
  description: string | null
  menuPermissions: string[]
  actionPermissions: string[]
  dataScope: 'ALL' | 'SELF' | 'TEAM'
  isSystem: boolean
  status: 'ACTIVE' | 'DISABLED'
  userCount: number
  createdAt: string
}

export default function AdminRolesPage() {
  const [items, setItems] = useState<RoleItem[]>([])
  const [loading, setLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<RoleItem | null>(null)
  const [form] = Form.useForm()

  // Drawer 内的两组权限受控值；submit 前再回写到 form 字段
  const [menuPerms, setMenuPerms] = useState<string[]>([])
  const [actionPerms, setActionPerms] = useState<string[]>([])

  const isEditingSalesBuiltIn = !!editing && editing.isSystem && editing.name === SALES_BUILT_IN_ROLE_NAME

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/roles')
      setItems(res?.items || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    setMenuPerms([])
    setActionPerms([])
    setDrawerOpen(true)
  }
  const openEdit = (r: RoleItem) => {
    setEditing(r)
    form.setFieldsValue({
      name: r.name,
      description: r.description ?? undefined,
    })
    setMenuPerms(r.menuPermissions || [])
    setActionPerms(r.actionPermissions || [])
    setDrawerOpen(true)
  }

  const submit = async () => {
    try {
      const values = await form.validateFields()
      const payload = {
        ...values,
        menuPermissions: menuPerms,
        actionPermissions: actionPerms,
      }
      if (editing) {
        await nodeApi.put(`/api/admin/roles/${editing.id}`, payload)
        message.success('已更新')
      } else {
        await nodeApi.post('/api/admin/roles', payload)
        message.success('已创建')
      }
      setDrawerOpen(false)
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.response?.data?.error || '保存失败')
    }
  }

  const toggle = async (r: RoleItem, active: boolean) => {
    try {
      await nodeApi.patch(`/api/admin/roles/${r.id}/status`, { active })
      message.success(active ? '已启用' : '已停用')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '操作失败') }
  }
  const remove = async (r: RoleItem) => {
    try {
      await nodeApi.delete(`/api/admin/roles/${r.id}`)
      message.success('已删除')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '删除失败') }
  }

  // ─── Drawer 内权限分组渲染 ───────────────────────
  const toggleMenu = (key: string, checked: boolean) => {
    setMenuPerms((prev) => checked ? Array.from(new Set([...prev, key])) : prev.filter((k) => k !== key))
  }
  const toggleAction = (key: string, checked: boolean) => {
    setActionPerms((prev) => checked ? Array.from(new Set([...prev, key])) : prev.filter((k) => k !== key))
  }

  // 给某个菜单"全选/取消全选本菜单权限"
  const setMenuActions = (menuKey: string, allKeys: string[], checked: boolean) => {
    setActionPerms((prev) => {
      const remain = prev.filter((k) => !allKeys.includes(k))
      return checked ? Array.from(new Set([...remain, ...allKeys])) : remain
    })
    // 全选操作权限时顺便把菜单勾上（取消时不强制取消菜单）
    if (checked) toggleMenu(menuKey, true)
  }

  const groupedDrawerContent = useMemo(() => {
    return ADMIN_MENU_PERMISSIONS.map((m) => {
      const allKeys = m.permissions.map((p) => p.key)
      const checkedKeys = allKeys.filter((k) => actionPerms.includes(k))
      const isAllChecked = allKeys.length > 0 && checkedKeys.length === allKeys.length
      const isIndeterminate = checkedKeys.length > 0 && checkedKeys.length < allKeys.length
      const lockCoreMenu = isEditingSalesBuiltIn && m.key === SALES_CORE_MENU_PATH
      const menuChecked = menuPerms.includes(m.key)

      const header = (
        <Space size="middle" align="center" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={menuChecked}
            disabled={lockCoreMenu}
            onChange={(e) => toggleMenu(m.key, e.target.checked)}
          >
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#888', marginRight: 8 }}>
              {m.key}
            </span>
            <Text strong>{m.label}</Text>
            {lockCoreMenu && (
              <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>（销售核心，不可移除）</Text>
            )}
          </Checkbox>
          {allKeys.length > 0 ? (
            <Tag color={isAllChecked ? 'green' : isIndeterminate ? 'gold' : 'default'} style={{ marginLeft: 4 }}>
              {checkedKeys.length}/{allKeys.length} 项操作
            </Tag>
          ) : (
            <Tag>无操作权限</Tag>
          )}
        </Space>
      )

      const body = allKeys.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          该菜单无独立操作权限，勾选菜单本身即可见。
        </Text>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={4}>
          <Checkbox
            indeterminate={isIndeterminate}
            checked={isAllChecked}
            onChange={(e) => setMenuActions(m.key, allKeys, e.target.checked)}
          >
            <Text type="secondary" style={{ fontSize: 12 }}>全选本菜单权限</Text>
          </Checkbox>
          <div style={{ paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {m.permissions.map((p) => (
              <Checkbox
                key={p.key}
                checked={actionPerms.includes(p.key)}
                onChange={(e) => toggleAction(p.key, e.target.checked)}
              >
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#888', marginRight: 8 }}>
                  {p.key}
                </span>
                {p.label}
              </Checkbox>
            ))}
          </div>
        </Space>
      )

      return { key: m.key, header, body }
    })
  }, [menuPerms, actionPerms, isEditingSalesBuiltIn])

  const columns = [
    { title: '角色名', dataIndex: 'name', key: 'name' },
    { title: '描述', dataIndex: 'description', key: 'description', render: (v: string | null) => v || <Text type="secondary">—</Text> },
    { title: '人员数', dataIndex: 'userCount', key: 'userCount' },
    {
      title: '状态', key: 'status',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: RoleItem) => {
        const isSalesBuiltIn = r.isSystem && r.name === SALES_BUILT_IN_ROLE_NAME
        return (
          <Switch
            checked={r.status === 'ACTIVE'}
            checkedChildren="启用" unCheckedChildren="停用"
            onChange={(v) => toggle(r, v)}
            disabled={isSalesBuiltIn}
            title={isSalesBuiltIn ? '"销售"内置角色不可停用' : undefined}
          />
        )
      },
    },
    {
      title: '操作', key: 'actions',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: RoleItem) => (
        <Space size="small">
          <Button size="small" onClick={() => openEdit(r)}>编辑</Button>
          {!r.isSystem && (
            <Popconfirm title={`确认删除"${r.name}"角色？`} onConfirm={() => remove(r)}>
              <Button size="small" danger>删除</Button>
            </Popconfirm>
          )}
          {r.isSystem && <Tag color="purple">内置</Tag>}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Title level={4}>角色管理</Title>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>创建角色</Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Table rowKey="id" dataSource={items} columns={columns as any} loading={loading} pagination={false} />
      </Card>

      <Drawer
        title={editing ? `编辑角色：${editing.name}` : '创建角色'}
        open={drawerOpen}
        width={640}
        onClose={() => setDrawerOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" onClick={submit}>保存</Button>
          </Space>
        }
      >
        <Form layout="vertical" form={form}>
          <Form.Item label="角色名" name="name" rules={[{ required: true, max: 40 }]}>
            <Input placeholder="如：财务、内容运营" disabled={isEditingSalesBuiltIn} />
          </Form.Item>
          {isEditingSalesBuiltIn && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: -8, marginBottom: 12 }}>
              "销售"是系统内置角色，名称不可修改。
            </Text>
          )}
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
          {/* 数据范围（dataScope）暂不暴露：当前业务无租户/团队隔离，给了权限即可见全部对应数据；
              字段在 schema/API 保留，待后续接入时再开启 UI。 */}
        </Form>

        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <Text strong>菜单与操作权限</Text>
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            菜单勾选 = 是否在侧栏看到；操作权限 = 是否能调用对应接口（两者独立）
          </Text>
        </div>
        <Collapse
          size="small"
          items={groupedDrawerContent.map((g) => ({
            key: g.key,
            label: g.header,
            children: g.body,
          }))}
        />
      </Drawer>
    </div>
  )
}
