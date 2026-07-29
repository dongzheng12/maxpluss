import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const readPage = (relativePath: string) => readFileSync(path.join(here, relativePath), 'utf8')
const count = (source: string, needle: string) => source.split(needle).length - 1

// Pins the shipped product rulings for the login page (P0 trade chain). These
// guard regressions in the personal/enterprise split, the enterprise access
// gate, redirect safety, and the no-migration enterprise application capture.
describe('login page product rulings', () => {
  const login = readPage('index.tsx')

  it('keeps both personal and enterprise tabs, with enterprise gated by the SE flag', () => {
    expect(login).toContain('个人版')
    expect(login).toContain('企业版')
    // The enterprise tab only appears when SE UI is enabled (grayscale rollout).
    expect(login).toContain('{SE_UI_ENABLED && (')
    expect(login).toContain("searchParams.get('tab') === 'enterprise'")
  })

  it('switches the enterprise pane inline between login and apply', () => {
    expect(login).toContain("type EnterpriseMode = 'login' | 'apply'")
    expect(login).toContain("if (mode === 'apply') return <EnterpriseApplyForm")
    expect(login).toContain('onApply={() => setMode')
    expect(login).toContain('申请企业版')
  })

  it('blocks enterprise login for accounts without an enterprise role and clears the token', () => {
    expect(login).toContain('const me = await enterpriseMe()')
    expect(login).toContain('此账号暂无企业版权限，请联系企业管理员')
    expect(login).toContain("localStorage.removeItem('bxz_token')")
    // Admin bypass / real enterprise role still pass.
    expect(login).toContain('isAdminBypass')
  })

  it('only honors same-origin redirect targets', () => {
    // Personal: must start with "/" and never "//".
    expect(login).toContain("redirectTo.startsWith('/') && !redirectTo.startsWith('//')")
    // Enterprise: must stay within /enterprise and never bounce back to login.
    expect(login).toContain("redirectTo.startsWith('/enterprise')")
    expect(login).toContain("!redirectTo.startsWith('/enterprise/login')")
  })

  it('captures the enterprise application without a schema migration', () => {
    // Industry / size / use-case / remark are packed into the requirement text.
    expect(login).toContain('const requirementText = [')
    expect(login).toContain("await nodeApi.post('/api/app/enterprise/apply', payload)")
    expect(login).toContain('申请已提交')
  })

  it('links the terms and privacy policy on the auth surface', () => {
    expect(login).toContain('href="/terms"')
    expect(login).toContain('href="/privacy"')
  })

  it('does not leak raw role enums into user-facing copy', () => {
    // EMPLOYEE is only used in routing logic, never rendered as a visible label.
    expect(count(login, '>EMPLOYEE<')).toBe(0)
    expect(count(login, '>ADMIN<')).toBe(0)
  })
})
