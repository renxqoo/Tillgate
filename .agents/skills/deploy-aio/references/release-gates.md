# 发布判定与故障处置

## 发布前置清单（全过才执行部署）

- [ ] PR 的 agent 审查全部「通过」（无未处置 blocker/major）
- [ ] PR checks 全绿（CI 四门 + 覆盖率）
- [ ] 本地四门在最终 HEAD 重跑过（typecheck/lint/test/build）
- [ ] 涉及迁移：本地 repro 库上验证过「已应用库重放」与「lagging 库追平」双路径
- [ ] 回滚后果明确（表结构前向、镜像单标签——回滚标记已打）
- [ ] 服务器 inspect 过原容器参数，重建命令逐项复刻

## 等待与超时

| 阶段 | 正常耗时 | 超时动作 |
| --- | --- | --- |
| CI 四门 | 5-10 min | `gh run watch --exit-status` 失败即停，看日志修 |
| docker-publish | 10-20 min | 同上；Secrets 缺失会响亮失败 |
| 首启 bun install（载荷变更后） | 3-10 min（npmmirror） | 失败 exit 1 + 自动重启重试；连续 3 次失败才人工介入，查网络/registry |
| 迁移 | 秒级~分钟 | journal 计数断言判定，不信日志「没报错」 |
| HEALTHCHECK | start-period 600s 内 | 超 10 分钟未 healthy = 失败，看 logs |

## 常见故障

### 容器起不来 / 反复重启

```bash
docker logs tillgate 2>&1 | tail -30
```
- `refusing to start: <KEY> differs` → env 与 secrets.env 不一致；复刻原 env 或走轮换流程。
- `bun install failed` → 网络/registry；重启策略会重试，连续失败查 DNS。
- `postgres not ready within 60s` → pgdata 损坏或磁盘满：`df -h`。

### 起来了但 8443 不通

```bash
docker ps --filter name=tillgate --format '{{.Status}}'   # healthy?
docker exec tillgate sh -c "wget -qO- http://127.0.0.1:8082/livez 2>&1 || true"  # admin-api 活着?
docker exec tillgate sh -c "wget -qO- --no-check-certificate https://127.0.0.1:8443/ 2>&1 | head -c 100"  # nginx 8443?
```
nginx 最后启动——`stack is up` 之前 8443 不通是正常时序，等。

### 迁移疑似没生效

```bash
# journal 计数 = 仓库迁移文件数（git 侧）
ls packages/db/migrations/*.sql | wc -l
# 服务器侧
dq "select count(*) from drizzle.__drizzle_migrations;"
```
不等则看 logs 的 `running database provisioning + migrations` 段报错。
drizzle migrator 按 journal 时间戳判重放、不校验文件哈希——改写已应用
迁移文件内容不影响线上库（0113 善后用过该语义，但改前必须想清楚 lagging 库会跑改后版本）。

### 登录失败（invalid_credentials）

排查序：
1. `identity_credentials` 有无该邮箱行（无 = 凭据被删/未建，见凭据修复配方）。
2. 有行但 `identity_passwords` 无对应行 = 哈希丢失，同上修复。
3. 都在 → 密码错或用户 App 问题；audit_logs 里 `identity.credential.authenticate` 有留痕。

### TOTP 报「引用的资源不存在」（23503/pg_fk_violation）

identity FK 违反的统一文案。查：
```bash
dq "select conname from pg_constraint where contype='f' and conname like 'identity%';"
```
应为 0 行（0113 后）。有残留 = 迁移没走全，回「迁移疑似没生效」。

## 回滚

```bash
docker stop tillgate && docker rm tillgate
docker tag renxqoo/tillgate:backup-<date> renxqoo/tillgate:latest   # 或 run 时直接用 backup tag
# 重新执行启动命令（参数同 inspect）
```
- 迁移不回滚（前向）；代码回滚后新迁移的表还在——无害但要知道。
- 载荷哈希机制保证旧镜像会重装对应版本依赖，无需清 /data/repo。

## 证据留存

每次部署留：merge commit sha、镜像 Created 时间、`[aio]` 日志尾、
DB 断言输出、浏览器截图（/tmp 或约定目录）、回滚标记名。
报告里逐项引用——「应该好了」不是结果，断言输出才是。
