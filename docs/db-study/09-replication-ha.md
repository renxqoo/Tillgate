# 09 · 复制与高可用（Replication & High Availability）

> 单台数据库会宕机、磁盘会坏、机房会断网。复制（Replication）把主库的修改日志持续传到其他节点重放，换来两样东西：故障时可以切过去的副本（高可用），以及可以分担读流量的副本（读扩展）。本篇讲清 MySQL 与 PostgreSQL 两种主流复制实现、同步强度的取舍光谱、主从延迟与"读己之写"问题，以及故障切换中的脑裂、fencing 与时间线分叉。

## 读完本篇你应能回答

- 复制传的到底是什么？为什么是日志，而不是数据文件或 SQL 语句？
- MySQL binlog 三种格式 statement / row / mixed 各自的风险与适用场景？
- 异步、半同步、共识组复制在数据丢失窗口（RPO）上如何递减？各自付出什么代价？
- PG 物理流复制和逻辑复制分别适合什么场景？复制槽为什么会把主库磁盘撑爆？
- 为什么 `Seconds_Behind_Master = 0` 不代表没有主从延迟？
- failover 与 switchover 的区别？什么是脑裂（split-brain），怎么用 fencing 防住？

## 一、复制的本质：重播历史，而不是搬运现状

### 直觉

主从复制不是把"数据"拷一份过去，而是把"发生过什么"（修改日志）按顺序在另一台机器上重放一遍——像把账本的记账流水抄一份到另一个账本，而不是只抄余额。传日志有三个好处：

- 日志是顺序追加写的，比随机写数据页便宜得多；
- 日志天然带全序（先后顺序确定），重放结果确定；
- 增量日志的体积远小于数据全集。

### 结构：一条日志流水线

```text
        主库（Primary / Master）                      从库（Replica / Slave）
┌──────────────────────────────┐            ┌──────────────────────────────────┐
│ 客户端写事务                   │            │ IO Thread（MySQL）                │
│   │ 提交                      │            │ / WAL Receiver（PG）  ③ 收日志    │
│   ▼                          │   网络      │      │                           │
│ binlog（MySQL）/ WAL（PG）────┼──────────▶ │      ▼                           │
│   │ ① 本地先持久化             │  Binlog    │ relay log（MySQL）               │
│   │（WAL 先行，见 06 篇）      │  Dump      │ / 本地 pg_wal（PG） ④ 中转落盘   │
│   ▼                          │  Thread    │      │                           │
│ 提交完成，可返回客户端 ②        │  /WAL      │      ▼                           │
│                              │  Sender    │ SQL Thread + workers（MySQL）    │
│  每个连上来的从库，主库对应     │  (PG)      │ / startup 进程（PG） ⑤ 重放       │
│  一个发送线程                  │            │      │                           │
│                              │            │      ▼                           │
│                              │            │ 数据文件（逐步与主库一致）           │
└──────────────────────────────┘            └──────────────────────────────────┘
```

### 机制细节

- **MySQL**：主库为每个连接的从库起一个 Binlog Dump Thread，把 binlog（Binary Log，二进制日志）事件流推出去；从库 IO Thread 接收后写入本地中继日志（relay log），再由 SQL Thread（或并行 worker 池）重放。接收与重放通过 relay log 解耦：网络抖动断开后从库可以从断点续传，重放进度独立推进。
- **PostgreSQL**：主库每个从库对应一个 WAL Sender 进程，流式发送 WAL（Write-Ahead Log，预写式日志）字节流；从库 WAL Receiver 先写入本地 `pg_wal` 目录，由 startup 进程持续回放。物理复制回放的是"物理块级变更"，所以从库与主库**物理同构**——同大版本、同架构、整库一份。
- 两边共同的关键点：主库提交成功的时刻，从库大概率**还没**收到或应用——复制默认是异步流水线。

### 对开发者的实际影响

