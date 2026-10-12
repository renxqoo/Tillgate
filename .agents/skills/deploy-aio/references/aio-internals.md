# AIO 容器内部拓扑与验证配方

## 进程与端口（容器内）

| 进程 | 端口（容器内） | 说明 |
| --- | --- | --- |
| nginx | 80 / 443 / 8443 | 唯一对外入口；443 用户面板+`/v1`，8443 管理后台（TLS 独立端口物理隔离） |
| console-client | 3001 | Next standalone，443 → `/` |
| console-admin | 3002 | Next standalone，8443 → BFF |
| gateway | 48080（宿主 127.0.0.1 映射） | 推理 API，443 → `/v1` |
| admin-api | 8082 | 管理 API；console-admin BFF 内调 |
| client-api | 8081 | 用户面 API |
| worker | — | BullMQ 后台 |
| trace-receiver | 8793 | OTLP 接收（OTEL_TRACES_MODE=otlp 时自动接线） |
| postgres | 5432（仅回环） | 内置形态；外接形态不启动 |
| redis | 6379（仅回环） | AOF 持久化到 /data/redis |

验证路径选择：
- **绕过 nginx 直测服务**：`docker exec tillgate sh -c "wget -qO- http://127.0.0.1:<端口>/..."`
  （admin-api=8082；wget 在镜像内可用，curl 不一定在）。
- **走完整入口**：`curl -sk https://<host>:8443/...`（自签要 `-k`）或浏览器。

## 数据目录（/data 卷）

```
/opt/tillgate/data/
├── secrets.env                  # 8 密钥（600）：JWT×2/ENCRYPTION_KEY/pepper×2/PG/Redis/TRACE_TOKEN
├── pgdata/                      # 内置 PG 数据
├── redis/                       # AOF
├── certs/                       # tillgate.crt/key（存量即用；缺失按 PUBLIC_URL 自签 825 天）
├── repo/                        # 载荷工作副本 + node_modules（载荷哈希一致=缓存复用）
└── bootstrap-credentials.txt    # 首管理员一次性密码（读后应删）
```

密钥语义：env 传入与 secrets.env 存量不一致 → **拒绝启动**（ENCRYPTION_KEY
换值 = 渠道密文永久不可解）。轮换走 docs/deployment-checklist.md §3。

## 启动链关键行为（aio-entrypoint）

1. 密钥：缺则生成并追加落盘；`chmod 600`。
2. 载荷哈希：镜像 `/opt/tillgate/repo/.payload-hash` vs `/data/repo/.payload-hash`
   —— 不一致 `rm -rf /data/repo && cp -a` 重播种；`node_modules` 缺失则
   `bun install --frozen-lockfile`（AIO_NPM_REGISTRY 写 bunfig.toml）。
3. 迁移：`packages/db` 下 `scripts/provision-fresh.ts`（前置 DDL，幂等）
   + `bun node_modules/.bin/drizzle-kit migrate`（journal 全量，幂等）。
4. 首管理员：`BOOTSTRAP_ADMIN_ENABLED != false` 且 admins 表为空时 create-admin
   `--apply`；一次性密码写 bootstrap-credentials.txt。**admins 行已存在则跳过
   ——不修复缺失的 identity_credentials/passwords 行**（事故后要手工补，
   见「管理员凭据修复配方」）。
5. 后端 5 服务（自包含 bundle，/app/server/<app>）→ 控制台 2 个 → nginx。
6. 监督循环：任一子进程死 → 全栈收停 exit 1 → restart 策略整容器重启。
   健康检查：`wget http://127.0.0.1/livez`，`--start-period=600s`（依赖安装期不算失败）。

## 数据库验证配方

```bash
PW=$(grep '^POSTGRES_PASSWORD=' /opt/tillgate/data/secrets.env | cut -d= -f2-)
dq() { docker exec tillgate sh -c "PGPASSWORD=$PW psql -U postgres -d tillgate -t -c \"$1\""; }

dq "select count(*) from drizzle.__drizzle_migrations;"        # 迁移全量应用
dq "select id,email,status from admins order by id;"           # 管理员在册
dq "select c.user_id,c.identifier_value,p.user_id is not null as has_password
     from identity_credentials c left join identity_passwords p on p.user_id=c.user_id
     where c.user_id >= 1000000000;"                           # 管理员凭据完整（有码有哈希）
dq "select user_id,confirmed_at is not null from identity_totp;"  # TOTP 绑定状态
```

注意：`docker exec ... psql -c` 的引号经两层 shell（本地 + ssh + 容器 sh）会退化，
复杂 SQL 用 heredoc 落临时脚本再 `docker cp` + `sh /tmp/x.sh` 执行，做完删。

## 管理员凭据修复配方（identity 行丢失时）

适用：admins 行在、identity_credentials/passwords 行被删（0112 事故形态）。
create-admin 幂等跳过不会补，手工补：

1. 哈希生成（本地仓库，与生产同算法）：
   ```bash
   bun -e 'import { hashPassword } from "./packages/identity/src/domain/password.ts";
     console.log(await hashPassword("<新密码>"))'
   ```
   （`@tillgate/identity` 根出口也有 hashPassword；容器内 /data/repo 同代码可用。）
2. 落库（限定该管理员 user_id，不动其他行）：
   ```sql
   insert into identity_credentials (user_id, identifier_kind, identifier_value)
     values (<id>, 'email', '<邮箱>');
   insert into identity_passwords (user_id, password_hash)
     values (<id>, '<上一步哈希>');
   ```
3. API 验证 login 返回 token；提醒用户改密 + 绑 TOTP。

## TOTP 验证配方（浏览器自动化）

- 当前码：`totpAt(base32Decode(<secret>), Math.floor(Date.now()/1000/30)*30000, 30)`。
- 防重放：confirm 消费当前步（last_used_step 单调 CAS）；同窗二次验证用
  `step+1` 的码，或等下一窗。
- 用户「TOTP 登录不了」的排查序：API 直测（容器内 login/totp 端点 + 现算码）
  → 通则是用户 App 密钥与落库密钥不一致（每次 enroll 换钥，旧扫码作废）；
  解决 = 恢复码登录后重绑，或经授权后 `delete from identity_totp where user_id=<id>`
  （连带 `identity_recovery_codes`）恢复单密码登录，让用户重新走绑定。

## bw 浏览器验证速查

```bash
bw s create --url <url> --backend chrome    # 输出 sess-xxxx
bw s snap <sess>                            # 元素 index 表（填表单/click 用）
bw s type <sess> <index> <text>             # 单步输入
bw s batch <sess> '[{"kind":"type","index":"7","text":"x"}]'  # 批量（注意 kind 不是 action）
bw s click <sess> <index>                   # 点击后返回新快照（URL/Headings 判页面态）
bw s look <sess> --out /tmp/x.png           # 截图
bw s errors <sess>                          # console error 列表
bw s close <sess>
```

登录流（管理台）：`/login` 表单 → 提交 → 若绑了 TOTP 出现第二表单 → 填现算码
→ 「验证并登录」→ URL 变 `/dashboard` 即成功。设置页 `/dashboard/settings`
的「绑定验证器」按钮 → 弹窗含二维码+密钥 → 填码确认 → 恢复码弹窗（仅此一次）
→ 按钮变「解绑」。
