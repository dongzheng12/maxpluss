/* eslint-disable react-refresh/only-export-components */
/**
 * Pre-prod 8083 演示环境密码门禁。
 *
 * 原理：
 *   - 仅当 VITE_POC_ACCESS_PASSWORD 在 build time 注入时启用（生产 build 不注入 → 直接放行）
 *   - 通过密码 → localStorage 写 poc_access_ok=true + poc_access_expire_at（now + 7d）
 *   - 两个 key 都有效（true + expire > now）才放行；任一失效弹密码页
 *   - clearPocAccess() 用于"退出 POC"按钮
 *
 * 安全声明（弱门禁）：密码 build-time 编进 bundle，对懂 DevTools 的人透明。
 *   仅作"防误入"提示，配合红 banner + 数据隔离 + 公网默默无名。
 *   严肃场景必须叠 IP 白名单 / Basic Auth / Cloudflare Access 等服务端拦截。
 */
import { useState, type FormEvent, type ReactNode } from 'react'

const STORAGE_KEY_OK = 'poc_access_ok'
const STORAGE_KEY_EXPIRE = 'poc_access_expire_at'
const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

const POC_PASSWORD = import.meta.env.VITE_POC_ACCESS_PASSWORD as string | undefined

export const POC_GATE_ENABLED = Boolean(POC_PASSWORD)

function isPocAccessValid(): boolean {
  if (!POC_GATE_ENABLED) return true
  try {
    const ok = localStorage.getItem(STORAGE_KEY_OK) === 'true'
    const expireAt = Number(localStorage.getItem(STORAGE_KEY_EXPIRE) || '0')
    return ok && expireAt > Date.now()
  } catch {
    return false
  }
}

export function clearPocAccess(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_OK)
    localStorage.removeItem(STORAGE_KEY_EXPIRE)
  } catch {
    // ignore
  }
}

export function PocGate({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState<boolean>(() => isPocAccessValid())
  const [pwd, setPwd] = useState('')
  const [error, setError] = useState('')

  if (allowed) return <>{children}</>

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (pwd === POC_PASSWORD) {
      try {
        localStorage.setItem(STORAGE_KEY_OK, 'true')
        localStorage.setItem(STORAGE_KEY_EXPIRE, String(Date.now() + EXPIRE_MS))
      } catch {
        setError('localStorage 写入失败，请检查浏览器隐私模式')
        return
      }
      setAllowed(true)
    } else {
      setError('密码错误')
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#f5f5f5', fontFamily: '-apple-system, system-ui, sans-serif',
    }}>
      <form onSubmit={onSubmit} style={{
        background: '#fff', padding: '40px 32px', borderRadius: 12, width: 360,
        boxShadow: '0 4px 24px rgba(0,0,0,.08)',
      }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#222' }}>
          标准小智 Pre-prod 测试环境
        </h2>
        <p style={{ margin: '8px 0 24px', fontSize: 13, color: '#888', lineHeight: 1.6 }}>
          非正式生产 ｜ 数据仅用于演示<br />
          请输入访问密码继续
        </p>
        <input
          type="password"
          autoFocus
          value={pwd}
          onChange={(e) => { setPwd(e.target.value); setError('') }}
          placeholder="访问密码"
          style={{
            width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #d9d9d9',
            borderRadius: 6, outline: 'none', boxSizing: 'border-box',
          }}
        />
        {error && (
          <div style={{ marginTop: 8, color: '#ff3b30', fontSize: 12 }}>{error}</div>
        )}
        <button type="submit" style={{
          marginTop: 16, width: '100%', padding: '10px 12px', fontSize: 14, fontWeight: 500,
          color: '#fff', background: '#1677ff', border: 'none', borderRadius: 6, cursor: 'pointer',
        }}>
          进入
        </button>
        <p style={{ margin: '20px 0 0', fontSize: 11, color: '#bbb', textAlign: 'center' }}>
          通过后 7 天内免输入
        </p>
      </form>
    </div>
  )
}