- "写成功了"只代表主库本地已持久化；从库能否读到、何时读到，取决于复制延迟与同步级别——这是后面读写分离一切问题的根源。
- 复制的最小单位是事务：主库上一个事务原子地提交，在从库上也原子地重放；但**大事务在从库要重放同样久**。

## 二、MySQL 复制：binlog 驱动

### binlog 三种格式

binlog 记录"变更事件"，有三种格式（`binlog_format`，MySQL 8.0 默认 **ROW**）：

| 维度 | statement | row | mixed |
|---|---|---|---|
| 记录内容 | 原始 SQL 文本 | 每行变更的前后镜像 | 默认 statement，检测到不确定性语句自动切 row |
| 体积 | 小 | 大（更新 10 万行 = 10 万条行事件） | 居中 |
| 重放确定性 | 差：结果依赖执行时的上下文 | 好：逐行重放，与主库必然一致 | 视语句而定 |
| 典型风险 | `NOW()`、`UUID()`、无 `ORDER BY` 的 `LIMIT` 更新在从库选错行 | 大事务让 binlog 与主从带宽暴涨 | 行为不直观 |
| 工具生态 | 差 | 好：CDC（Change Data Capture，变更数据捕获，如 Debezium）、在线改表工具都依赖 row | 同 row |

statement 省空间但有正确性风险，row 正确但费空间，mixed 是过渡方案。8.0 时代新系统基本只剩一个答案：**row**（可配 `binlog_row_image=MINIMAL` 只记变更列省体积，默认 FULL）。

### 线程模型与基本观测

```sql
-- MySQL 8.0：主库查看 Binlog Dump 线程（每个从库一条）
SHOW PROCESSLIST;

-- 主库查看当前 binlog 位点与 GTID
SHOW MASTER STATUS;   -- 8.0；输出 File / Position / Executed_Gtid_Set

-- 从库总览（8.0.22+ 新名，旧名 SHOW SLAVE STATUS）
SHOW REPLICA STATUS\G
-- 重点列：Replica_IO_Running / Replica_SQL_Running（两个线程是否都活着）、
--        Retrieved_Gtid_Set（已收到的）、Executed_Gtid_Set（已重放的）、
--        Seconds_Behind_Master（延迟，注意局限，见第五节）

-- 8.0 更推荐从 performance_schema 看回放细节
SELECT * FROM performance_schema.replication_applier_status_by_worker\G
```

### GTID：让"搭从库、换主库"不再对位点

没有全局事务标识（Global Transaction Identifier, GTID）时，从库用"文件名 + 偏移量"（如 `mysql-bin.000003:1547`）记录位点。多个从库位点不同，主库故障时要人工找出"谁的数据最全"，再把其他从库指向它——脑力密集且易错。

GTID 形如 `server_uuid:transaction_id`（如 `3E11FA47-71CA-11E1-9E33-C80AA9429562:1-5`）：

- 每个事务在整条复制拓扑里全局唯一，从库记录的是"已执行的 GTID 集合"（`Executed_Gtid_Set`）；
- 新从库用 `SOURCE_AUTO_POSITION=1`（`CHANGE REPLICATION SOURCE TO ...`）对接，主库自动补发从库缺的事务，不再人工找位点；
- 故障切换时，GTID 集合的包含关系能直接判断"哪个从库数据最全"。

MySQL 8.0 的 `gtid_mode` 默认仍是 `OFF`（但支持在线启用，不必停机），新项目建议建设期就打开。

### 并行复制：从库怎么追上主库

早期从库只有单个 SQL Thread 串行重放，主库并发越高、从库落后越多。演进路线：

1. **库级并行**（`replica_parallel_type=DATABASE`）：不同 database 的事务可并行。单库业务几乎无收益。
2. **组提交并行**（`LOGICAL_CLOCK`）：主库 binlog 组提交（group commit）里同一批的事务彼此已证明无锁冲突，从库可安全并行；再配合 `binlog_transaction_dependency_tracking=WRITESET`（基于写集合判冲突，8.0 默认 `COMMIT_ORDER`）能把并行度提得更高。
3. `replica_parallel_workers`：8.0.27 起默认 **4**（此前默认 0 即单线程），现代版本默认就有并行回放。

