#!/bin/bash
# ============================================================================
# POC 8083 nginx server block 部署脚本（Stage 1）
# ============================================================================
# 目的：在 154.8.197.13 新建 8083 POC 入口，**8082 完全不动**
# 流程：本地审 → scp → 服务器执行 deploy → nginx -t（脚本不 reload）
#       → 用户跑 verify → 通过后用户手工 nginx -s reload
# 范围：仅 Stage 1 — 新建 8083；废弃 8082 是 Stage 2，不在本脚本
# ----------------------------------------------------------------------------
# 子命令：
#   deploy    写 htpasswd / banner / server block，开 8083 firewall，nginx -t（不 reload）
#   verify    跑回归探针：443 仍活 / 8082 仍活 / 8083 无 auth 401 / 8083 带 auth 200
#   rollback  撤销本脚本 deploy 内容（删 conf/htpasswd/banner + 关 8083 firewall）
# ============================================================================
set -euo pipefail

# ─── 常量 ──────────────────────────────────────────────────────────────────
POC_PORT=8083
BACKEND_PORT=3010

# 宝塔环境：nginx vhost 由 /www/server/panel/vhost/nginx/*.conf 自动加载
NGINX_VHOST_DIR="/www/server/panel/vhost/nginx"
POC_CONF="${NGINX_VHOST_DIR}/biaozhunxiaozhi-poc-8083.conf"

# 资源集中目录（htpasswd / banner 副本 / 日志路径配置）
POC_RES_DIR="/opt/biaozhunxiaozhi/conf/poc-8083"
POC_HTPASSWD="${POC_RES_DIR}/htpasswd"
POC_BANNER_FILE="${POC_RES_DIR}/banner.html"

# 静态前端 root（POC web-dist 后续部署进来；Stage 1 仅放占位 index.html）
POC_WEB_ROOT="/opt/biaozhunxiaozhi-poc/web-dist"

POC_USER="poc"

# Banner inline HTML —— 同时写入 banner.html（审计副本）和 nginx sub_filter
# 特意只用双引号（外层 nginx 字符串用单引号），避免 escape 地狱
BANNER_HTML='<div id="poc-banner" style="position:fixed;top:0;left:0;right:0;background:#ff9800;color:#000;padding:8px;text-align:center;font-weight:bold;z-index:99999;font-family:-apple-system,system-ui,sans-serif;font-size:13px;line-height:1.4;">⚠️ POC 测试环境（端口 8083）— 数据隔离，禁止真实业务使用</div>'

# ─── 工具 ──────────────────────────────────────────────────────────────────
usage() {
    cat <<USAGE
用法：sudo bash $(basename "$0") <subcommand>

  deploy     部署 8083 POC（写 conf + htpasswd + banner + firewall + nginx -t）
  verify     跑回归探针（443 / 8082 仍活 / 8083 401→200）
  rollback   撤销 deploy（删 conf/htpasswd/banner，关 8083 firewall）

注意：本脚本不会 nginx -s reload，nginx -t 通过后由用户手动 reload。
注意：8082 server block 完全不动，Stage 2 才处理。
USAGE
    exit 1
}

require_root() {
    [ "$(id -u)" -eq 0 ] || { echo "❌ 需 root（sudo）"; exit 1; }
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || { echo "❌ 缺少命令：$1"; exit 1; }
}

# 用哪种防火墙工具（firewalld / ufw / iptables / 都没有）
detect_firewall() {
    if systemctl is-active --quiet firewalld 2>/dev/null; then
        echo firewalld
    elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
        echo ufw
    elif command -v iptables >/dev/null 2>&1; then
        echo iptables
    else
        echo none
    fi
}

