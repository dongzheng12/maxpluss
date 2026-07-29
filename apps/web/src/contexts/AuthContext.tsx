/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

interface User {
  id: string
  phone?: string
  email?: string
  nickName?: string
  name?: string            // 用户名（同 nickName，用于编辑场景）
  organization?: string    // 所属单位
  avatarUrl?: string
  memberTier?: 'free' | 'personal' | 'pro' | 'enterprise'
  memberExpire?: string
  passwordMustChange?: boolean
  role?: 'user' | 'admin' | 'sales'
}

interface AuthState {
  user: User | null
  isLoggedIn: boolean
  isAdmin: boolean
  loading: boolean
  login: (user: User) => void
  logout: (redirect?: string) => void
}

const AuthContext = createContext<AuthState>({
  user: null,
  isLoggedIn: false,
  isAdmin: false,
  loading: true,
  login: () => {},
  logout: () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const s = localStorage.getItem('bxz_user')
      return s ? JSON.parse(s) : null
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(true)

  // On mount: if we have a token, verify it by fetching profile
  useEffect(() => {
    const token = localStorage.getItem('bxz_token')

    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false)
      return
    }
    // 直接用 fetch 验证 token，绕过 axios 拦截器的自动跳转
    const base = import.meta.env.DEV ? '/node-api' : ''
    fetch(`${base}/api/app/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => {
        const u = res?.user
        if (u) {
          const membership = res?.membership
          setUser({
            id: u.id,
            phone: u.phone,
            email: u.email,
            nickName: u.name || u.phone || u.email,
            avatarUrl: u.avatarUrl,
            role: u.role || 'user',
            memberTier: membership?.plan?.id || 'free',
            memberExpire: membership?.endAt,
            passwordMustChange: u.passwordMustChange === true,
          })
        }
      })
      .catch(() => {
        // Token expired or invalid — 静默降级，不跳登录页
        // ⚠️ B001 修复：guard 闭包旧 token 与 localStorage 当前 token 一致才清,
        // 否则用户可能已经在挂载-fetch 完成的窗口期重新登录,
        // 把新 token + 新 user 误清会触发 ProtectedRoute → /admin/login 二次登录。
        if (localStorage.getItem('bxz_token') === token) {
          localStorage.removeItem('bxz_token')
          localStorage.removeItem('bxz_user')
          localStorage.removeItem('bxz_user_id')
          setUser(null)
        }
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const handleAuthExpired = () => {
      setUser(null)
      setLoading(false)
    }
    window.addEventListener('bxz-auth-expired', handleAuthExpired)
    return () => window.removeEventListener('bxz-auth-expired', handleAuthExpired)
  }, [])

  // Persist user to localStorage
  useEffect(() => {
    if (user) {
      localStorage.setItem('bxz_user', JSON.stringify(user))
      localStorage.setItem('bxz_user_id', user.id)
    } else {
      localStorage.removeItem('bxz_user')
      localStorage.removeItem('bxz_user_id')
      localStorage.removeItem('bxz_token')
    }
  }, [user])

  const login = (u: User) => setUser(u)
  const logout = (redirect?: string) => {
    localStorage.removeItem('bxz_token')
    localStorage.removeItem('bxz_user')
    localStorage.removeItem('bxz_user_id')
    sessionStorage.setItem('bxz_manual_logout', '1')
    setUser(null)
    if (redirect !== undefined && typeof window !== 'undefined') {
      window.location.href = redirect
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoggedIn: !!user,
        isAdmin: user?.role === 'admin',
        loading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