## 三、PostgreSQL 复制：物理流 vs 逻辑流

### 两种复制对比

| 维度 | 物理流复制 | 逻辑复制（Logical Replication） |
|---|---|---|
| 传输内容 | WAL 原始字节流 | 解码后的逻辑变更（INSERT/UPDATE/DELETE 流） |
| 从库形态 | 物理同构的全库副本（同大版本、同架构） | 普通库，可只订阅部分表 |
| 粒度 | 整个实例 | publication 级选表，PG 15+ 支持行过滤与列清单 |
| 跨大版本 | 不可以 | 可以（常用作 13 → 16 的滚动升级方案） |
| 双向/多写 | 不可以 | 可搭建（冲突需应用层处理） |
| DDL | 随 WAL 传播 | **不复制**，两端各自执行 |
| 序列（sequence） | 随 WAL 传播 | **不复制**，序列状态不在逻辑流里 |
| 回放方式 | 块级物理回放，开销低 | 逐条解码 + 逻辑执行，开销略高 |
| 典型用途 | 高可用副本、读扩展、PITR 保留 | 选表同步、跨版本升级、跨库订阅 |

一句话选择：要**高可用副本**用物理流复制；要**选表、跨版本、跨实例订阅**用逻辑复制。逻辑复制要求表有复制标识（`REPLICA IDENTITY`，默认主键）才能复制 UPDATE/DELETE。

### 复制槽：保护 WAL 的双刃剑

复制槽（replication slot）让主库记住"每个从库消费到哪了"：从库断连后主库不回收其未消费的 WAL，从库重连可续传，不用全量重建。代价是——

**从库永久下线而槽不删，主库 `pg_wal` 会无限增长直到磁盘写满、整库宕机**。这是 PG 复制最经典的运维事故，必做三件事：监控槽状态、给保留量封顶、废弃槽及时删。

```sql
-- PostgreSQL 16：主库查看复制连接与延迟
SELECT application_name, client_addr, state, sync_state,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

-- 查看复制槽：wal_status 不再是 reserved 就该介入
--（extended 已超出软上限该告警；unreserved/lost 随时会断复制需立即处理）
SELECT slot_name, slot_type, active, wal_status
FROM pg_replication_slots;

-- 字节级回放延迟：主库当前 WAL 位置 vs 某从库回放位置
SELECT application_name,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS lag_bytes
FROM pg_stat_replication;

-- 给 WAL 保留封顶（PG 13+；PG 16 默认 -1 即不限制）
-- ALTER SYSTEM SET max_slot_wal_keep_size = '10GB';
```

另注意：PG 16 及更早版本，逻辑复制槽**不会**随 failover 转移到新主（PG 17 才引入故障转移槽），主库切换后逻辑订阅需要重建。

## 四、同步强度光谱：你在为多大的丢失窗口付费

复制的核心参数不是"怎么传"，而是"主库提交前要不要等从库"。这条光谱是本篇的骨架：

| 强度 | 机制 | 丢失窗口（RPO） | 代价 | 典型配置 |
|---|---|---|---|---|
| 异步（async） | 主库提交即返回，不等从库 | 主库崩机时丢掉"未传出去"的最后一段日志（通常毫秒~秒级） | 最低：无额外等待 | 两者默认（PG 未配置同步备库时即异步） |
| 半同步（semi-sync） | 至少 1 个从库确认**收到**才返回客户端 | 接近 0（从库已收到日志，但未必已回放，取决于确认点） | 每个事务多一次主从往返；从库超时会**自动降级回异步** | MySQL 半同步插件；PG `synchronous_standby_names` |
| 共识组复制 | 事务在**多数派**节点达成一致后才提交 | 多数派存活则 0 丢失 | 写延迟受多数派 RTT 限制；运维复杂 | MySQL MGR；etcd/TiKV 类共识存储 |

