#!/bin/sh
# Tillgate AIO 单容器入口——单容器内拉起全栈（PostgreSQL / Redis / 5 个后端服务 /
# 两个 Next.js 控制台 / nginx）并监督。行为规格以 docs/deployment.md「单容器部署（AIO）」为准。
#
# 契约与不变量：
#   - 全部状态在 /data：pgdata/、redis/、certs/、secrets.env、bootstrap-credentials.txt；
#     删除容器不丢数据，rm -rf /data 等于清库。
#   - 8 个密钥首启生成并持久化到 /data/secrets.env（600）；env 传入与存量不一致
#     → 告警拒绝启动——ENCRYPTION_KEY 换值 = 渠道密文永久不可解，宁可拒启不可静默换 key。
#   - 传入 DATABASE_URL / REDIS_URL = 外接形态（不启动内置 PG / Redis，库需自备且已存在）；
#     内置形态密码为 openssl 生成的 hex（URL 安全）；自备 POSTGRES_PASSWORD / REDIS_PASSWORD
#     含特殊字符时由调用方自行保证 URL 编码。
#   - 证书：/data/certs/tillgate.crt + tillgate.key 存在即用（origin 证书替换自签），
#     否则按 TILLGATE_PUBLIC_URL 的 host 生成自签（825 天；SAN 含该 host 与 localhost）。
#   - 启动顺序：基础设施就绪 → 依赖就绪（首启联网 bun install，缓存 /data/repo；
#     镜像载荷哈希不变即秒过）→ provision-fresh + drizzle 迁移（均幂等）→ 首个管理员
#     （create-admin 同邮箱幂等跳过；真实创建时一次性密码写入 /data/bootstrap-credentials.txt）
#     → 后端 5 服务 → 两个控制台 → nginx 最后。
#   - 依赖下载：镜像不含 node_modules（用户裁决 2026-08-29）——首次启动需能访问 npm
#     registry（AIO_NPM_REGISTRY 可覆盖源）；装好后缓存于 /data，后续启动离线可用。
#   - 监督：任一关键子进程退出 → 全栈按序收停并以非零码退出，交给
#     docker --restart always 整容器重启（不做容器内单进程重生）。
#   - OAUTH_API_BASE / OAUTH_FRONTEND_URL 由 TILLGATE_PUBLIC_URL 展开（缺省 https://localhost）。
set -eu

DATA=/data
SECRETS_FILE=$DATA/secrets.env
PAYLOAD=/opt/tillgate/repo
REPO=$DATA/repo

log() { echo "[aio] $*"; }

# ── 1. 密钥管理：生成 / 加载 / 不一致拒启 ──────────────────────────────
# 各键随机长度（hex 字节数）：JWT/ENCRYPTION ≥32；pepper ≥16；token 与内置中间件密码 24。
mkdir -p "$DATA"
touch "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

secret_bits() {
  case "$1" in
    IDENTITY_CODE_PEPPER | CLIENT_CODE_PEPPER) echo 16 ;;
    JWT_SECRET | ADMIN_JWT_SECRET | ENCRYPTION_KEY) echo 32 ;;
    *) echo 24 ;;
  esac
}

for key in JWT_SECRET ADMIN_JWT_SECRET ENCRYPTION_KEY IDENTITY_CODE_PEPPER CLIENT_CODE_PEPPER \
  POSTGRES_PASSWORD REDIS_PASSWORD TRACE_RECEIVER_TOKEN; do
  stored=$(sed -n "s/^${key}=//p" "$SECRETS_FILE" | tail -n 1)
  incoming=$(eval "printf '%s' \"\${${key}:-}\"")
  if [ -n "$stored" ] && [ -n "$incoming" ] && [ "$stored" != "$incoming" ]; then
    echo "[aio] refusing to start: ${key} differs from the value persisted in ${SECRETS_FILE}" >&2
    echo "[aio] key rotation requires the documented procedure — see docs/deployment.md" >&2
    exit 1
  fi
  if [ -n "$incoming" ]; then
    value=$incoming
  elif [ -n "$stored" ]; then
    value=$stored
  else
    value=$(openssl rand -hex "$(secret_bits "$key")")
    printf '%s=%s\n' "$key" "$value" >>"$SECRETS_FILE"
  fi
  export "$key=$value"
done
chmod 600 "$SECRETS_FILE"

# ── 2. 公共运行环境 ──────────────────────────────────────────────────
export NODE_ENV=production
TILLGATE_PUBLIC_URL=${TILLGATE_PUBLIC_URL:-https://localhost}
export TILLGATE_PUBLIC_URL
export OAUTH_API_BASE="${OAUTH_API_BASE:-$TILLGATE_PUBLIC_URL}"
export OAUTH_FRONTEND_URL="${OAUTH_FRONTEND_URL:-$TILLGATE_PUBLIC_URL}"
export CLIENT_USAGE_TZ="${CLIENT_USAGE_TZ:-Asia/Shanghai}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
# 全部服务都在本容器 nginx 之后
export TRUSTED_PROXY_HOPS=1
if [ "${OTEL_TRACES_MODE:-off}" = otlp ]; then
  # 内置 trace-receiver 自动接线（8793）
  export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:8793}"