# ─── deploy ─────────────────────────────────────────────────────────────────
cmd_deploy() {
    require_root
    require_cmd nginx
    require_cmd htpasswd
    require_cmd openssl

    # 幂等检查：已存在 → 拒绝（避免覆盖运行中的 POC，先 rollback）
    if [ -f "$POC_CONF" ]; then
        echo "⚠️  ${POC_CONF} 已存在 — 请先：sudo bash $(basename "$0") rollback"
        exit 1
    fi

    # 端口占用检查（避免 8083 被别的进程占了再起 nginx 报错）
    if ss -lntp 2>/dev/null | grep -q ":${POC_PORT}\s"; then
        echo "⚠️  端口 ${POC_PORT} 已被占用，请先排查："
        ss -lntp | grep ":${POC_PORT}\s"
        exit 1
    fi

    mkdir -p "$POC_RES_DIR"
    # 755 而非 750：nginx worker 跑 'www' 用户，需要 +x 才能 traverse 进目录读 htpasswd
    chmod 755 "$POC_RES_DIR"
    mkdir -p "$POC_WEB_ROOT"
    # 显式 755：root umask=077 时 mkdir 默认 700，nginx www 进不去 → static 全 500
    # POC_WEB_ROOT 父链所有目录都得 755，否则 traverse 失败
    chmod 755 "$POC_WEB_ROOT"
    chmod 755 "$(dirname "$POC_WEB_ROOT")"

    # ─── 密码：openssl rand 现场生成，显示一次后 unset ────────────────────
    POC_PASS="$(openssl rand -base64 18 | tr -d '+/=' | cut -c1-20)"
    echo ""
    echo "================================================================"
    echo "  POC 8083 凭据 — 仅显示一次！立刻保存到 1Password"
    echo "  访问：    http://<server-ip>:${POC_PORT}/  （会弹 Basic Auth）"
    echo "  username: ${POC_USER}"
    echo "  password: ${POC_PASS}"
    echo "================================================================"
    echo ""
    read -p "已保存？按 Enter 继续部署（继续后内存中明文密码立刻清除）: " _

    # 写 htpasswd（hash 落盘，明文不写入任何文件 / 日志）
    # -m = APR1-MD5（不是 -B BCrypt）：nginx 1.20.2 在 CentOS 7 默认 glibc 下
    # crypt_r() 不支持 BCrypt $2y$ 哈希，会 EINVAL 让 401 永远拒绝。
    # APR1 在 nginx 全版本兼容；POC pre-prod 场景 APR1 抵抗强度足够（叠 IP 白名单/firewall 入口控制）
    htpasswd -mbc "$POC_HTPASSWD" "$POC_USER" "$POC_PASS"
    # 644 而非 640：www 不在 root 组，需要 world-readable
    chmod 644 "$POC_HTPASSWD"
    chown root:root "$POC_HTPASSWD"

    # 立即 unset 内存里的明文
    POC_PASS=""
    unset POC_PASS

    # ─── banner 副本（审计用 + 与 sub_filter 内容保持一致）────────────────
    echo "$BANNER_HTML" > "$POC_BANNER_FILE"
    chmod 644 "$POC_BANNER_FILE"

    # ─── web-dist 占位 index.html（POC 真前端部署后会被覆盖）──────────────
    if [ ! -f "${POC_WEB_ROOT}/index.html" ]; then
        cat > "${POC_WEB_ROOT}/index.html" <<'IDX'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>POC 8083 — Stage 1 占位</title>
</head>
<body>
  <h1>POC 8083 Stage 1 占位页</h1>
  <p>web-dist 待部署。后端 API 走 <code>/api/*</code> 反代到 ${BACKEND_PORT}。</p>
</body>
</html>
IDX
    fi

    # ─── nginx server block ──────────────────────────────────────────────
    cat > "$POC_CONF" <<NGINX
# POC 8083 server block — Stage 1（不动 8082）
# 创建时间：$(date '+%Y-%m-%d %H:%M:%S %Z')
# 资源目录：${POC_RES_DIR}
# Rollback：sudo bash poc-8083-stage1.sh rollback

server {
    listen ${POC_PORT};
    server_name _;

    # Basic Auth：所有路径都需要凭据
    auth_basic           "POC 8083 Restricted";
    auth_basic_user_file ${POC_HTPASSWD};

    # 独立日志（与生产 access.log / error.log 物理隔离，方便排障）
    # 路径与 prod 8082 (/www/wwwlogs/bxz-access.log) 宝塔约定一致
    access_log /www/wwwlogs/bxz-preprod-8083.access.log;
    error_log  /www/wwwlogs/bxz-preprod-8083.error.log warn;

    # POC banner：在 </head> 前注入，body 顶留 36px padding 不被遮挡
    # 注：默认 sub_filter_types 已含 text/html；显式声明会触发 nginx warn duplicate MIME
    sub_filter_once on;
    sub_filter '</head>' '<style>body{padding-top:36px !important;}</style>${BANNER_HTML}</head>';

    # /api/ → POC 后端 ${BACKEND_PORT}
    location /api/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;

        # API 不返回 HTML，关掉 sub_filter 避免 content-length 重写抖动
        sub_filter_types "";
    }

    # /health 探针直通后端（脚本 verify 用）
    location = /health {
        proxy_pass http://127.0.0.1:${BACKEND_PORT}/health;
        proxy_set_header Host \$host;
        sub_filter_types "";
        access_log off;
    }

    # 静态前端
    location / {
        root  ${POC_WEB_ROOT};
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX

    chmod 644 "$POC_CONF"

    # ─── 防火墙：只开 8083，不动 8082 ────────────────────────────────────
    fw=$(detect_firewall)
    case "$fw" in
        firewalld)
            firewall-cmd --permanent --add-port=${POC_PORT}/tcp >/dev/null
            firewall-cmd --reload >/dev/null
            echo "firewalld：${POC_PORT}/tcp 已开（8082 未触碰）"
            ;;
        ufw)
            ufw allow ${POC_PORT}/tcp comment "poc 8083 stage1" >/dev/null
            echo "ufw：${POC_PORT}/tcp 已开（8082 未触碰）"
            ;;
        iptables)
            # 幂等：先删后加
            iptables -D INPUT -p tcp --dport ${POC_PORT} -j ACCEPT 2>/dev/null || true
            iptables -I INPUT -p tcp --dport ${POC_PORT} -j ACCEPT
            if command -v iptables-save >/dev/null 2>&1 && [ -d /etc/iptables ]; then
                iptables-save > /etc/iptables/rules.v4
                echo "iptables：${POC_PORT}/tcp 已开 + 持久化（8082 未触碰）"
            else
                echo "iptables：${POC_PORT}/tcp 已开（⚠️  请人工确认持久化）"
            fi
            ;;
        none)
            echo "⚠️  未检测到防火墙工具（firewalld/ufw/iptables 都没有）"
            echo "    如服务器有云厂商安全组/WAF，请手动开 ${POC_PORT}/tcp"
            ;;
    esac

    # ─── nginx -t（不 reload）────────────────────────────────────────────
    echo ""
    echo "================================================================"
    echo "执行 nginx -t（不 reload）"
    echo "================================================================"
    nginx -t

    # ─── Baseline 探针（reload 前 prod 健康锚，失败不阻塞 deploy）─────────
    # 目的：建立 "动手前 prod 是好的" 判定锚。reload 后回归若失败，
    #       对比 baseline 能立刻分辨是 reload 伤了 prod，还是 prod 本来就病。
    # 失败兜底：|| echo "000" 防止 set -e 让脚本退出
    echo ""
    echo "================================================================"
    echo "Baseline 探针 — reload 前 prod 健康基线（失败不阻塞 deploy，仅记录）"
    echo "================================================================"
    # baseline 必须用跨分支稳定路由：/health 是 prod 必有路由
    # （/api/app/config 等是 mp-config feat 分支增强，prod main 镜像没有，会误报 404）
    b_api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.biaozhunxiaozhi.com/health || echo "000")
    b_8082=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8082/health || echo "000")
    echo "  baseline.api  = ${b_api}   (期望 200)"
    echo "  baseline.8082 = ${b_8082}  (期望 200)"
    echo "  → reload 后 verify 重打同两个端点，对比能定位 reload 是否伤了 prod"

    echo ""
    echo "================================================================"
    echo "✅ Stage 1 deploy 完成（**未 reload**）"
    echo "================================================================"
    echo "下一步（用户手工执行）："
    echo "  1. 检查 nginx -t → 'syntax is ok' + 'test is successful'"
    echo "  2. 检查 baseline 探针 → api / 8082 应都是 200"
    echo "  3. 用户明确批准 → nginx -s reload"
    echo "  4. reload 完成后跑回归：sudo bash $(basename "$0") verify"
    echo ""
    echo "撤销：sudo bash $(basename "$0") rollback"
    echo "================================================================"
}

# ─── verify ─────────────────────────────────────────────────────────────────
cmd_verify() {
    require_cmd curl

    echo "================================================================"
    echo "回归探针 — 8082 完全不动，验证 443 (www+api) 仍活 / 8082 仍 listening / 8083 401→200"
    echo "================================================================"

    # [1] 443 生产主域名 + API（业务可用判定锚 = api.biaozhunxiaozhi.com/health）
    echo ""
    echo "[1/5] 443 生产主域名 + API"
    code1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://www.biaozhunxiaozhi.com/ || echo "000")
    code2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.biaozhunxiaozhi.com/health || echo "000")
    if [[ "$code1" =~ ^(200|301|302|307|308)$ ]] && [ "$code2" = "200" ]; then
        echo "  ✅ www=${code1} api=${code2}"
    else
        echo "  ❌ www=${code1} api=${code2} —— 生产可能受影响，立刻检查"
    fi

    # [2] 8082
    echo ""
    echo "[2/5] 8082（已存在 server block 仍在 listen，本轮完全不动）"
    # grep -E + [[:space:]]：POSIX 兼容；BSD/GNU grep 都识别。原 \s 在某些 grep 下不识别 → 误报
    if ss -lntp 2>/dev/null | grep -qE ':8082[[:space:]]'; then
        echo "  ✅ 8082 socket 在 listen"
    else
        echo "  ⚠️  8082 没在 listen（可能本来就没起；如果之前在跑则异常）"
    fi
    # 真 HTTP 探针：socket listening 不等于反代健康
    # 端点用 /health（跨分支稳定，不依赖 mp-config feat 路由）
    code8082=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8082/health || echo "000")
    if [ "$code8082" = "200" ]; then
        echo "  ✅ 8082 /health=200（反代到 prod bxz-api 正常）"
    else
        echo "  ❌ 8082 /health=${code8082}（反代异常 — 立即检查 prod 是否被新 vhost 影响）"
    fi

    # [3] 8083 无 auth → 401
    echo ""
    echo "[3/5] 8083 无 auth（期望 401）"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8083/health || echo "000")
    case "$code" in
        401) echo "  ✅ HTTP 401（auth 拦截生效）" ;;
        000) echo "  ❌ 连不上 — nginx 未 reload？或 8083 server block 没生效" ;;
        *)   echo "  ❌ 期望 401 实得 ${code}" ;;
    esac

    # [4] 8083 socket
    echo ""
    echo "[4/5] 8083 socket listening"
    if ss -lntp 2>/dev/null | grep -qE ':8083[[:space:]]'; then
        echo "  ✅ 8083 socket 在 listen"
    else
        echo "  ❌ 8083 没在 listen — nginx -s reload 后再试"
    fi

    # [5] 8083 带 auth → 200（手工，需要密码）
    echo ""
    echo "[5/5] 8083 带 auth（期望 200，手工跑，需密码）"
    echo "  curl -u poc:'<password>' -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8083/health"
    echo ""
    echo "  期望 200（前提：${BACKEND_PORT} POC 后端已起）"
    echo "  得 502 → ${BACKEND_PORT} 后端没起 / not listening"
    echo "  得 401 → 密码错"

    echo ""
    echo "================================================================"
    echo "判定：[1] www+api 全绿 + [2] 8082 listening + [3] 401 + [4] 8083 listening  →  Stage 1 框架就位"
    echo "      [5] 自助带 auth 跑，验 ${BACKEND_PORT} 后端联通性"
    echo "================================================================"
}

# ─── rollback ───────────────────────────────────────────────────────────────
cmd_rollback() {
    require_root
    require_cmd nginx

    echo "================================================================"
    echo "Rollback Stage 1 — 仅撤销本脚本 deploy 的内容，8082 完全不碰"
    echo "================================================================"

    [ -f "$POC_CONF" ]         && rm -f "$POC_CONF"         && echo "已删 ${POC_CONF}"           || echo "${POC_CONF} 不存在"
    [ -f "$POC_HTPASSWD" ]     && rm -f "$POC_HTPASSWD"     && echo "已删 ${POC_HTPASSWD}"
    [ -f "$POC_BANNER_FILE" ]  && rm -f "$POC_BANNER_FILE"  && echo "已删 ${POC_BANNER_FILE}"

    # 注意：不删 web-dist 静态目录（可能其他用途留作占位）
    # 注意：不删 ${POC_RES_DIR} 空目录（无害）

    fw=$(detect_firewall)
    case "$fw" in
        firewalld)
            firewall-cmd --permanent --remove-port=${POC_PORT}/tcp 2>/dev/null || true
            firewall-cmd --reload >/dev/null
            echo "firewalld：${POC_PORT}/tcp 已关（8082 未触碰）"
            ;;
        ufw)
            ufw delete allow ${POC_PORT}/tcp 2>/dev/null || true
            echo "ufw：${POC_PORT}/tcp 已关（8082 未触碰）"
            ;;
        iptables)
            iptables -D INPUT -p tcp --dport ${POC_PORT} -j ACCEPT 2>/dev/null || true
            if command -v iptables-save >/dev/null 2>&1 && [ -d /etc/iptables ]; then
                iptables-save > /etc/iptables/rules.v4
            fi
            echo "iptables：${POC_PORT}/tcp 已关"
            ;;
    esac

    echo ""
    echo "执行 nginx -t（不 reload）："
    nginx -t

    echo ""
    echo "✅ Rollback 完成（**未 reload**）"
    echo "用户手工：nginx -s reload  让 8083 server block 真正下线"
    echo "443 / 8082 完全未触碰"
}

# ─── main ───────────────────────────────────────────────────────────────────
[ $# -ge 1 ] || usage
case "${1:-}" in
    deploy)   cmd_deploy ;;
    verify)   cmd_verify ;;
    rollback) cmd_rollback ;;
    -h|--help|help) usage ;;
    *)        echo "未知子命令：$1"; usage ;;
esac