RPO（Recovery Point Objective）指能容忍丢失多少数据；对应的 RTO（Recovery Time Objective）是多久恢复服务。半同步把 RPO 从"秒级"压到"接近 0"，共识把它压到 0——每一级都用延迟和复杂度付款。

### MySQL 半同步：AFTER_SYNC vs AFTER_COMMIT

半同步插件在 8.0.26 起更名（`rpl_semi_sync_master_*` → `rpl_semi_sync_source_*`，旧名兼容）。等待点 `rpl_semi_sync_source_wait_point`（默认 **AFTER_SYNC**）决定了语义差异：

```text
AFTER_SYNC（无损半同步，默认）      AFTER_COMMIT
主库             从库 IO 线程       主库             从库 IO 线程
 │ 事务写入 binlog │                 │ 事务写入 binlog │
 │─── 传送事件 ───▶│                 │─── 传送事件 ───▶│
 │◀──── ACK ──────│ ① 主库等这个     │ 先在主库提交引擎 │
 │ 收到 ACK 后才：  │                 │◀──── ACK ──────│ ② 再等 ACK
 │  提交到存储引擎  │                 │ 期间：其他会话已经能看到该事务  ◀─ 幻读风险
 │  返回客户端 ✓   │                 │ 才返回客户端 ✓  │
                                     │ 若此刻主库崩溃且事件未传出：见过的数据"消失"
```

- **AFTER_SYNC**（loss-less）：客户端收到成功时，事务必然已到达至少一个从库的 relay log——主库整机烧掉也不丢。且事务在主库可见之前从库已收到，不存在"别人读过又消失"。
- **AFTER_COMMIT**：主库先本地提交再等 ACK。等待窗口内**其他会话**已能读到该事务；若主库此时崩溃而事件未传出，就出现"读过的数据消失"——对使用者表现为幻读。
- `rpl_semi_sync_source_timeout` 默认 10000ms：从库超时未 ACK，**自动降级为异步**——半同步的保证不是无条件的，慢从库会把整个系统拖回异步。

### PG 同步复制：FIRST n / ANY n

PG 不叫半同步，而是用 `synchronous_standby_names` 声明"等谁、等几个"，配合 `synchronous_commit` 声明"等到哪个确认点"：

```sql
-- PostgreSQL 16：等前 2 个（按列出优先级）备库 flush 落盘
-- ALTER SYSTEM SET synchronous_standby_names = 'FIRST 2 (s1, s2, s3)';
-- quorum：任意 2 个确认即可，可用性更好
-- ALTER SYSTEM SET synchronous_standby_names = 'ANY 2 (s1, s2, s3)';

-- synchronous_commit 的确认点阶梯（越往下越慢越安全）：
--   remote_write  备库收到并写入操作系统缓存
--   on            备库 WAL 已 flush 落盘（默认）
--   remote_apply  备库回放完成、已可查询

-- 一致性可以细到单个事务：关键事务等待回放，普通报表本地提交即可
BEGIN;
SET LOCAL synchronous_commit = remote_apply;
INSERT INTO payment ...;
COMMIT;
```

`FIRST 2` 语义确定但前两个备库同时故障会阻塞主库写入；`ANY 2`（quorum）只要任意两个备库确认即可，可用性更好。这种"逐事务选择一致性强度"的能力，是应对 CAP 取舍的实操手段（见 10 篇）。

### 共识组复制：MySQL MGR

组复制（MySQL Group Replication, MGR，InnoDB Cluster 的核心组件）基于 Paxos 变体协议（XCom）：事务在多数派节点达成一致后才提交，成员故障/加入自动重配置。代价：至少 3 台起、写吞吐受多数派消息轮次限制、运维门槛高。它把本节光谱推到"多数派存活则 RPO=0"。

