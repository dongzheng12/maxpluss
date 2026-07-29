import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const readPage = (relativePath: string) => readFileSync(path.join(here, relativePath), 'utf8')

// Pins the shipped product rulings for the registration page (P0 trade chain):
// SMS + captcha gating, password confirmation, the sales-attribution mode, and
// invite-vs-sales attribution exclusivity.
describe('register page product rulings', () => {
  const register = readPage('index.tsx')

  it('requires captcha, 6-digit SMS code, and a 6+ char password', () => {
    expect(register).toContain('图形验证码')
    expect(register).toContain("{ len: 6, message: '验证码为6位' }")
    expect(register).toContain("{ min: 6, message: '密码至少6位' }")
  })

  it('rejects mismatched password confirmation before calling the API', () => {
    expect(register).toContain("if (values.password !== values.confirm) return message.error('两次密码不一致')")
  })

  it('gates SMS send behind phone + captcha validation', () => {
    expect(register).toContain("if (!vals.phone) return message.warning('请先填写手机号')")
    expect(register).toContain("if (!/^1[3-9]\\d{9}$/.test(vals.phone)) return message.warning('请输入有效手机号')")
    expect(register).toContain("if (!vals.captchaCode) return message.warning('请先填写图形验证码')")
  })

  it('hides optional fields and shows the trial banner in sales-attribution mode', () => {
    // Optional block (email/name/organization/invite) only renders outside sales mode.
    expect(register).toContain('{!salesInfo && (')
    expect(register).toContain('7 天免费试用')
    expect(register).toContain('的专属链接注册')
  })

  it('keeps invite code and sales code mutually exclusive (invite wins)', () => {
    expect(register).toContain('const salesCode = inviteCode ? undefined : (urlSalesCode || cookieSalesCode || undefined)')
  })

  it('validates invite code format as 8 chars without ambiguous I/O/0/1', () => {
    expect(register).toContain('/^[A-Z2-9]{8}$/.test(s)')
  })

  it('focuses the invite field instead of clearing the form on invite errors', () => {
    expect(register).toContain("if (errData?.field === 'inviteCode')")
    expect(register).toContain("form.setFields([{ name: 'inviteCode'")
  })

  it('requires agreeing to terms and privacy before submitting', () => {
    expect(register).toContain('请先同意服务条款和隐私政策')
    expect(register).toContain('href="/terms"')
    expect(register).toContain('href="/privacy"')
  })

  it('clears the pending invite cache after a successful registration', () => {
    expect(register).toContain('localStorage.removeItem(INVITE_CODE_STORAGE_KEY)')
    expect(register).toContain("message.success('注册成功')")
  })
})
