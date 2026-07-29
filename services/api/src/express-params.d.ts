/**
 * Express 4 路由的 params 实际上总是 string，
 * 但 @types/express 5.x 把 ParamsDictionary 改成了 string | string[]。
 * 这里覆盖回 Express 4 的真实行为，消除 Prisma where 条件的类型不匹配。
 */
declare global {
  namespace Express {
    interface Request {
      params: Record<string, string>
    }
  }
}

export {}
