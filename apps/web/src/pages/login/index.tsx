import { useEffect, useState } from 'react'
import { Form, Input, Button, Typography, Select, message } from 'antd'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { login as apiLogin } from '../../api/app'
import { nodeApi } from '../../api/client'
import { enterpriseMe } from '../../api/standardExecution'
import { SE_UI_ENABLED } from '../../config/featureFlags'
import { consumePendingReferral } from '../../utils/referral'
import logoBxz from '../../assets/logo-bxz.png'
import styles from './login.module.css'

const { Text } = Typography

type TabKey = 'personal' | 'enterprise'

export default function LoginPage() {
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<TabKey>(
    SE_UI_ENABLED && searchParams.get('tab') === 'enterprise' ? 'enterprise' : 'personal'
  )
  const redirectTo = searchParams.get('redirect')
  const reason = searchParams.get('reason')

  return (
    <div className={styles.loginRoot}>
      <LeftBrandPanel />
      <div className={styles.rightPanel}>
        <div className={styles.rightInner}>
          <div className={styles.tabSwitcher}>
            <button
              type="button"
              className={`${styles.tabItem} ${tab === 'personal' ? styles.tabActive : ''}`}
              onClick={() => setTab('personal')}
            >
              个人版
            </button>
            {SE_UI_ENABLED && (
              <button
                type="button"
                className={`${styles.tabItem} ${tab === 'enterprise' ? styles.tabActive : ''}`}
                onClick={() => setTab('enterprise')}
              >
                企业版
              </button>
            )}
          </div>

          {tab === 'personal' ? (
            <PersonalLoginForm redirectTo={redirectTo} isSalesLogin={!!(redirectTo?.startsWith('/sales/'))} />
          ) : (
            <EnterpriseLoginForm redirectTo={redirectTo} reason={reason} />
          )}

          <div className={styles.terms}>
            <Text type="secondary" style={{ fontSize: 12, color: '#b0b0b0' }}>
              登录即代表同意{' '}
              <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#6ea8fe' }}>服务条款</a>
              {' '}和{' '}
              <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: '#6ea8fe' }}>隐私政策</a>
            </Text>
          </div>
        </div>
      </div>
    </div>
  )
}

function LeftBrandPanel() {
  return (
    <aside className={styles.leftPanel}>
      <img
        src={logoBxz}
        alt="标准小智 SMART STANDARD"
        className={styles.brandLogoImg}
      />
      <span className={styles.shippedMarker} aria-hidden="true">标准执行与信息管理平台</span>
      <div className={styles.brandTag}>标准化数字平台</div>

      <h1 className={styles.brandTitle}>
        用标准解决您<br />
        生产·销售<br />
        前中后的互联网化诉求
      </h1>
      <p className={styles.brandSubtitle}>
        从标准出发，延展到场景化应用与企业定制，帮助企业把标准真正用到生产、销售、质量、安全和管理流程中。
      </p>

      <ol className={styles.featureList}>
        <li><span className={styles.featureBadge}>1</span>标准检索、AI 辅助与文档比对</li>
        <li><span className={styles.featureBadge}>2</span>SOP、培训资料与上岗准入</li>
        <li><span className={styles.featureBadge}>3</span>质量、安全、合规场景化应用</li>
        <li><span className={styles.featureBadge}>4</span>数据看板、一对一与企业定制</li>
      </ol>
    </aside>
  )
}

