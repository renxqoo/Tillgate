# Docker 部署收口实施方案

> 对应设计：[DESIGN.md](DESIGN.md)  
> 状态：Approved for implementation

## 1. 改动清单

| 阶段 | 文件 | 动作 |
|---|---|---|
| A | `docker/compose*.yml` | 必填插值、image prefix、服务降权、健康门控、IP 证书、Sentinel/replica 持久化 |
| B | `docker/Dockerfile.*` / `apps/*/Dockerfile` | Bun 版本精确到 patch、runtime `USER bun`、Next build args、管理员命令更正 |
| C | `packages/runtime/src/redis/*` | 抽出直连/Sentinel 连接参数解析真相 |
| D | 三个 API 与 worker 的 config/assembly，worker health/queue | 全 Redis 消费进程 Sentinel 与 DB/Redis readiness |
| E | `.github/workflows/*` / `package.json` | PR 构建镜像、ACR prefix 闭环、命令显式 env-file |
| F | README / configuration / deployment / HA / observability | 命令、必填键、引导、故障语义同步 |

## 2. 测试先行清单

1. runtime：直连 URL 保留；Sentinel 解析 host/port、master name、数据密码/db 与 sentinel password。
2. worker config：Sentinel 节点缺 master name 拒绝；完整组透传到 BullMQ 配置。
3. settlement queue：直连构造保持；Sentinel 构造不携直连 URL；`ping` 成功/失败透传。
4. health：`livez` 不查依赖；`readyz` 支持异步结果，reject 一律映射 503。
5. assembly：readiness 同时覆盖 scheduler/DB/Redis，不把 BullMQ 断线伪报为健康。
6. Compose：四组 `config -q`；镜像名矩阵；敏感键不进 Next/trace/migrate；server 证书挂载目标存在。

## 3. 实施顺序

1. 先补 runtime/worker 红测试，再实现连接参数与 readiness。
2. 修 Compose 与 Dockerfile，用脱敏的临时 env 做四形态合并断言。
3. 修 CI 与文档，保证所有可复制命令都与新契约一致。
4. 先跑 worker/runtime 定向测试，再跑根四门和覆盖率。
5. Docker daemon 可用时构建全镜像并做空卷旅程；不可用时必须明确报告未验证项，不以 `config -q` 代替运行验证。

## 4. 收口核销

- [ ] 不再有生产 PG/Redis 弱默认
- [ ] 空库首个管理员命令在 migrate 镜像内可执行
- [ ] ACR image prefix 与 server pull 同名
- [ ] IP 证书宿主路径、容器路径和 ignore 一致
- [ ] Next/trace/migrate 无全量 `.env`
- [ ] BullMQ 自动跟随 Sentinel，Sentinel/replica 重启不丢切换状态
- [ ] worker readiness 真实覆盖 PG/Redis
- [ ] 文档不再声称开源 Nginx 会消费 Docker health
- [ ] 四门、覆盖率与 Docker 验证结果已记录