fi

INTERNAL_DB=0
INTERNAL_REDIS=0
[ -z "${DATABASE_URL:-}" ] && INTERNAL_DB=1
[ -z "${REDIS_URL:-}" ] && INTERNAL_REDIS=1
if [ "$INTERNAL_DB" = 1 ]; then
  export DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5432/tillgate"
fi
if [ "$INTERNAL_REDIS" = 1 ]; then
  export REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:6379"
fi

# ── 3. TLS 证书：存量即用，缺失自签 ──────────────────────────────────
mkdir -p "$DATA/certs"
if [ ! -f "$DATA/certs/tillgate.crt" ] || [ ! -f "$DATA/certs/tillgate.key" ]; then
  cert_host=$(printf '%s' "$TILLGATE_PUBLIC_URL" | sed -E 's|^[a-zA-Z]+://||; s|/.*$||; s|:.*$||')
  case "$cert_host" in
    *[!0-9.]*) san_extra="DNS:${cert_host}" ;;
    '') san_extra='' ;;
    *) san_extra="IP:${cert_host}" ;;
  esac
  sans="DNS:localhost,IP:127.0.0.1"
  if [ -n "$san_extra" ] && [ "$san_extra" != DNS:localhost ]; then
    sans="${sans},${san_extra}"
  fi
  log "generating self-signed certificate (SAN: ${sans})"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$DATA/certs/tillgate.key" -out "$DATA/certs/tillgate.crt" \
    -days 825 -nodes -subj "/CN=${cert_host:-localhost}" -addext "subjectAltName=${sans}" >/dev/null 2>&1
  chmod 600 "$DATA/certs/tillgate.key"
fi

ALL_PIDS=""
reg_child() { ALL_PIDS="$ALL_PIDS $1"; }

# ── 4. 内置基础设施（外接形态跳过）───────────────────────────────────
PG_PID=''
if [ "$INTERNAL_DB" = 1 ]; then
  # PG unix 套接字目录（Alpine 包在自定义镜像里不会自动创建；属主须为 postgres）
  mkdir -p /run/postgresql
  chown postgres:postgres /run/postgresql
  mkdir -p "$DATA/pgdata"
  chown postgres:postgres "$DATA/pgdata"
  chmod 700 "$DATA/pgdata"
  if [ ! -s "$DATA/pgdata/PG_VERSION" ]; then
    log "initializing built-in postgresql (data: $DATA/pgdata)"
    # pwfile 须 postgres 用户可读：放 /data 并 chown（mktemp 的 /tmp 文件属 root，
    # initdb 以 postgres 身份运行会 Permission denied）
    pwfile=$DATA/.pgpwfile
    printf '%s\n' "$POSTGRES_PASSWORD" >"$pwfile"
    chown postgres:postgres "$pwfile"
    chmod 600 "$pwfile"
    su-exec postgres initdb -D "$DATA/pgdata" -U postgres -A scram-sha-256 --pwfile="$pwfile" >/dev/null
    rm -f "$pwfile"
  fi
  # 监听仅回环——对外唯一入口是 nginx
  grep -q '^listen_addresses' "$DATA/pgdata/postgresql.conf" ||
    printf "listen_addresses = '127.0.0.1'\n" >>"$DATA/pgdata/postgresql.conf"
  (exec su-exec postgres postgres -D "$DATA/pgdata") &
  PG_PID=$!
  reg_child "$PG_PID"
  i=0
  until pg_isready -h 127.0.0.1 -p 5432 -q; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      echo '[aio] postgres not ready within 60s' >&2
      exit 1
    fi
    sleep 1
  done
  if ! PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='tillgate'" | grep -q 1; then
    PGPASSWORD="$POSTGRES_PASSWORD" createdb -h 127.0.0.1 -U postgres tillgate
  fi
fi

if [ "$INTERNAL_REDIS" = 1 ]; then
  mkdir -p "$DATA/redis"
  chown redis:redis "$DATA/redis"
  (exec su-exec redis redis-server --bind 127.0.0.1 --port 6379 \
    --appendonly yes --dir "$DATA/redis" --requirepass "$REDIS_PASSWORD") &
  REDIS_PID=$!
  reg_child "$REDIS_PID"
  i=0
  until redis-cli --no-auth-warning -a "$REDIS_PASSWORD" -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; do
    i=$((i + 1))
    if [ "$i" -gt 30 ]; then
      echo '[aio] redis not ready within 30s' >&2
      exit 1
    fi
    sleep 1
  done
fi