// ─── 个人登录：handleLogin / consumePendingReferral / track 三段逻辑保持原样 ───
function PersonalLoginForm({ redirectTo, isSalesLogin }: { redirectTo: string | null; isSalesLogin: boolean }) {
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const { login } = useAuth()
  const nav = useNavigate()

  const handleLogin = async (values: { account: string; password: string }) => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await apiLogin(values.account, values.password)
      sessionStorage.removeItem('bxz_manual_logout')
      if (res?.token) localStorage.setItem('bxz_token', res.token)

      const u = res?.user
      login({
        id: u?.id,
        phone: u?.phone,
        email: u?.email,
        nickName: u?.name || u?.phone || u?.email,
        memberTier: res?.membership?.plan?.id || 'free',
        memberExpire: res?.membership?.endAt,
        role: u?.role || 'user',
        passwordMustChange: u?.passwordMustChange === true,
      })
      // 裂变归因：若 localStorage 有 pendingReferral（来自 ?ref= URL 捕获）则消费
      consumePendingReferral()

      message.success('登录成功')
      import('../../utils/tracker').then(({ track }) => track('login_complete', { method: 'sms' }))
      const safeRedirect = redirectTo && redirectTo.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : null
      // 修正版：sales 与 user 一样默认进首页 /
      // sales 通过首页右上角用户菜单"管理后台"主动进入 /admin
      const defaultPath = u?.role === 'admin' ? '/admin' : '/'
      nav(safeRedirect || defaultPath)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h2 className={styles.formTitle}>登录</h2>
      <Form form={form} layout="vertical" onFinish={handleLogin}>
        <Form.Item name="account" rules={[{ required: true, message: '请输入手机号' }]}>
          <Input placeholder="手机号" size="large" />
        </Form.Item>
        <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="密码" size="large" />
        </Form.Item>
        <Form.Item style={{ marginBottom: 12 }}>
          <Button htmlType="submit" block size="large" loading={loading} className={styles.primaryBtn}>
            登录
          </Button>
        </Form.Item>
      </Form>

      <div className={styles.linkRow}>
        {isSalesLogin ? (
          <Text type="secondary" style={{ fontSize: 13 }}>
            还没有账号？请通过
            <a onClick={() => nav('/sales/join')} style={{ cursor: 'pointer', color: '#1677ff' }}>邀请码入口</a>
            注册
          </Text>
        ) : (
          <>
            <a onClick={() => nav('/register')} className={styles.linkBlue}>立即注册</a>
            <span className={styles.linkSep}>|</span>
            <a onClick={() => nav('/forgot-password')} className={styles.linkBlue}>忘记密码</a>
          </>
        )}
      </div>
    </>
  )
}

// ─── 企业版：登录 / 申请 内联切换 ───
type EnterpriseMode = 'login' | 'apply'

function EnterpriseLoginForm({ redirectTo, reason }: { redirectTo: string | null; reason: string | null }) {
  const [mode, setMode] = useState<EnterpriseMode>('login')

  if (mode === 'apply') return <EnterpriseApplyForm onBack={() => setMode('login')} />
  return <EnterpriseLoginInner onApply={() => setMode('apply')} redirectTo={redirectTo} reason={reason} />
}

function EnterpriseLoginInner({ onApply, redirectTo, reason }: { onApply: () => void; redirectTo: string | null; reason: string | null }) {
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const { login } = useAuth()
  const nav = useNavigate()

  useEffect(() => {
    if (reason === 'no-enterprise-role') {
      message.warning('当前账号未开通企业版权限，请联系管理员')
    }
  }, [reason])

  const handleLogin = async (values: { account: string; password: string }) => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await apiLogin(values.account, values.password)
      sessionStorage.removeItem('bxz_manual_logout')
      if (res?.token) localStorage.setItem('bxz_token', res.token)

      const u = res?.user
      try {
        const me = await enterpriseMe()
        const enterpriseRole = me?.enterpriseRole || null
        const isAdminBypass = !!me?.isAdminBypass
        // 普通注册用户 enterpriseId=null → 拦截；admin bypass/真实企业角色 → 放行
        if (!me?.enterpriseId || (!enterpriseRole && !isAdminBypass)) {
          message.error('此账号暂无企业版权限，请联系企业管理员')
          localStorage.removeItem('bxz_token')
          return
        }
        login({
          id: u?.id,
          phone: u?.phone,
          email: u?.email,
          nickName: u?.name || u?.phone || u?.email,
          memberTier: res?.membership?.plan?.id || 'free',
          memberExpire: res?.membership?.endAt,
          role: u?.role || 'user',
          passwordMustChange: u?.passwordMustChange === true,
        })
        message.success('登录成功')
        const safeRedirect = redirectTo
          && redirectTo.startsWith('/enterprise')
          && !redirectTo.startsWith('//')
          && !redirectTo.startsWith('/enterprise/login')
          ? redirectTo
          : null
        const defaultDest = me?.user?.passwordMustChange === true
          ? '/enterprise/members?forceChangePassword=1'
          : enterpriseRole === 'EMPLOYEE' && !isAdminBypass ? '/enterprise/my-tasks' : '/enterprise/dashboard'
        nav(safeRedirect || defaultDest, { replace: true })
      } catch {
        message.error('此账号暂无企业版权限，请联系企业管理员')
        localStorage.removeItem('bxz_token')
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h2 className={styles.formTitle}>企业版登录</h2>
      <p className={styles.formSubtitle}>标准执行 · 一站式合规管理</p>
      <Form form={form} layout="vertical" onFinish={handleLogin}>
        <Form.Item name="account" rules={[{ required: true, message: '请输入手机号' }]}>
          <Input placeholder="手机号" size="large" />
        </Form.Item>
        <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="密码" size="large" />
        </Form.Item>
        <Form.Item style={{ marginBottom: 12 }}>
          <Button htmlType="submit" block size="large" loading={loading} className={styles.enterpriseSubmitBtn}>
            登录
          </Button>
        </Form.Item>
      </Form>
      <div className={styles.enterpriseApplyRow}>
        <span className={styles.enterpriseApplyText}>还没有企业版账号？</span>
        <a className={styles.enterpriseApplyLink} onClick={onApply}>申请企业版</a>
      </div>
    </>
  )
}

