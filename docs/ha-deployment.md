# HA 部署手册（阶段二：容器级高可用）

> 形态：`compose.yml` + `compose.ha.yml` 叠加。单机全角色冗余（Redis 主从+sentinel
> ×3、应用双副本、PG WAL 归档），任何**组件故障**自动恢复；双机拆分路径见 §5。
> 降级语义总表见 `docs/benchmark-2026-08-21-bun-vs-node.md` 同期评审与 AGENT.md。

## 1. 拓扑

```
nginx（443/80，被动健康检查摘故障副本）
  ├─ gateway ×2 / client-api ×2 / admin-api ×2 / console-client ×2 / console-admin ×2
  ├─ trace-receiver ×2 · worker ×1（SKIP LOCKED 安全，双机可 scale 2）
  ├─ Redis：master + replica + sentinel-1/2/3（quorum 2，5s 判死 / 15s 切换）
  │    应用经 REDIS_SENTINELS 发现主库（core/redis-client 原生支持，密码取自 REDIS_URL）
  └─ PostgreSQL：单实例 + WAL 归档卷（archive_timeout=300s → 盘坏 RPO ≤5min）
```

## 2. 启动

```bash
cp .env.example .env && vim .env        # 同原部署；REDIS_PASSWORD 务必强随机
docker compose -f docker/compose.yml -f docker/compose.ha.yml up -d --build
# migrate 任务照常一次性执行（幂等）
```

验证：`docker compose ... ps` 全 Up；`redis-cli -p 26379 sentinel master mymaster`
显示 master=redis；curl 两域名各 200。

## 3. 故障演练清单（上线后逐条实弹验证）

| 演练 | 命令 | 期望 |
|---|---|---|
| 应用副本死 | `docker kill <gateway 副本1>` | nginx 摘除（≤10s），请求全走副本2，零报错 |
| Redis 主死 | `docker kill <redis 容器>` | 15s 内 sentinel 提升 replica 为新主；期间限流 fail-open、爆破防护 degraded（本地粗限，登录不中断——降质换可用）、免费日限 503；之后自动恢复 |
| Redis 主回来 | `docker start <redis>` | 旧主自动作为 replica 挂到新主下（sentinel reconf） |
| PG 重启 | `docker restart postgres` | 应用 readyz 摘流 → PG 回来 → 自动恢复；WAL 归档连续 |
| 发布 | `docker compose ... up -d --build gateway` | 滚动重建双副本（逐个），期间另一副本持续服务 |

## 4. WAL 异机归档（把盘坏从「灾难」降为「分钟级 RPO」）

本地 `/archive` 卷只是中转，必须推到对象存储：

```bash
# 宿主 crontab（每 5 分钟增量推送；rclone 已配好远端 s3:pg-archive）
*/5 * * * * docker exec <postgres容器> sh -c 'cd /archive && tar cf - .' \
  | rclone rcat s3:pg-archive/$(date +\%F)/wal-$(date +\%H\%M).tar
# 每日 basebackup
0 3 * * * docker exec <postgres容器> pg_basebackup -D /archive/base-$(date +\%F) -Ft -Xs -P
```

恢复演练（季度）：新库 `tar xf base + 恢复 WAL + recovery_target_time` → 跑
`bun scripts/` 对账脚本核对余额。

## 5. 双机升级路径（抗整机故障，配置零改动）

所有角色本就是独立容器，拆机只是重新分布：

| 组件 | 动作 |
|---|---|
| 应用副本 | compose.ha.yml 拆 `node-a`/`node-b` 两个 override，各跑一半副本 |
| sentinel×3 | 两机各 1 + 第三位置（nginx 机/云）1——保持奇数与跨机仲裁 |
| Redis 主从 | 主从分居两机（sentinel 自动管理） |
| PG | 首选云 RDS（主从+PITR 全托管）；自建则加流复制从库到第二机（`pg_basebackup` 起 replica + `recovery.signal`） |
| nginx | 换云 SLB 指向两机（免 keepalived 脑裂）；或 keepalived VIP |

拆分后重跑 §3 全部演练（此时 Redis 主死演练会跨机切换）。

## 6. 已知边界（诚实清单）

- 单机盘坏：WAL 归档在**同一台机**上没意义——§4 的异机推送是盘坏场景的唯一防线
- 整机死：恢复 = 新机 `git clone` + `.env` + compose up + 恢复归档（小时级 RTO）
- nginx 静态解析副本 IP：副本数变更后需 `docker compose exec nginx nginx -s reload`
- worker 单副本：进程崩由 restart 策略恢复（秒级）；双机形态再 scale 2