## 五、主从延迟：成因、观测与读己之写

### 成因

按出现频率排：

1. **大事务**：主库执行 10 分钟的 `UPDATE`，从库重放也要 10 分钟——复制是流水线，不是加速器；
2. **回放并行度不足**：单 SQL Thread（或事务间依赖导致无法并行）；
3. **网络带宽**：跨机房/跨区域复制，row 格式大事务直接打满链路；
4. **从库硬件弱**：主库 NVMe、从库机械盘是最常见的翻车配置；
5. **从库自身的锁与长查询**：回放也要拿行锁，一条长报表查询能阻塞回放线程；
6. **从库读流量争抢**：buffer pool 里全是报表页，回放要读的页反复换入换出。

### 观测：别只信一个数字

MySQL 的 `Seconds_Behind_Master` 是"当前时间 − 从库最近处理事件的时间戳"。两个坑：主从时钟不一致直接污染结果；IO 线程已追平、SQL 线程还在重放长事务**尾部之前**的事件时，最近事件时间戳可能很新，显示 0 但实际落后巨大。更可靠的是比较主从 GTID 集合或传输字节量；PG 用 `pg_stat_replication` 的三个 lag 列交叉 LSN（WAL 日志位置编号，06 篇详解）字节差（见第三节 SQL）。字节差（`lag_bytes`）受时钟影响最小，是跨机房复制最值得上的告警指标。

### 影响：读写分离下的读己之写

```text
t0  客户端 ──写──▶ 主库 commit 成功（异步复制，从库还没收到）
t1  客户端 ──读──▶ 从库        ──▶ 读不到刚写的数据 ✘
```

这就是**读己之写**（read-your-writes）问题：用户"下单成功"后跳到订单列表却看到空列表。异步复制下这不叫 bug，是语义的一部分——要么别从从库读，要么显式等待。

## 六、应用层处理主从延迟的常用手段

按改造成本从低到高：

1. **关键路径读写都走主库**（sticky 路由）：订单详情、支付结果、个人资料这类"写完立刻要读"的路径直接路由主库。简单有效，代价是主库读压力。
2. **写后短时间会话粘主库**：用户发生写操作后，其会话在 N 秒内全部请求走主库，超时后回到从库。覆盖了绝大多数"写完就查"的行为模式。
3. **版本号/时间戳校验**：写入时记录版本（或 LSN/GTID），读从库时校验从库可见版本 ≥ 写入版本，不满足则重试或升级读主库。
4. **显式等待从库追上**：

```sql
-- MySQL 8.0：阻塞直到本连接的从库执行到指定 GTID 集合（成功返回 0，超时返回 1）
SELECT WAIT_FOR_EXECUTED_GTID_SET('3E11FA47-71CA-11E1-9E33-C80AA9429562:1-105', 5);

-- PostgreSQL 16：主库写入事务内记下 WAL 位置，应用侧轮询从库回放位置
-- 主库：  SELECT pg_current_wal_insert_lsn();   -- 随业务一起返回给客户端
-- 从库：  SELECT pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '<记录的 LSN>') >= 0;
```

5. **PG 的终局方案**：对强一致读路径用 `synchronous_commit = remote_apply`（第四节），让从库回放完才返回——把等待下沉到数据库，代价是写延迟。

## 七、高可用与故障切换

### failover vs switchover，以及 RPO/RTO

- **switchover**：计划内切换（维护、升级）。旧主正常下线、数据对齐后再提升新主，理论上零丢失。
- **failover**：故障切换。旧主失联，监控仲裁系统把某个从库提升为新主。异步复制下，**提升时刻未传到该从库的日志就是永久丢失的数据**——RPO 即复制延迟的尾部。
- 高可用选型的本质是在 RPO 与 RTO 之间定价：异步复制 RTO 短但 RPO 非零；共识方案 RPO 为零但写入更慢、部署更重。

### 脑裂与 fencing

