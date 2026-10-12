---
name: deploy-aio
description: Tillgate AIO 单容器全流程部署/升级/验证技能：合并 PR → main → 等 CI 四门与 docker-publish 出镜像 → 服务器拉镜像按原参数重建容器（AIO 启动链/迁移/管理员自举）→ 健康与数据库断言 → 浏览器级功能验证（bw）→ 运维收尾（bootstrap 凭据清理、回滚标记）。当用户要求「部署 / 发布 / 升级服务器 / 上线 / 更新生产 / 验证部署」时使用。多容器 compose 形态不在本技能（走 docs/deployment.md §三）。
---

# Tillgate AIO 部署全流程（合并 → 出镜像 → 重建容器 → 验证 → 收尾）

核心信念：**部署不是「容器跑起来了」——迁移真实应用、数据库断言通过、
浏览器走到业务功能、运维残留清理，四件全齐才算部署完成。**

事实来源：本仓库 `docs/deployment.md`、`docker/Dockerfile.aio`、
`docker/aio-entrypoint.sh`、`.github/workflows/{ci,docker-publish}.yml`。
文档与实现冲突时以实现为准并报告差异。

## 0. 先摸清目标形态（30 秒）

SSH 上服务器确认（默认 `ssh root@<host>`，用户给过授权才动）：

```bash
docker ps --filter name=tillgate --format '{{.Names}} {{.Status}} {{.Image}}'
docker inspect tillgate --format '{{json .Config.Env}}'      # 记录 TILLGATE_PUBLIC_URL / AIO_NPM_REGISTRY 等
docker inspect tillgate --format '{{json .HostConfig.PortBindings}} {{json .HostConfig.Binds}} {{.HostConfig.RestartPolicy.Name}}'
ls /opt/tillgate/data/    # secrets.env / pgdata / redis / certs / repo（+可能残留的 bootstrap-credentials.txt）
```

**重建容器必须按 inspect 到的原参数原样复刻**（端口/卷/env/restart）——
AIO 是单容器全栈，参数漂移 = 域名错、证书错或丢数据卷。
当前生产参考值（115.190.199.161）：`-p 443:443 -p 8443:8443 -p 127.0.0.1:48080:80`、
`-v /opt/tillgate/data:/data`、`-e TILLGATE_PUBLIC_URL=https://115.190.199.161`、
`-e AIO_NPM_REGISTRY=https://registry.npmmirror.com`、`--restart always`、镜像 `renxqoo/tillgate:latest`。
（以每次 inspect 实测为准，不背诵本文参考值。）

升级前**必打回滚标记**（发布只推 latest 单标签，无历史版本）：

```bash
docker tag renxqoo/tillgate:latest renxqoo/tillgate:backup-$(date +%F)
```

回滚 = 用本机标记重跑启动命令。注意：迁移是前向的，回滚镜像不回滚表结构。

## 1. 合并与出镜像（本地，gh CLI）

前置：PR 的 agent 审查已通过（见 feature-dev / pr-review-loop 口径），
CI 在 PR 上绿。合并不带 `--auto`（要方括号 merge 必须 PR 上有正文理由）：

```bash
export PATH="/opt/homebrew/bin:$PATH"   # gh 所在
gh pr checks <PR号> --repo renxqoo/Tillgate          # 全绿才合并
gh pr merge <PR号> --repo renxqoo/Tillgate --merge   # 常规 merge（非 squash/rebase）
```

等 main 上两个 workflow 都成功：

```bash
gh run list --repo renxqoo/Tillgate --branch main --limit 5
gh run watch <run-id> --repo renxqoo/Tillgate --exit-status
```

- **CI**（四门 + 覆盖率）：typecheck/lint/build/test。
- **docker-publish**：push main / v* 标签 / 手动触发 → 构建并推
  `renxqoo/tillgate:latest`（amd64，单一标签每次覆盖；PR 阶段不构建）。
  Secrets 缺失会响亮失败——发布不允许静默跳过。

镜像就绪判据：`docker pull` 到的 `.Created` 晚于 merge 时间。

## 2. 服务器升级（重建容器）

```bash
docker pull renxqoo/tillgate:latest                      # 确认 Created 是刚才的
docker stop tillgate && docker rm tillgate
docker run -d --name tillgate <原参数逐项复刻> renxqoo/tillgate:latest
```

### AIO 启动链（读懂日志在等什么）

`aio-entrypoint` 按序：密钥加载（env 与 /data/secrets.env 不一致**拒启**——
防换 key 打不开渠道密文）→ 内置 PG/Redis（外接形态跳过）→ **载荷哈希比对**
（镜像载荷与 /data/repo 哈希不同 = `payload changed — reseeding repo` 重装依赖，
首启联网 npm，可用 AIO_NPM_REGISTRY 换源；一致则秒过）→
`provision-fresh` + `drizzle-kit migrate`（幂等）→ 首管理员自举
（admins 表已有该邮箱则 `skip: admin already exists`，**不修复缺失的 identity 行**）→
后端 5 服务（gateway/client-api/admin-api/worker/trace-receiver）→
两个 Next 控制台（client 3001 / admin 3002）→ nginx 最后 → `stack is up`。

盯日志到就绪：

