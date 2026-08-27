# HA 部署手册（阶段二：容器级高可用）

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；配置键与部署拓扑以代码与 docker/ 目录为准。

> 形态：`docker/compose.yml` + `docker/compose.ha.yml` 叠加。单机全角色冗余（Redis
> 主从 + sentinel ×3、应用双副本、PG WAL 归档），任何**组件故障**自动恢复；双机拆分
> 路径见 §5。gateway、client-api、admin-api 与 worker 统一消费 Sentinel 拓扑，
> `REDIS_URL` 只承载主库鉴权和 db 编号。

## 1. 拓扑

```
nginx（443/80 + 8443 可选，被动健康检查摘故障副本）
  ├─ gateway ×2 / client-api ×2 / admin-api ×2 / console-client ×2 / console-admin ×2
  ├─ trace-receiver ×2 · worker ×1（结算认领 SKIP LOCKED 多实例安全；单机双副本无增益，双机可 scale 2）
  ├─ Redis：master + redis-replica + sentinel-1/2/3（quorum 2，5s 判死 / 15s 切换）
  │    四个 Redis 消费进程经 REDIS_SENTINELS 发现当前主库
  └─ PostgreSQL：单实例 + WAL 归档卷（archive_timeout=300s）
```

worker 的结算快速调度走 BullMQ/Redis，PG 状态机与恢复扫描保留资金确定性兜底；
`/readyz` 只在 scheduler、PG 和 BullMQ Redis 都可用时返回 200。

## 2. 启动

```bash
cp .env.example .env && vim .env        # REDIS_PASSWORD 与 REDIS_SENTINEL_PASSWORD 必须独立强随机
docker compose --env-file .env -f docker/compose.yml -f docker/compose.ha.yml up -d --build
# migrate 任务照常一次性执行（幂等）：
docker compose --env-file .env -f docker/compose.yml -f docker/compose.ha.yml up migrate
```

验证：`docker compose --env-file .env -f docker/compose.yml -f docker/compose.ha.yml ps` 全 Up；
sentinel 端口未发布到宿主机，进网络内查（v2 变化：v1 的宿主机 `redis-cli -p 26379` 改 exec）：

```bash
docker compose --env-file .env -f docker/compose.yml -f docker/compose.ha.yml exec sentinel-1 \
  redis-cli -p 26379 sentinel master mymaster     # 显示 master=redis
```

curl 两域名各 200（用户面板 + admin 子域；IP 形态再验 8443）。

## 3. 故障演练清单（上线后逐条实弹验证）

| 演练 | 命令 | 期望 |
|---|---|---|
| 应用副本死 | `docker kill <gateway 副本1>` | nginx 摘除（≤10s），请求全走副本2，零报错 |
| Redis 主死 | `docker kill <redis 容器>` | Sentinel 达到 quorum 后提升 replica；四个消费进程自动跟随新主，worker 就绪探针在切换窗可能短暂 503 |
| Redis 主回来 | `docker start <redis>` | 旧主自动作为 replica 挂到当前主库下；无需为应用做人工 failback |
| PG 重启 | `docker restart postgres` | 应用 readyz 摘流 → PG 回来 → 自动恢复；WAL 归档连续 |
| 发布 | `docker compose ... up -d --build gateway` | 滚动重建双副本（逐个），期间另一副本持续服务 |

## 4. WAL 异机归档（把盘坏从「灾难」降为「分钟级 RPO」）

compose.ha.yml 已给 postgres 挂 `pg-archive` 卷并开 `archive_mode`（`archive_command`
拷贝到 `/archive`，`archive_timeout=300`）。本地 `/archive` 卷只是中转，必须推到对象存储：

```bash
# 宿主 crontab（每 5 分钟增量复制已完成 WAL；rclone 配置按实际路径挂载）
*/5 * * * * docker run --rm -v tillgate_pg-archive:/archive:ro \
  -v /root/.config/rclone:/config/rclone:ro rclone/rclone copy /archive s3:pg-archive/wal
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

- Sentinel 自身状态和 replica AOF 均已持久化，但单机卷仍不能抵御整机/整盘故障。
- 单机盘坏：WAL 归档在**同一台机**上没意义——§4 的异机推送是盘坏场景的唯一防线。
- 整机死：恢复 = 新机 `git clone` + `.env` + compose up + 恢复归档（小时级 RTO）；
  server 形态（无源码）则是新机 `docker load` 镜像 + `.env` + `--env-file` 起 compose。
- nginx 静态解析副本 IP：副本数变更后需 `docker compose exec nginx nginx -s reload`。
- worker 单副本：进程崩由 restart 策略恢复（秒级）；双机形态再 scale 2（多副本时给
  `WORKER_OWNER_ID` 显式命名，避免 pid 撞名）。

相关文档：[configuration.md](configuration.md)（Redis HA 键组）· [deployment-checklist.md](deployment-checklist.md)（备份/监控基线）