**脑裂**（split-brain）：旧主没有真死（长 GC、网络抖动、监控误判），新主已被选出，两台同时接受写——两份"真相"开始分叉，合并代价极高。防脑裂靠**fencing**（隔离）：在新主接管前确保旧主**不能再写**：

- **STONITH**（Shoot The Other Node In The Head）：直接对旧主断电/强制重启，物理层面消灭写能力；
- **第三方仲裁/租约**：把"谁是主"放进独立共识服务（如 etcd），持租约者才是主，租约过期自动失去身份（Patroni 管理 PG 集群就是这个模型）；
- **旧主自愈只读**：旧主恢复后默认以只读身份加入，等待人工或工具裁决。

### 时间线分叉：旧主的日志怎么办

```text
                            旧主 A 宕机（实际还活着或恢复后）
timeline 1    A ●──────────────╳
                 │  │ 已复制到从库 B 的最新位置
                 │  └ 未传出的尾部 WAL = 分叉事务
                 ▼
timeline 2    B（promote，生成新时间线）●────────▶ 继续接受写入
                 ▲
                 └ A 恢复：其分叉事务必须丢弃（pg_rewind 回退或直接重建），
                   再作为 B 的从库跟随 timeline 2
```

- **PG**：每次 promote 生成新 timeline（WAL 文件名前 8 位十六进制即 timeline ID）。旧主恢复后若直接当从库会因分叉失败，需用 `pg_rewind` 回退掉分叉 WAL，或全量重建。
- **MySQL**：等价物是 GTID 集合。新主的 `Executed_Gtid_Set` 若不包含旧主已执行的事务，旧主重挂为从库时报错，需人工裁决跳过或重建（clone plugin 全量重建是干净做法）。
- 分叉事务里若有**已向客户端确认提交**的，才构成真实数据丢失；只有 fencing + 回退/重建流程可靠，才能保证分叉事务不会悄悄回流。

生产环境不要靠人肉执行上面的切换流程，用成熟的编排工具：PG 生态最常用的是 Patroni（把"谁是主"存在 etcd/Consul 等分布式配置中心，配合 fencing 语义自动 failover），MySQL 官方路线是 InnoDB Cluster（MySQL Shell + MySQL Router + MGR）。工具的价值不只是快，而是把 fencing 和重挂流程变成代码而不是凌晨三点的手抖。

## 八、复制 ≠ 备份

最后用一句话钉住最贵的误区：**复制防硬件故障，防不了人为错误**。`DROP TABLE`、`UPDATE ... WHERE` 写漏、勒索加密，都会在秒级被"高可用地"复制到每一个从库。真正能救回误操作的是独立的时间点恢复（PITR：基础备份 + 归档日志），见 [./15-backup-recovery.md](./15-backup-recovery.md)。

## 开发者清单

**该做：**

- 新项目上线前就启用 GTID / 规划复制拓扑——后补要在线变更流程或停机窗口，成本高一个数量级。
- 确认 `binlog_format=ROW`——CDC、在线改表、精确重放都依赖 row 格式。
- 大批量 `UPDATE`/`DELETE` 按主键分批执行——主库跑多久，从库就重放多久，大事务是延迟的第一来源。
- 读写分离从第一天就定义"哪些读必须走主库"——读己之写是语义问题，测试阶段就该覆盖。
- 复制延迟告警用字节差 / GTID 差交叉验证——单一时间戳指标会被长事务和时钟偏移欺骗。
- PG 使用复制槽必须配 `max_slot_wal_keep_size` 并监控 `wal_status`——从库失联 + 无限保留 = 主库磁盘写满。

**不该做：**

