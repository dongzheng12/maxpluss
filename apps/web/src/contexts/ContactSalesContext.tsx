/* eslint-disable react-refresh/only-export-components */
/**
 * 全局联系销售弹窗 Context
 *
 * 任何 standalone 路由页（如 /product/biaozhunxiaozhi）调 useContactSales().openContact(salesCode)
 * 即可弹出联系销售对话框，无需跳页。
 *
 * Provider 内部：
 *  - 收到 salesCode → 拉 /api/public/sales/:salesCode 取 realName/avatar/contact
 *  - 接口失败 / contactVisible=false → 仍弹窗，展示降级文案
 *  - 弹窗复用 sales-landing 的深色风格（套 .sales-root scope）
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { MessageCircle, Phone, Copy, QrCode } from 'lucide-react'
import { message } from 'antd'
import { nodeApi } from '../api/client'

type Profile = {
  salesCode: string
  realName: string
  positionTitle: string | null
  companyName: string | null
  avatar: string | null
  contactVisible: boolean
  contact: { wechat: string | null; phone: string | null; qrcode: string | null }
}

type Ctx = {
  openContact: (salesCode: string | null) => void
}

const ContactSalesCtx = createContext<Ctx | null>(null)

export function useContactSales(): Ctx {
  const v = useContext(ContactSalesCtx)
  if (!v) throw new Error('useContactSales 必须在 ContactSalesProvider 内使用')
  return v
}

export function ContactSalesProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)

  const openContact = useCallback((salesCode: string | null) => {
    if (!salesCode) {
      message.info('请通过销售分享的链接联系对应顾问')
      return
    }
    setOpen(true)
    setProfile(null)
    setLoading(true)
    nodeApi.get(`/api/public/sales/${encodeURIComponent(salesCode)}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => setProfile(res))
      .catch(() => setProfile(null))
      .finally(() => setLoading(false))
  }, [])

  const displayName = profile?.realName || '标准小智顾问'
  const positionTitle = profile?.positionTitle || '标准智能平台顾问'
  const hasContact = profile?.contactVisible && (
    profile?.contact?.wechat || profile?.contact?.phone || profile?.contact?.qrcode
  )

  return (
    <ContactSalesCtx.Provider value={{ openContact }}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sales-root backdrop-blur-xl bg-slate-900/95 border border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center text-lg">联系销售</DialogTitle>
            <DialogDescription className="text-center text-slate-400 text-sm">
              获取专属服务支持
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="text-center text-slate-400 text-sm py-8">加载中…</div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-4">
              <Avatar className="size-20 ring-2 ring-blue-400/30">
                {profile?.avatar && <AvatarImage src={profile.avatar} alt={displayName} />}
                <AvatarFallback className="bg-gradient-to-br from-blue-500 to-cyan-500 text-white text-xl">
                  {displayName.charAt(0)}
                </AvatarFallback>
              </Avatar>
              <div className="text-center">
                <div className="text-white text-lg mb-1">{displayName}</div>
                <div className="text-slate-400 text-sm">{positionTitle}</div>
                {profile?.companyName && (
                  <div className="text-slate-400 text-xs">{profile.companyName}</div>
                )}
              </div>

              {hasContact ? (
                <div className="w-full space-y-3">
                  {profile.contact.phone && (
                    <div className="backdrop-blur-xl bg-white/5 border border-white/10 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Phone className="size-4 text-blue-400" />
                          <span className="text-sm text-slate-300">手机号</span>
                        </div>
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => {
                            navigator.clipboard.writeText(profile.contact.phone!)
                            message.success('已复制手机号')
                          }}
                          className="h-7 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                        >
                          <Copy className="size-3 mr-1" /> 复制
                        </Button>
                      </div>
                      <div className="text-white">{profile.contact.phone}</div>
                    </div>
                  )}
                  {profile.contact.wechat && (
                    <div className="backdrop-blur-xl bg-white/5 border border-white/10 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <MessageCircle className="size-4 text-green-400" />
                          <span className="text-sm text-slate-300">微信号</span>
                        </div>
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => {
                            navigator.clipboard.writeText(profile.contact.wechat!)
                            message.success('已复制微信号')
                          }}
                          className="h-7 text-xs text-green-400 hover:text-green-300 hover:bg-green-500/10"
                        >
                          <Copy className="size-3 mr-1" /> 复制
                        </Button>
                      </div>
                      <div className="text-white">{profile.contact.wechat}</div>
                    </div>
                  )}
                  {profile.contact.qrcode && (
                    <div className="backdrop-blur-xl bg-white/5 border border-white/10 rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <QrCode className="size-4 text-slate-400" />
                        <span className="text-sm text-slate-300">微信二维码</span>
                      </div>
                      <div className="bg-white rounded-lg p-4 flex items-center justify-center">
                        <img src={profile.contact.qrcode} alt="微信二维码" className="size-32 object-contain" />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-full text-center py-4 px-4">
                  <div className="text-slate-300 text-sm mb-2">请通过销售分享渠道联系对接人</div>
                  <div className="text-slate-500 text-xs">或提交咨询后，销售将主动与您联系</div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ContactSalesCtx.Provider>
  )
}
