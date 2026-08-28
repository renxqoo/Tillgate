## 1. 从 `.env.example` 新建部署用 `.env`（在仓库根执行）

```bash
cd /Users/w/Desktop/work/Tillgate
cp .env.example .env

# 五把密钥一次性换成强随机值（弱值/空值启动即拒绝）
for k in JWT_SECRET ADMIN_JWT_SECRET ENCRYPTION_KEY IDENTITY_CODE_PEPPER CLIENT_CODE_PEPPER; do
  sed -i.bak -E "s|^#?[[:space:]]?${k}=.*|${k}=$(openssl rand -hex 32)|" .env; done; rm -f .env.bak

# trace 链路接收令牌（compose 插值 :? 必需，不配 compose 直接报错）
sed -i.bak "s|^# TRACE_RECEIVER_TOKEN=.*|TRACE_RECEIVER_TOKEN=$(openssl rand -hex 24)|" .env

# client-api 生产启动必填（OAuth 回调白名单）；本地自签形态用 https://localhost
sed -i.bak "s|^# OAUTH_API_BASE=.*|OAUTH_API_BASE=https://localhost|" .env
sed -i.bak "s|^# OAUTH_FRONTEND_URL=.*|OAUTH_FRONTEND_URL=https://localhost|" .env

# 库与 Redis 密码（compose 用这两个键拼容器内的 DATABASE_URL/REDIS_URL 并建 Redis requirepass）
sed -i.bak "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 16)|" .env
sed -i.bak "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -hex 16)|" .env    # example 默认 root123；原位替换——追加会产生双键，first-match 读取方会拿到弱值

chmod 600 .env && rm -f .env.bak
```

两点说明：

- `.env` 里原有的 `DATABASE_URL`/`REDIS_URL`（localhost 形态）对部署无效——compose 会按服务注入容器网地址，宿主机直跑时由 `.env.local` 接管，所以不用改它们。
- 新 `.env` 默认 `OTEL_TRACES_MODE` 未设（off）。想开链路追踪就再加一行 `OTEL_TRACES_MODE=otlp`，endpoint 由 compose 自动注入内置 `http://trace-receiver:8793`，令牌已配好，无需其它动作。

## 2. 构建全部自建镜像（首次约 10 分钟）

```bash
docker compose --env-file .env -f docker/compose.yml build
```

8 个自建镜像（gateway / client-api / admin-api / worker / trace-receiver / console-client / console-admin / migrate）；nginx/redis/postgres 由 compose 拉取。Intel Mac 原生 `linux/amd64`，无交叉编译。

## 3. 生成本地自签证书（无域名前门）

```bash
mkdir -p docker/nginx/certs-server
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout docker/nginx/certs-server/privkey.pem \
  -out docker/nginx/certs-server/fullchain.pem \
  -days 825 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
chmod 600 docker/nginx/certs-server/privkey.pem
```

## 4. 起数据库并跑一次性迁移

```bash
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml up -d postgres redis
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml up migrate
```

`migrate` 显示 `Exited (0)` 即成功（幂等可重跑）。后续所有命令都要带 `--env-file .env` 和这两个 `-f` 文件。

## 5. 创建首个管理员（不建则管理后台无法登录）

```bash
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml \
  run --rm --workdir /repo migrate \
  bun --conditions=development apps/admin-api/scripts/create-admin.ts \
  --email=admin@tillgate.local --apply
```

不带 `--password` 会打印一次性强密码，注意保存；纯本地想固定密码可加 `--password=admin12345 --apply`。

## 6. 全量启动并验证

```bash
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml up -d
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml ps   # migrate Exited(0) 属正常
curl -s http://localhost/livez        # → {"ok":true}
```

| 入口     | 地址                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 用户面板 | `https://localhost/`（自签证书，浏览器需手动继续；curl 加 `-k`）          |
| 管理后台 | `https://localhost:8443`                                                  |
| 推理 API | `https://localhost/v1/chat/completions`（`Authorization: Bearer sk-...`） |

注意事项不变：栈占宿主机 80/443/8443，启动前用 `lsof -nP -iTCP:80 -iTCP:443 -iTCP:8443 -sTCP:LISTEN` 确认无占用；nginx 要等全部服务 healthy 才起，整栈约一两分钟；数据在 `pg-data`/`redis-data` 卷里，`down` 不丢数据但 `down -v` 会清库。

## 7. 增量发布：只更新一个应用（以 client-api 为例）

首次部署后的日常升级。先 `git diff --name-only` 核对改动落点，确定重建范围：

| 改动落点                              | 需要重建的镜像                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只在 `apps/<app>/**`                  | 该服务一个                                                                                                                                            |
| `packages/*` 共享包                   | 依赖它的全部后端 app——服务端镜像为全量 bundle，workspace 源码直接进 dist（改 `packages/billing` 涉及 gateway / client-api / admin-api / worker 四个） |
| `packages/db`（schema 或 migrations） | 受影响 app 之外再加 `migrate`，并重跑 `up migrate`（幂等，已应用项跳过）                                                                              |
| 只有 `docker/nginx/*.conf`            | 零构建——配置为 bind mount，`restart nginx` 或 `nginx -s reload` 即生效                                                                                |
| 只有 `.env`                           | 零构建——`up -d` 按配置差异自动重建受影响容器（env_file 全服务共享，可能不止一个）                                                                     |

三步发布（build 只用基线 compose.yml——`compose.server.yml` 把 `build:` 重置为 null）：

```bash
# 本地构建：未动 package.json/bun.lock/patches 时 install 层命中缓存，只重跑 bundle
docker compose --env-file .env -f docker/compose.yml build client-api

# 传服务器（同名 tag；走 ACR 则改为 push/pull）
docker save tillgate/client-api:local | gzip | ssh <服务器> 'gunzip | docker load'

# 服务器侧：同名 tag 下 compose 比对镜像 ID，只重建这一个容器（依赖仅校验健康，不重启）
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml up -d client-api
```

同时更新多个服务：三步里的服务名并列即可，`docker save` 一条流打包多个镜像，nginx reload 一次覆盖全部：

```bash
docker compose --env-file .env -f docker/compose.yml build client-api admin-api
docker save tillgate/client-api:local tillgate/admin-api:local | gzip | ssh <服务器> 'gunzip | docker load'
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml up -d client-api admin-api
```

共享包改动导致全部自建镜像都要换时，`up -d` 不带服务名即可——compose 只重建镜像 ID 或配置变了的容器，postgres/redis 等未变镜像不会被动到。

`up -d` 后必做 nginx reload：upstream 是静态域名（`server client-api:8081;` 形式），nginx 只在启动/reload 时解析一次；容器重建可能换 IP，不 reload 会继续打到旧 IP，表现为「更新了但不通」：

```bash
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml exec nginx nginx -s reload
```

验证（后端端口未发布到宿主机，站内探活用 exec；`ps` 的 STATUS 转 healthy 即可）：

```bash
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml ps client-api
docker compose --env-file .env -f docker/compose.yml -f docker/compose.server.yml exec client-api wget -qO- http://localhost:8081/healthz
curl -s http://localhost/livez   # 经 nginx 的整体探活
```

前端 console-client / console-admin 各自独立 Dockerfile，同样按服务名单独 build/up，流程相同。