# ── 4.5 依赖就绪（用户裁决：node_modules 不进镜像，首启下载入 /data）──
# 镜像载荷（只含清单+锁+源码）在构建期带整体哈希标记；工作副本在 /data/repo——
# 哈希一致且 node_modules 在场 = 秒级跳过（正常重启路径），镜像升级（哈希变化）
# = 重新播种 + 重装（依赖树与锁文件版本恒一致）。AIO_NPM_REGISTRY 可覆盖安装源。
PAYLOAD_HASH=$(cat "$PAYLOAD/.payload-hash" 2>/dev/null || echo missing)
WORK_HASH=$(cat "$REPO/.payload-hash" 2>/dev/null || echo absent)
if [ "$PAYLOAD_HASH" != "$WORK_HASH" ]; then
  log "payload changed — reseeding repo working copy into $REPO"
  rm -rf "$REPO"
  cp -a "$PAYLOAD" "$REPO"
fi
if [ ! -d "$REPO/node_modules" ]; then
  if [ -n "${AIO_NPM_REGISTRY:-}" ]; then
    printf '[install]\nregistry = "%s"\n' "$AIO_NPM_REGISTRY" >"$REPO/bunfig.toml"
  fi
  log "installing dependencies (first boot downloads from npm; cached in $DATA/repo)"
  (cd "$REPO" && exec bun install --frozen-lockfile) || {
    echo '[aio] bun install failed — check network / AIO_NPM_REGISTRY; restart policy will retry' >&2
    exit 1
  }
  log "dependencies installed"
else
  log "dependencies cached (payload hash unchanged)"
fi

# ── 5. 迁移（幂等：provision-fresh 前置 DDL + journal 全量）────────────
log "running database provisioning + migrations"
(cd "$REPO/packages/db" && exec bun --conditions=development scripts/provision-fresh.ts)
(cd "$REPO/packages/db" && exec bun node_modules/.bin/drizzle-kit migrate)

# ── 6. 首个管理员（幂等；一次性密码落 /data/bootstrap-credentials.txt）──
if [ "${BOOTSTRAP_ADMIN_ENABLED:-true}" != false ]; then
  bootstrap_email=${BOOTSTRAP_ADMIN_EMAIL:-admin@tillgate.local}
  log "ensuring bootstrap admin (${bootstrap_email})"
  out=$(cd "$REPO" && bun --conditions=development apps/admin-api/scripts/create-admin.ts \
    --email="$bootstrap_email" --apply 2>&1) || {
    printf '%s\n' "$out" >&2
    exit 1
  }
  printf '%s\n' "$out"
  if printf '%s\n' "$out" | grep -q '^created admin'; then
    onetime=$(printf '%s\n' "$out" | sed -n 's/^one-time password (save now, will not be shown again): //p')
    admin_url=$(printf '%s' "$TILLGATE_PUBLIC_URL" | sed -E 's|^(https?://[^/]+).*|\1:8443|')
    {
      echo 'Tillgate AIO bootstrap credentials (read once, then delete this file)'
      echo "admin email:       $bootstrap_email"
      echo "one-time password: $onetime"
      echo "admin console:     $admin_url"
    } >"$DATA/bootstrap-credentials.txt"
    chmod 600 "$DATA/bootstrap-credentials.txt"
    log "bootstrap admin created — credentials in $DATA/bootstrap-credentials.txt"
  fi
fi

# ── 7. 后端服务（自包含 bundle，零 node_modules）──────────────────────
for app in gateway client-api admin-api worker trace-receiver; do
  log "starting $app"
  (cd "/app/server/$app" && exec bun index.js) &
  reg_child $!
done

# ── 8. 控制台（Next standalone；PORT/HOSTNAME 按进程注入）───────────────
log "starting console-client"
(cd /app/console-client && exec env PORT=3001 HOSTNAME=0.0.0.0 bun apps/client/server.js) &
reg_child $!
log "starting console-admin"
(cd /app/console-admin && exec env PORT=3002 HOSTNAME=0.0.0.0 bun apps/admin/server.js) &
reg_child $!

# ── 9. nginx（最后启动：入口 80/443/8443）────────────────────────────
log "starting nginx"
(exec nginx -g 'daemon off;' -c /app/nginx/aio.conf) &
reg_child $!

# ── 10. 监督循环 + 优雅停机 ──────────────────────────────────────────
# 参数 = 容器退出码：信号触发的正常收停为 0；子进程意外死亡为 1（restart 策略与
# docker ps 状态如实反映失败，不伪装成正常退出）。
shutdown() {
  code=${1:-0}
  trap - TERM INT
  log "shutting down stack"
  for pid in $ALL_PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # postgres 对 SIGINT 语义 = fast shutdown（断连回滚，不等客户端）
  if [ -n "$PG_PID" ]; then
    kill -INT "$PG_PID" 2>/dev/null || true
  fi
  i=0
  while [ "$i" -lt 25 ]; do
    alive=0
    for pid in $ALL_PIDS; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    if [ "$alive" = 0 ]; then break; fi
    sleep 1
    i=$((i + 1))
  done
  for pid in $ALL_PIDS; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  exit "$code"
}
trap 'shutdown 0' TERM INT

log "stack is up (public url: $TILLGATE_PUBLIC_URL)"
while :; do
  for pid in $ALL_PIDS; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[aio] child pid=$pid exited unexpectedly — shutting down stack (restart policy will recover)" >&2
      shutdown 1
    fi
  done
  sleep 2
done