```bash
for i in $(seq 1 20); do
  docker logs tillgate 2>&1 | grep -q "stack is up" && break; sleep 30
done
docker logs tillgate 2>&1 | grep -E '^\[aio\]' | tail -12
docker ps --filter name=tillgate --format '{{.Status}}'   # healthy
```

坑位记录（本形态实发过）：
- **payload 变更后的首启要 bun install**，走 npmmirror 也可能慢到数分钟——
  失败会 exit 1，`--restart always` 自动整容器重试，等重试走完再判断。
- `docker logs` 的 spinner 会吞错误文本；判定成败看**退出码 + 下一节 DB 断言**，
  不看「没报错」。

## 3. 部署后断言（数据库层——比 UI 更硬的证据）

```bash
PW=$(grep '^POSTGRES_PASSWORD=' /opt/tillgate/data/secrets.env | cut -d= -f2-)
docker exec tillgate sh -c "PGPASSWORD=$PW psql -U postgres -d tillgate -t -c \
  \"select count(*) from drizzle.__drizzle_migrations;\""   # = 迁移文件总数（journal 全量）
docker exec tillgate sh -c "PGPASSWORD=$PW psql -U postgres -d tillgate -t -c \
  \"select count(*) from pg_constraint where contype='f' and conname like 'identity%';\""  # 按本次变更断言
```

断言内容按本次发布携带的迁移定（如 0113 后 identity→users FK 应为 0；
journal 数 = `ls packages/db/migrations/*.sql | wc -l`）。
随后做最小 API 冒烟（容器内直打 admin-api 8082，绕过 nginx）：

```bash
docker exec tillgate sh -c "wget -qO- --header='content-type: application/json' \
  --post-data='{\"email\":\"<admin>\",\"password\":\"<pwd>\"}' \
  http://127.0.0.1:8082/v1/auth/login" | head -c 200       # 期望返回 token
```

涉及管理面登录态的验证走 8443（nginx → console-admin BFF），
不是 8082 直连——浏览器验证那步覆盖。

## 4. 浏览器级验证（bw 工具，真实 Chrome）

只验证「本次改动声称修复/变更的行为」，不巡全站：

```bash
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH"
bw s create --url "https://<host>:8443/<目标路径>" --backend chrome
bw s snap <sess>                      # 读结构：输入框/button 的 index
bw s batch <sess> '[{"kind":"type","index":"<i>","text":"..."}]'   # 填表单
bw s click <sess> <index>             # 逐步操作
bw s look <sess> --out /tmp/proof.png # 关键画面截图存证
bw s errors <sess>                    # 零 JS error
bw s close <sess>
```

- 自签证书：bw 的 chrome 后端可直接打开（不校验）；curl 要 `-k`。
- TOTP 类动态码：本地用 `packages/identity/src/domain/totp.ts` 的
  `base32Decode + totpAt` 按绑定密钥现算（30s 窗口；**同窗码只能用一次**，
  confirm 消费当前步后二次验证须用下一窗口步）。
- 修 bug 的部署：先在浏览器复现原症状消失（报错弹窗不再出现），
  再走一遍正向路径（如 TOTP：绑定弹窗出码 → 确认 → 恢复码展示 → 卡片状态翻转）。

## 5. 运维收尾（部署没结束直到这里清完）

1. **bootstrap-credentials.txt**：管理员确认能登录后
   `rm -f /opt/tillgate/data/bootstrap-credentials.txt`（一次性凭据，留着是风险）。
2. 事故恢复类部署：检查受影响账号/数据真实可用（登录、绑定状态落库），
   清理验证过程产生的临时代码/数据（如验证用的 totp 行、audit 噪声按需）。
3. 服务器临时脚本（/tmp/*.sh、docker cp 进去的）删掉。
4. 回滚标记留档（`renxqoo/tillgate:backup-<date>`），下次升级前再打新的。

## 禁止与边界

- 未经用户授权不碰生产（SSH/合并/重建容器都要用户明示）。
- 不 `docker compose down`、不 `rm -rf` 数据卷、不跑破坏性 SQL；
  数据修复类 SQL（如手工补 identity 行）先报告方案再做，做完留证据。
- 发布窗口选低峰；重建容器 = 全栈重启一次（单容器形态无滚动）。
- 多容器 compose 形态、HA、obs 观测栈不在本技能——见 docs/deployment.md §三/§四。

## 失败处置速查

| 症状 | 先查 |
| --- | --- |
| 容器反复重启 | `docker logs` 尾部；密钥不一致拒启 / bun install 失败最常见 |
| 8443 打不开 | `docker ps` 是否 healthy；nginx 是否最后起（aio.conf 8443 server 块） |
| 登录 invalid_credentials | `identity_credentials`/`identity_passwords` 是否有该管理员行（0112 事故形态） |
| TOTP 绑定报「引用的资源不存在」 | identity FK 是否残留（§3 断言）；pg_constraint 查 |
| 迁移没生效 | journal 计数 vs 迁移文件数；`docker logs` 里 provisioning + migrations 段 |
| 浏览器 TOTP 码总错 | App 里的密钥 ≠ 落库密钥（每次 enroll 换钥）；让用户走恢复码重绑 |