function EnterpriseApplyForm({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [form] = Form.useForm()

  const handleSubmit = async (values: {
    company: string; name: string; position?: string; phone: string
    industry: string; companySize: string; useCase: string; remark?: string
  }) => {
    setLoading(true)
    try {
      // 新字段打包进 requirement 文本（DB 无需 migration）
      const requirementText = [
        `行业：${values.industry}`,
        `规模：${values.companySize}`,
        `用途：${values.useCase}`,
        values.remark ? `备注：${values.remark}` : '',
      ].filter(Boolean).join('；')
      const payload = {
        company: values.company,
        name: values.name,
        position: values.position || '——',
        phone: values.phone,
        requirement: requirementText,
      }
      await nodeApi.post('/api/app/enterprise/apply', payload)
      setDone(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '提交失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className={styles.applySuccessBox}>
        <div className={styles.applySuccessIcon}>✓</div>
        <h2 className={styles.formTitle}>申请已提交</h2>
        <p className={styles.formSubtitle}>我们会在 1-2 个工作日内与您联系，请保持手机畅通。</p>
        <Button block size="large" className={styles.enterpriseSubmitBtn} onClick={onBack}>
          返回登录
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className={styles.applyHeader}>
        <button type="button" className={styles.applyBack} onClick={onBack}>← 返回登录</button>
        <h2 className={styles.formTitle} style={{ marginTop: 8 }}>申请企业版</h2>
        <p className={styles.formSubtitle}>填写信息后，我们会尽快与您联系完成开通。</p>
      </div>
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item name="company" label="企业名称" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="请输入企业全称" size="large" maxLength={100} />
        </Form.Item>
        <Form.Item name="name" label="联系人姓名" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="请输入姓名" size="large" maxLength={50} />
        </Form.Item>
        <Form.Item name="phone" label="联系手机" rules={[{ required: true, message: '必填' }, { pattern: /^1\d{10}$/, message: '手机号格式错误' }]}>
          <Input placeholder="请输入手机号" size="large" maxLength={11} />
        </Form.Item>
        <Form.Item name="industry" label="所属行业" rules={[{ required: true, message: '请选择行业' }]}>
          <Select size="large" placeholder="请选择所属行业" options={[
            { value: '制造业', label: '制造业' },
            { value: '建筑工程', label: '建筑工程' },
            { value: '食品饮料', label: '食品饮料' },
            { value: '医疗器械', label: '医疗器械' },
            { value: '电子信息', label: '电子信息' },
            { value: '化工材料', label: '化工材料' },
            { value: '汽车零部件', label: '汽车零部件' },
            { value: '能源电力', label: '能源电力' },
            { value: '其他', label: '其他' },
          ]} />
        </Form.Item>
        <Form.Item name="companySize" label="企业规模" rules={[{ required: true, message: '请选择规模' }]}>
          <Select size="large" placeholder="请选择企业规模" options={[
            { value: '20人以下', label: '20人以下' },
            { value: '20-100人', label: '20-100人' },
            { value: '100-500人', label: '100-500人' },
            { value: '500-2000人', label: '500-2000人' },
            { value: '2000人以上', label: '2000人以上' },
          ]} />
        </Form.Item>
        <Form.Item name="useCase" label="申请用途/使用场景" rules={[{ required: true, message: '必填' }]}>
          <Select size="large" placeholder="请选择主要使用场景" options={[
            { value: '客户验厂/审厂准备', label: '客户验厂/审厂准备' },
            { value: '内部合规管理', label: '内部合规管理' },
            { value: '质量认证（ISO/CE等）', label: '质量认证（ISO/CE等）' },
            { value: '安全生产管理', label: '安全生产管理' },
            { value: '员工培训与上岗', label: '员工培训与上岗' },
            { value: '政府监管/行业检查', label: '政府监管/行业检查' },
            { value: '其他', label: '其他' },
          ]} />
        </Form.Item>
        <Form.Item name="remark" label="备注（选填）">
          <Input.TextArea placeholder="如有其他说明请填写" rows={2} maxLength={300} />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button htmlType="submit" block size="large" loading={loading} className={styles.enterpriseSubmitBtn}>
            提交申请
          </Button>
        </Form.Item>
      </Form>
    </>
  )
}
