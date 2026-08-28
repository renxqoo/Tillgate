# Docker 部署收口设计

> 状态：Accepted  
> 日期：2026-08-27  
> 范围：Docker Compose 生产/开发/单机 HA 形态、镜像发布、首次引导与 worker 结算可用性

## 1. 问题与目标

当前编排已具备多阶段镜像、迁移门控和内网隔离，但存在五类可执行契约缺口：

1. 根 `.env` 没有进入 Compose 插值面，生产密码回落弱默认；
2. 空库缺首个管理员，IP 证书和 ACR 镜像名无法与服务器形态闭环；
3. 公网 Next 容器获得了无关的数据库与全域密钥；
4. worker 已回归 BullMQ，但 HA 仍按“worker 无 Redis”编排，且 `/readyz` 不探测 DB/Redis；
5. Sentinel 和 WAL 手册的实际可恢复性与文档承诺不等价。

本次目标是让三条官方路径都能执行并 fail-closed：

- 开发：根 `.env` → PG/Redis → 宿主 Bun；
- 源码生产：根 `.env` → migrate → bootstrap admin → TLS → 全栈；
- 无源码生产：ACR/save-load 镜像 → IP/域名证书 → 同一运行契约。

## 2. 决策

### D1. Compose 插值只认显式 `--env-file .env`

所有文档命令、根 scripts 和 CI 都显式传入根 `.env`。生产 PG/Redis 密码改为
Compose `:?` 必填，不保留生产弱默认；开发 compose 保留明确的本地密码。

### D2. 空库引导是一等部署步骤

`migrate` 镜像继续携带 `create-admin.ts`，但命令必须以 `/repo` 为工作目录并开启
`development` export condition。引导位于迁移之后、全栈开放之前；缺省现场生成一次性强密码。

### D3. 镜像名以 `TILLGATE_IMAGE_PREFIX` 对齐发布与运行

自建镜像名统一为 `${TILLGATE_IMAGE_PREFIX:-tillgate}/<service>:${TILLGATE_TAG:-local}`。
CI 推送 ACR 后，服务器只需设置 prefix 与 tag，无需再维护一套 image override。

### D4. IP 证书按最小宿主目录挂载

IP 形态不复用 certbot 命名卷；`certs-server/fullchain.pem|privkey.pem` 只读挂载到
`/etc/letsencrypt/live/gateway`。该目录同时进入 git 与 Docker build context ignore。

### D5. 敏感配置按服务降权

两个 Next 容器、trace-receiver 和 migrate 取消全量 `env_file`，只显式注入自身配置。
三个 API 与 worker 仍需消费较多运营参数，本次保留单 `.env` 运维面，但显式移除已知无关的
跨 realm 密钥、pepper 和 Compose 原始密码。后续如接入 Vault/Swarm secrets，另定密钥读取契约，
不在本次暗中引入双轨。

### D6. 所有 Redis 消费进程共用 Sentinel 拓扑真相

runtime 提供纯解析的 Redis 连接参数函数；普通客户端和 BullMQ 分别叠加自己的命令重试语义。
gateway、client-api、admin-api 和 worker 均消费
`REDIS_SENTINELS/REDIS_SENTINEL_NAME/REDIS_SENTINEL_PASSWORD`，同时保留 `REDIS_URL`
作数据节点密码/db 载体。

### D7. worker readiness = scheduler + PostgreSQL + BullMQ Redis

`/livez` 只表示进程调度器存活；`/readyz` 异步 ping DB 与 BullMQ 连接，任一失败返回 503。
PG 仍是资金事实源；Redis/Sentinel 故障不丢账，但必须被 readiness 和告警显式暴露，不伪报健康。

### D8. Sentinel 持久化自己的改写状态

三个 Sentinel 使用独立卷，仅首次生成 `sentinel.conf`；后续重启保留新 master、epoch 与
failover 状态。Sentinel 自身启用 `requirepass`，与应用的 `sentinelPassword` 同源。
被提升的 replica 也有独立数据卷，健康检查只验证可达性，不把合法的 master 角色判为不健康。

### D9. 健康边界如实表达

Compose health 只用于启动门控与外部观测，开源 Nginx 不会自动读取 Docker health。
文档删除“`readyz` 会让 Nginx 自动摘流”的承诺，保留被动连接失败摘除语义；需主动健康摘流时，
必须在外部 LB/编排器实现。

## 3. 兼容、回滚与观测

- 配置兼容：直连 Redis 形态不变；只有显式配置 Sentinel 才进入发现模式。
- 数据兼容：不改表、队列 payload 和账务状态；无数据迁移与双读窗口。
- 回滚：保留原 `tillgate/*:local` 为 image prefix 默认；删除 HA override 即回直连 Redis。
- 观测：worker `/readyz` 503、BullMQ error log、Sentinel master 查询与结算积压共同构成切换信号。

## 4. 验收契约

1. 四套 Compose 组合在空/弱生产配置下 fail-closed，在完整配置下 `config -q` 通过；
2. 全部八个自建镜像可构建，四个 Bun runtime 以非 root 用户启动；
3. 空库 migrate 成功后可从 migrate 镜像创建首个管理员；
4. Next/trace/migrate 容器的解析配置不含全域密钥；
5. worker 直连/Sentinel 参数矩阵、readyz 依赖失败与 BullMQ ping 有回归测试；
6. `typecheck / lint / test / build` 四门与现有覆盖率阈值全绿，不降阈值。