- 不要假设从库能读到刚写入的数据——异步复制对"写后立即可见"零承诺。
- 不要在从库上跑长事务/加锁查询/临时 DDL——阻塞回放线程，延迟雪崩会反噬读流量。
- 不要靠人工对比 binlog 位点做故障切换——用 GTID + 自动切换工具（Patroni、InnoDB Cluster 等），人在故障时刻是最慢的一环。
- 不要用"加从库"解决写延迟——复制解决可用性与读扩展，写吞吐瓶颈要靠分片（见 14 篇），加从库只增加主库 dump 压力。
- 不要把从库当作备份——误删会被忠实复制，见第八节。

## 常见误区

1. **"主从复制是实时同步，从库数据和主库永远一致。"** 异步复制只保证顺序一致（不乱序、不丢失），不保证时刻一致；落后量随负载波动，重放延迟以秒计很常见。
2. **"`Seconds_Behind_Master = 0` 就没有延迟。"** 长事务重放期间它可能显示 0，主从时钟偏移也会污染它；用 GTID 集合差或字节差交叉验证。
3. **"半同步 = 绝不丢数据。"** 半同步确认的是"至少一个从库收到"，且超时会自动降级异步；确认点（收到/落盘/回放）不同语义也不同——`remote_apply` 之前的确认点都存在"收到但未可查"的窗口。
4. **"从库越多，可用性和读能力越强。"** 每个从库增加主库一个 dump 线程与带宽开销；节点越多，failover 仲裁越复杂、读一致性越难（不同从库延迟不同，见 10 篇单调读）。
5. **"PG 逻辑复制可以完整搬家。"** DDL 不复制、序列不复制，订阅端要自己补 DDL、对齐序列值，否则一旦涉及序列生成的新行就会主键冲突。
6. **"failover 之后数据一定分叉。"** 分叉事务若从未向客户端确认过且被正确丢弃（fencing + rewind/重建），一致性可以恢复；真正的风险是未隔离的双写，而不是"切换"这个动作本身。

## 自测题

1. 复制为什么传日志而不是定期同步数据文件？给出三个理由。
   （顺序追加便宜；天然全序、重放确定；增量体积小。）
2. statement 格式在哪类语句下会导致主从不一致？举两个例子。
   （`NOW()`/`UUID()` 等不确定性函数；无 `ORDER BY` 的 `LIMIT` 更新/删除在从库选错行。）
3. AFTER_SYNC 为什么叫"无损"？它与 AFTER_COMMIT 在动作顺序上差在哪一步？
   （收到从库 ACK 后才提交存储引擎并返回客户端；AFTER_COMMIT 是先提交再等 ACK，等待期其他会话可见该事务，存在幻读风险。）
4. PG 的 `FIRST 2 (s1,s2,s3)` 与 `ANY 2 (s1,s2,s3)` 在可用性上有什么差别？
   （FIRST 锁定前两个，二者同时故障会阻塞主库写；ANY 任意两个确认即可，容忍任意一台故障。）
5. 从库延迟 10 分钟，列出最可能的三个原因。
   （大事务重放；回放并行度不足；网络带宽/从库硬件弱；从库锁等待。任三。）
6. 为什么 PG 物理复制不能跨大版本，逻辑复制可以？
   （物理回放依赖磁盘块布局与 WAL 格式逐版本兼容；逻辑流是解码后的行级变更，只需协议兼容。）
7. 什么是脑裂？列出至少两种 fencing 手段。
   （双主同时接受写导致数据分叉；STONITH、第三方租约仲裁、旧主自愈只读。）

## 关联阅读

- [./06-wal-recovery.md](./06-wal-recovery.md)——binlog/WAL 的物理结构，本篇日志流的上游。
- [./03-transaction-acid.md](./03-transaction-acid.md)——durability 的定义，复制确认点决定了它的实际强度。
- [./08-buffer-pool.md](./08-buffer-pool.md)——从库回放与读流量在缓冲池里的争抢。
- [./14-partition-shard.md](./14-partition-shard.md)——复制解决可用性/读扩展，分片解决写容量，别混用。
- [./15-backup-recovery.md](./15-backup-recovery.md)——"复制 ≠ 备份"的完整论证与 PITR。
