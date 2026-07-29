/**
 * 构建信息 — deploy 脚本用来验证 canary 是新版本而不是旧容器
 *
 * 值通过 Docker build-arg 注入（Dockerfile.prod 的 ARG + ENV）：
 *   docker buildx build --build-arg BUILD_COMMIT=$(git rev-parse --short HEAD) \
 *                       --build-arg BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) ...
 *
 * 本地 tsx 开发时没这些 env，fallback 到 'dev' / 进程启动时间。
 */

export const SERVICE_NAME = 'bxz-api'

export const BUILD_COMMIT = process.env.BUILD_COMMIT || 'dev'

export const BUILT_AT = process.env.BUILT_AT || new Date().toISOString()

/** 进程启动时间（UTC ISO），用于区分新旧容器实例 */
export const STARTED_AT = new Date().toISOString()

/** /health 返回体（稳定 schema，deploy 脚本会校验 commit 字段） */
export function healthPayload() {
  return {
    ok: true,
    service: SERVICE_NAME,
    commit: BUILD_COMMIT,
    builtAt: BUILT_AT,
    startedAt: STARTED_AT,
    pid: process.pid,
  }
}
