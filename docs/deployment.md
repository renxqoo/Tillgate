# Tillgate 部署指南

两种部署形态，共享同一套镜像产物：

| 形态 | 适用 | 说明 |
| --- | --- | --- |
| 单容器（AIO） | 单机、试用、小规模 | 一条 `docker run`；内置 PostgreSQL / Redis / nginx，数据全部在 `/data` |
| 多容器（compose） | 生产 | 逐应用独立容器，支持滚动升级、单应用更新、高可用（`compose.ha.yml`） |

- [一、单容器部署（AIO）](#一单容器部署aio)
- [二、单容器日常运维](#二单容器日常运维)
- [三、多容器部署（compose）](#三多容器部署compose)
- [四、从单容器迁移到多容器](#四从单容器迁移到多容器)
- [五、可选参数](#五可选参数)

---

## 一、单容器部署（AIO）

### 前置要求

- Linux x86_64，Docker ≥ 24
- 内存 ≥ 3GB（建议 4GB），磁盘 ≥ 10GB
- `443`、`8443` 端口空闲（`80` 可选，仅探活与跳转用）

### 1. 启动

```bash
docker run -d --name tillgate --restart always \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 443:443 -p 8443:8443 -p 80:80 \
  -v "$PWD/data:/data" \
  renxqoo/tillgate:latest
```

- 首启自举：密钥、自签证书、数据库迁移、首个管理员在首次启动时自动完成。
  **首次启动需联网 npm registry 下载依赖**（镜像不含 node_modules；`AIO_NPM_REGISTRY`
  可覆盖源，如 `https://registry.npmmirror.com`）——装好后缓存于 `/data/repo`，
  后续启动离线可用；镜像升级时按载荷哈希自动重装
- 启动顺序：PostgreSQL / Redis 就绪 → 数据库迁移 → 后端服务 → 管理员表为空则创建管理员 → 前端 / nginx
- 全部状态（数据库、Redis、密钥、证书）持久化在 `./data`，删除容器不丢数据

### 2. 首次初始化

```bash
# 查看启动进度（完成后 Ctrl-C 退出，不影响服务）
docker logs -f tillgate

# 获取首个管理员一次性密码（读后删除该文件）
docker exec tillgate cat /data/bootstrap-credentials.txt

# 状态 healthy 即整栈就绪
docker ps
```

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 用户面板 | `https://<服务器IP>/` | 自签证书，浏览器首次手动继续；见下节「信任自签证书」 |
| 管理后台 | `https://<服务器IP>:8443` | 登录后立即在「账号菜单 → 修改密码」更换密码 |
| 推理 API | `https://<服务器IP>/v1/...` | `Authorization: Bearer sk-...` |

管理面安全建议：`-p 127.0.0.1:8443:8443` 只绑定本机，经 `ssh -L 8443:localhost:8443` 隧道访问；或防火墙限源。

### 3. 首次业务配置（管理后台，一次性）

1. **渠道**：填上游供应商 base URL 与 API Key（落库自动加密），勾选要暴露的模型
2. **集成**（按需，`/dashboard/settings`）：SMTP（邮箱验证码 / 2FA）、Turnstile（注册人机验证）、易支付 / Stripe（充值）
3. 保存即生效，模型即刻可被 `/v1` 调用

GitHub / Google OAuth 登录需要域名形态（见「6. 使用域名」）；IP 形态回调白名单不匹配。

### 4. 信任自签证书（可选，推荐）

一次操作，永久消除浏览器告警与客户端 `-k`：

```bash
docker cp tillgate:/data/certs/tillgate.crt .
sudo cp tillgate.crt /usr/local/share/ca-certificates/tillgate.crt
sudo update-ca-certificates
```

浏览器访问需另行将该证书导入系统/浏览器信任Store。信任前 curl 需加 `-k`。

### 5. 调用推理 API

用户在面板注册（有注册赠额）→ API Keys 页创建 `sk-...`：

```bash
curl https://<服务器IP>/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"<配置的模型名>","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

OpenAI SDK 用户只改两处：

```python
from openai import OpenAI

client = OpenAI(base_url="https://<服务器IP>/v1", api_key="sk-xxxxxxxx")
```

### 6. 使用域名（可选）

```bash
docker run -d --name tillgate --restart always \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 443:443 -p 8443:8443 -p 80:80 \
  -e TILLGATE_PUBLIC_URL=https://app.example.com \
  -v "$PWD/data:/data" \
  renxqoo/tillgate:latest
```

- `TILLGATE_PUBLIC_URL` 用于构建 OAuth 回调白名单与自签证书 SAN
- 正式证书：推荐 Cloudflare 等在前置终止 TLS；或将 origin 证书放入 `/data/certs/`，重启后自动替换自签证书

### 7. 外接数据库（可选）

```bash
docker run -d --name tillgate --restart always \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 443:443 -p 8443:8443 -p 80:80 \
  -e DATABASE_URL=postgres://user:pass@db-host:5432/tillgate \
  -e REDIS_URL=redis://:pass@redis-host:6379 \
  -e TILLGATE_PUBLIC_URL=https://app.example.com \
  -v "$PWD/data:/data" \
  renxqoo/tillgate:latest
```

传入后容器不再启动内置 PostgreSQL / Redis；迁移、建管理员、升级语义不变。

---

## 二、单容器日常运维

```bash
# 状态 / 日志
docker ps
docker logs tillgate --tail 100

# 重启（数据不丢）
docker restart tillgate

# 备份（内置数据库形态；外接形态对远端库执行；建议异地留存）
docker exec tillgate pg_dump -U postgres tillgate > backup-$(date +%F).sql

# 管理员密码救援（忘记密码 / 凭据文件已删时）
docker exec tillgate bootstrap-admin --email=admin@example.com --password='新密码'

# 升级（迁移自动执行；全栈重启一次，选低峰）
docker pull renxqoo/tillgate:latest
docker stop tillgate && docker rm tillgate
# 重新执行「1. 启动」的命令
```

- **回滚**：发布只推 `latest` 单一标签（每次发布覆盖，无版本/日期后缀标签），升级前先给本机在用镜像打个本地标记留存：`docker tag renxqoo/tillgate:latest renxqoo/tillgate:backup-$(date +%F)`。回滚 = 用该本机标记重跑启动命令；镜像内载荷哈希与 `/data` 缓存不一致时自动重装对应版本的依赖。注意数据库迁移是前向的，跨 schema 迁移后回滚镜像不回滚表结构
- **密钥语义**：全部密钥持久化于 `/data`；重新启动时若环境变量传入的密钥与存储值不一致，容器告警并拒绝启动（防止意外换 key 导致渠道密文不可解）。换 key 走专门轮换流程（见 [deployment-checklist.md](deployment-checklist.md) §3）
- **数据**：`./data` 内含 PostgreSQL 数据、Redis AOF、密钥、证书；`rm -rf data` 等于清库

---

## 三、多容器部署（compose）

### 前置要求

- Linux x86_64，Docker ≥ 24 及 compose 插件
- `80` / `443` / `8443` 端口空闲：`lsof -nP -iTCP:80 -iTCP:443 -iTCP:8443 -sTCP:LISTEN`

### 1. 安装（两条命令）

```bash
curl -fsSL https://raw.githubusercontent.com/renxqoo/Tillgate/main/docker/install.sh | bash
./tillgate up
```

先审阅再执行（可选）：

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/renxqoo/Tillgate/main/docker/install.sh
less install.sh && bash install.sh
```

install.sh 自动完成：

1. `git clone --depth 1` 公开仓库到当前目录（compose 与 nginx 配置随仓分发）
2. 生成 `.env` 全部密钥（8 个强随机值，`chmod 600`；已存在的键不覆盖）
3. 无域名时生成自签证书
4. `pull` 全部镜像并 `up -d`（迁移、建管理员自动完成）
5. 打印入口地址表与凭据文件位置

### 2. 日常命令

| 命令 | 作用 |
| --- | --- |
| `./tillgate up [服务]` | 启动（可指定单个服务） |
| `./tillgate ps` | 容器状态（`migrate` 显示 `Exited (0)` 属正常） |
| `./tillgate logs <服务> [--tail N]` | 查看日志 |
| `./tillgate creds` | 凭据文件位置与入口地址 |
| `./tillgate upgrade [服务]` | 更新（默认全部；可指定单个服务） |
| `./tillgate down` | 停栈（数据保留） |

`./tillgate` 是标准 docker compose 的薄封装（`.env` 内已写 `COMPOSE_FILE`），所有原生命令如 `docker compose up -d` 同样可用。

数据在 `pg-data` / `redis-data` 具名卷：`down` 不丢数据，`down -v` 会清库。

### 3. 发布更新

日常更新一条命令：`./tillgate upgrade [服务名]`。手动细化流程：

```bash
# 本地构建（或改为 GHCR push/pull）
docker compose build client-api

# 传服务器（自建镜像传输；走 GHCR 则为 push/pull）
docker save tillgate/client-api:local | gzip | ssh <服务器> 'gunzip | docker load'

# 服务器侧更新并生效
docker compose up -d client-api
docker compose exec nginx nginx -s reload
```

`up -d` 后必须 reload nginx：upstream 为静态域名，容器重建可能换 IP，不 reload 会出现「更新了但不通」。

按改动落点确定重建范围：

| 改动落点 | 需要重建的镜像 |
| --- | --- |
| 只在 `apps/<app>/**` | 该服务一个 |
| `packages/*` 共享包 | 依赖它的全部后端 app（如 `packages/billing` 涉及 gateway / client-api / admin-api / worker） |
| `packages/db`（schema 或 migrations） | 受影响 app 之外再加 `migrate`，并重跑迁移（幂等，已应用项跳过） |
| `docker/nginx/*.conf` | 零构建，`restart nginx` 或 `nginx -s reload` 即生效 |
| `.env` | 零构建，`up -d` 自动重建受影响容器 |

### 4. 扩容与高可用

- 多副本（`--scale gateway=2`）当前受 nginx 静态 upstream 限制不会自动分流，属高可用演进项
- 高可用形态（Sentinel、主从、多副本）见 [ha-deployment.md](ha-deployment.md)

---

## 四、从单容器迁移到多容器

```bash
# 1. 单容器侧导出
docker exec tillgate pg_dump -U postgres --no-owner tillgate > full.dump

# 2. 多容器侧只起数据库（不要先起全栈——迁移建表后再恢复会表冲突）
docker compose up -d postgres
docker compose exec -T postgres psql -U postgres -d tillgate < full.dump

# 3. 密钥抄入 .env（install.sh 会跳过已存在的键，不覆盖）

# 4. 启动全栈（迁移幂等跳过）
./tillgate up
```

---

## 五、可选参数

### 单容器（AIO）环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TILLGATE_PUBLIC_URL` | `https://localhost` | 对外根地址；展开为 OAuth 回调白名单（`OAUTH_API_BASE` / `OAUTH_FRONTEND_URL`）与自签证书 SAN。使用域名时必设 |
| `DATABASE_URL` | 内置 PostgreSQL | 传入则使用外部数据库，容器不再启动内置 PG |
| `REDIS_URL` | 内置 Redis | 传入则使用外部 Redis |
| `BOOTSTRAP_ADMIN_EMAIL` | `admin@tillgate.local` | 首次启动（管理员表为空）自动创建的管理员邮箱 |
| `AIO_NPM_REGISTRY` | npm 官方源 | 首启依赖安装源覆盖（如 `https://registry.npmmirror.com`）；缓存命中时不生效 |
| `BOOTSTRAP_ADMIN_ENABLED` | `true` | 设为 `false` 关闭「管理员表为空时自动创建」 |
| `CLIENT_USAGE_TZ` | `Asia/Shanghai` | 用量日汇总日界时区（IANA 名） |
| `NEXT_PUBLIC_DISPLAY_TZ` | `Asia/Shanghai` | 面板展示时区（镜像构建期生效，运行时传入无效） |
| `OTEL_TRACES_MODE` | `otlp` | 链路追踪默认开启（内置接收端自动接线，管理台「链路追踪」页查看）；关闭设 `off` |
| `LOG_LEVEL` | `info` | 日志级别 |

### 多容器（compose）`.env` 键

install.sh 自动生成（勿手改；丢失或泄露按轮换流程处理）：

| 键 | 说明 |
| --- | --- |
| `JWT_SECRET` / `ADMIN_JWT_SECRET` | 用户面 / 管理面会话签名（≥32 随机） |
| `ENCRYPTION_KEY` | 渠道上游 Key 落库加密根键（≥32 随机；丢失 = 渠道密文永久不可解） |
| `IDENTITY_CODE_PEPPER` / `CLIENT_CODE_PEPPER` | 管理面 / 用户面验证码 HMAC pepper（≥16 随机，两值不同） |
| `TRACE_RECEIVER_TOKEN` | 链路接收鉴权 |
| `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | 数据库与 Redis 密码 |

可覆盖键：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `POSTGRES_USER` | `postgres` | 容器 PG 用户 |
| `POSTGRES_DB` | `tillgate` | 库名 |
| `TILLGATE_IMAGE_PREFIX` | `tillgate（本地构建标签）` | 镜像前缀（自建 registry 时替换） |
| `TILLGATE_TAG` | `latest` | 镜像 tag（回滚时改为 `sha-xxxxxx`） |
| `OAUTH_API_BASE` / `OAUTH_FRONTEND_URL` | 由 install.sh 按域名生成 | OAuth 回调白名单；IP 形态为 `https://localhost` |
| `OTEL_TRACES_MODE` | `otlp` | 链路追踪默认开启；关闭设 `off` |
| `CLIENT_USAGE_TZ` | `Asia/Shanghai` | 用量日汇总日界时区 |
| `NEXT_PUBLIC_DISPLAY_TZ` | `Asia/Shanghai` | 面板展示时区（console-client 构建参数） |
| `LOG_LEVEL` | `info` | 日志级别 |

其余运行参数（限流、保留期、注册开关等）见 [configuration.md](configuration.md)；上线检查项见 [deployment-checklist.md](deployment-checklist.md)。

### 端口

| 端口 | 用途 | 必需 |
| --- | --- | --- |
| `443` | 用户面板 + `/v1` 推理 API（TLS） | 是 |
| `8443` | 管理后台（TLS，与用户面物理隔离） | 是 |
| `80` | `/livez` 探活、HTTP→HTTPS 跳转 | 可选 |
