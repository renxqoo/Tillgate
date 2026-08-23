# HA 部署手册（阶段二：容器级高可用）

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；配置键与部署拓扑以代码与 docker/ 目录为准。

> 形态：`docker/compose.yml` + `docker/compose.ha.yml` 叠加。单机全角色冗余（Redis
> 主从 + sentinel ×3、应用双副本、PG WAL 归档），任何**组件故障**自动恢复；双机拆分
> 路径见 §5。v2 现状有一处重要差异：**sentinel 自动跟随目前仅 client-api 生效**，
> gateway/admin-api 仍直连 Redis（见 §3 与 §6，compose.ha.yml 已预注入
> `REDIS_SENTINELS*` 键，待这两个应用接入后即自动启用）。

## 1. 拓扑

```
nginx（443/80 + 8443 可选，被动健康检查摘故障副本）
  ├─ gateway ×2 / client-api ×2 / admin-api ×2 / console-client ×2 / console-admin ×2
  ├─ trace-receiver ×2 · worker ×1（结算认领 SKIP LOCKED 多实例安全；单机双副本无增益，双机可 scale 2）
  ├─ Redis：master + redis-replica + sentinel-1/2/3（quorum 2，5s 判死 / 15s 切换）
  │    client-api 经 REDIS_SENTINELS 发现主库（packages/runtime create-redis-client 原生支持，
  │    REDIS_URL 仅承载密码凭证）；gateway/admin-api 直连 redis 服务名（v2 已知边界，§6）
  └─ PostgreSQL：单实例 + WAL 归档卷（archive_timeout=300s → 盘坏 RPO ≤5min）
```

worker 无 Redis 依赖（v2 变化：结算唤醒走 PG LISTEN/NOTIFY——gateway 在 signal 转入
`settlement_pending` 后 `pg_notify('settle-wake', …)` 纯门铃），Redis 故障不影响结算。

## 2. 启动

```bash
cp .env.example .env && vim .env        # 同原部署；REDIS_PASSWORD 务必强随机（sentinel/replica 凭证同源）
docker compose -f docker/compose.yml -f docker/compose.ha.yml up -d --build
# migrate 任务照常一次性执行（幂等）：
docker compose -f docker/compose.yml -f docker/compose.ha.yml up migrate
```

验证：`docker compose -f docker/compose.yml -f docker/compose.ha.yml ps` 全 Up；
sentinel 端口未发布到宿主机，进网络内查（v2 变化：v1 的宿主机 `redis-cli -p 26379` 改 exec）：

```bash
docker compose -f docker/compose.yml -f docker/compose.ha.yml exec sentinel-1 \
  redis-cli -p 26379 sentinel master mymaster     # 显示 master=redis
```

curl 两域名各 200（用户面板 + admin 子域；IP 形态再验 8443）。

## 3. 故障演练清单（上线后逐条实弹验证）

| 演练 | 命令 | 期望 |
|---|---|---|
| 应用副本死 | `docker kill <gateway 副本1>` | nginx 摘除（≤10s），请求全走副本2，零报错 |
| Redis 主死（client-api 面） | `docker kill <redis 容器>` | 15s 内 sentinel 提升 redis-replica 为新主；client-api 自动跟随（sentinel 模式）。期间网关推理零影响、登录走本地粗限（限流 fail-open / 爆破防护 degraded——降质换可用） |
| Redis 主死（gateway/admin-api 面） | 同上 | **v2 已知边界**：这两个服务直连旧主地址，切换期间报 READONLY/连接失败并持续重试（限流 fail-open、管理面登录防护 degraded，业务不中断）；sentinel 把旧主 reconf 成新主的从库后，直连写仍失败——需人工把拓扑切回（见 §6）恢复精确限流 |
| Redis 主回来 | `docker start <redis>` | 旧主自动作为 replica 挂到新主下（sentinel reconf）；要恢复 gateway/admin-api 直连写，执行一次 failback：`docker compose ... exec sentinel-1 redis-cli -p 26379 sentinel failover mymaster` 把主切回 `redis`，再观察两服务日志恢复 |
| PG 重启 | `docker restart postgres` | 应用 readyz 摘流 → PG 回来 → 自动恢复；WAL 归档连续 |
| 发布 | `docker compose ... up -d --build gateway` | 滚动重建双副本（逐个），期间另一副本持续服务 |

## 4. WAL 异机归档（把盘坏从「灾难」降为「分钟级 RPO」）

compose.ha.yml 已给 postgres 挂 `pg-archive` 卷并开 `archive_mode`（`archive_command`
拷贝到 `/archive`，`archive_timeout=300`）。本地 `/archive` 卷只是中转，必须推到对象存储：

```bash
# 宿主 crontab（每 5 分钟增量推送；rclone 已配好远端 s3:pg-archive）
*/5 * * * * docker exec <postgres容器> sh -c 'cd /archive && tar cf - .' \
  | rclone rcat s3:pg-archive/$(date +\%F)/wal-$(date +\%H\%M).tar
# 每日 basebackup（容器内 postgres 用户可免密本地复制的部署形态；否则补 -U $POSTGRES_USER）
0 3 * * * docker exec <postgres容器> pg_basebackup -D /archive/base-$(date +\%F) -Ft -Xs -P
```

恢复演练（季度）：新库 `tar xf base + 恢复 WAL + recovery_target_time` → 核对资金账本
余额与对账口径一致。

## 5. 双机升级路径（抗整机故障，配置零改动）

所有角色本就是独立容器，拆机只是重新分布：

| 组件 | 动作 |
|---|---|
| 应用副本 | compose.ha.yml 拆 `node-a`/`node-b` 两个 override，各跑一半副本 |
| sentinel×3 | 两机各 1 + 第三位置（nginx 机/云）1——保持奇数与跨机仲裁 |
| Redis 主从 | 主从分居两机（sentinel 自动管理；跨机后 client-api 的自动跟随演练必做） |
| PG | 首选云 RDS（主从 + PITR 全托管）；自建则加流复制从库到第二机（`pg_basebackup` 起 replica + `recovery.signal`） |
| nginx | 换云 SLB 指向两机（免 keepalived 脑裂）；或 keepalived VIP |

拆分后重跑 §3 全部演练（此时 Redis 主死演练会跨机切换）。

## 6. 已知边界（诚实清单）

- **gateway / admin-api 未接入 sentinel**：compose.ha.yml 已给它们（以及 worker、
  trace-receiver）注入 `REDIS_SENTINELS`/`REDIS_SENTINEL_NAME`，但当前只有 client-api 的
  config schema 消费这组键——gateway/admin-api 直连 `redis` 服务名，主从切换后直连写
  失败直到人工 failback（§3）。业务可用性不受影响（限流 fail-open / 防护 degraded），
  受影响的是限流精度；两个应用接入后此条作废。
- 单机盘坏：WAL 归档在**同一台机**上没意义——§4 的异机推送是盘坏场景的唯一防线。
- 整机死：恢复 = 新机 `git clone` + `.env` + compose up + 恢复归档（小时级 RTO）；
  server 形态（无源码）则是新机 `docker load` 镜像 + `.env` + `--env-file` 起 compose。
- nginx 静态解析副本 IP：副本数变更后需 `docker compose exec nginx nginx -s reload`。
- worker 单副本：进程崩由 restart 策略恢复（秒级）；双机形态再 scale 2（多副本时给
  `WORKER_OWNER_ID` 显式命名，避免 pid 撞名）。

相关文档：[configuration.md](configuration.md)（Redis HA 键组）· [deployment-checklist.md](deployment-checklist.md)（备份/监控基线）
