# 12 · 连接管理与线程/进程模型（Connections & Process Model）

> 每一条数据库连接都不是免费的：TCP 握手、认证、服务端一个线程或进程、起步就是几百 KB 到几 MB 的内存。本篇讲清一条连接的完整生命周期、MySQL 线程模型与 PostgreSQL 进程模型的差异、连接数打满的算术与急救流程，以及应用内连接池与 PgBouncer 这类中间件池分别解决什么问题。参数与默认值以 MySQL 8.0 / PostgreSQL 16 为准。

## 读完本篇你应能回答

- 一条连接从 TCP 到可执行 SQL 要经过哪些步骤，各是什么量级的耗时？
- MySQL 的每连接一线程与 PG 的每连接一进程，各自的内存与调度成本、稳定性差异？
- 为什么「每请求一连接」不可行？连接数打满时是什么症状、怎么急救？
- 应用内连接池和中间件池（PgBouncer 等）分别解决什么问题？池大小怎么定？
- PgBouncer 三种 pool mode 有什么语义陷阱？
- 连接泄漏与 idle in transaction 怎么发现、怎么防？

## 一条连接的生命周期

### 直觉

像进一栋写字楼：TCP 握手是敲开大门，TLS 是出示访客证，认证是刷工卡，服务端创建会话是给你安排工位（一个线程/进程加一套内存）——工位不便宜，而你要办的事可能只是取一份 20 行的报表。

### 结构

```text
 客户端                        服务端
   │
   │──── 1. TCP 三次握手 ─────────▶        ≈ 1 RTT
   │◀─── 2. TLS 握手（可选）──────         ≈ 1~2 RTT
   │
   │──── 3. 认证 ───────────────▶         PG：scram-sha-256（默认）
   │                                       MySQL：caching_sha2_password（8.0 默认）
   │
   │      [4. 服务端创建会话]
   │       MySQL：起一个线程（栈默认 256KB 起）
   │       PG：fork 一个 backend 进程（内存以 MB 计）
   │
   │──── 5. SQL：权限检查 → 执行 ──▶       单条 SQL：几十 µs ~ ms
   │◀─── 结果集 / 错误
   │
   │──── 6. 断开 ─────────────────▶       销毁线程/进程，回收全部会话内存
```

### 机制

各步成本（数量级；本地回环最快，跨网络每步都要加 RTT）：

| 步骤 | 做什么 | 典型耗时 |
|---|---|---|
| TCP 握手 | 建立可靠通道 | 1 RTT（同机房 <1ms，跨地域几十 ms） |
| TLS 握手 | 协商加密与身份（TLS 1.2 约 2 RTT，1.3 约 1 RTT） | 1~2 RTT |
| 认证 | PG 16 默认 scram-sha-256：质询-响应式，口令不明文上路；MySQL 8.0 默认 caching_sha2_password：首次完整认证，之后服务端留缓存走快速认证 | 1 RTT + 双方各一次哈希计算（亚毫秒） |
| 会话创建 | MySQL 起线程服务该连接；PG 由 postmaster `fork()` 出 backend 进程 | MySQL：微秒到毫秒级；PG：fork 毫秒级 |
| SQL 执行 | 权限检查、解析（可复用缓存）、执行 | 主键点查几十 µs ~ 几 ms |

关键对比：**建立连接是毫秒级、跨网络甚至几十毫秒级；一次简单查询是几十微秒级。** 如果每个请求都新建连接，「进门」可能比「办事」贵 100~1000 倍。而且第 4 步的工位在连接断开前一直占着内存和调度槽位。这就是连接池存在的全部理由：把「进门 + 安排工位」的成本摊销到成千上万次请求上。

每一步在服务端都留有计数器——握手失败、认证失败、连接打满是三种不同的问题，别混为一谈：

```sql
-- MySQL：握手/认证失败与连接打满分别计数
SHOW GLOBAL STATUS WHERE Variable_name IN
 ('Aborted_connects','Connection_errors_max_connections',
  'Threads_connected','Threads_running');
```

```sql
-- PostgreSQL 16：累计建立的连接数、当前 backend 数与会话统计
SELECT numbackends, connections, sessions,
       round(session_time::numeric / 1000 / 60) AS session_time_min
FROM pg_stat_database
WHERE datname = current_database();
```

`Aborted_connects` / `Connection_errors_*` 增长指向网络或认证问题；`connections` 突增而 `numbackends` 居高不落，指向泄漏或重试风暴。

### 对开发者的实际影响

「每请求一连接」的写法（请求进来 new 一个客户端、用完就丢）在流量上来时的表现非常固定：CPU 花在握手与线程/进程创建上、连接数瞬间打满、P99 飙高。哪怕只改一件事——换成进程内长连接 + 池——也常能把这类系统的 P99 压掉一个数量级。

## 两大模型：MySQL 每连接一线程 vs PostgreSQL 每连接一进程

### 直觉

MySQL 是「每个客人配一个服务员（线程）」；PG 是「每个客人包一个独立包间（进程）」。服务员更轻、更省，包间更隔离、更不容易互相连坐。

### 机制：MySQL——每连接一线程

- 默认 `thread_handling = one-thread-per-connection`：每个连接由一个服务端线程全程服务，连接断开、线程销毁。
- 每线程基础成本：栈默认 256KB（`thread_stack`，64 位 Linux / MySQL 8.0），加上按需分配的会话缓冲（`sort_buffer_size`、`join_buffer_size` 等，见 13 篇）。1000 个空闲连接仅栈就约 256MB。
- 所有线程共享同一进程地址空间：单个连接的内存越界理论上能带崩整个实例，故障域大；几千线程时 OS 线程调度与上下文切换开始可观测地吃 CPU。
- 官方的 Enterprise Thread Pool（线程池）是商业版特性；Percona Server 与 MariaDB 提供开源线程池插件。社区版 MySQL 的高连接数场景，标准答案是外部连接池。

### 机制：PostgreSQL——每连接一进程

- 主进程 postmaster 监听端口，每接受一条连接就 `fork()` 一个 backend 进程全程服务。所有 backend 通过共享内存（`shared_buffers` 等）协作，连接私有内存各自独立。
- 每连接成本更高：fork 毫秒级；空闲 backend 私有内存以 MB 计（典型 5MB 上下，随加载的目录缓存与扩展增长），活跃后再叠加 work_mem 工作区（13 篇）。
- 进程隔离带来稳定性红利：一个 backend 崩溃只死它自己，postmaster 会保住其余连接（崩溃重启的场景除外，那会短暂全断）。
- 上千连接时，每进程的内存放大与 OS 进程调度成为主要矛盾。所以 PG 圈子的共识是：`max_connections` 保持在几百以内，并发靠连接池撑。
- PG 不改成线程模型不是历史包袱，是明确接受的取舍：进程隔离让崩溃的 C 扩展函数只死一个连接；并行查询的每个 worker 也是独立进程，直接复用同一套机制；共享内存的并发协议因此保持简单。换来的是连接更贵、要配 pooler。

| 维度 | MySQL 8.0（每连接一线程） | PostgreSQL 16（每连接一进程） |
|---|---|---|
| 服务载体 | 服务端线程 | fork 出的 backend 进程 |
| 每连接基础内存 | 约 256KB 栈 + 按需会话缓冲 | 数 MB 私有内存起步 |
| 创建成本 | 微秒~毫秒级 | fork 毫秒级 |
| 隔离性 | 同进程共享地址空间，故障域大 | 进程隔离，单 backend 崩溃不连坐 |
| 内置池化方案 | 无（线程池是企业版特性） | 无（官方方向是外部 pooler） |
| 几千连接的表现 | 内存尚可，调度开始劣化 | 内存先扛不住：2000 × 5MB = 10GB 起步 |
| `max_connections` 默认 | 151 | 100 |

两边共同的结论：**连接是稀缺资源，几百是舒适区，几千必须上池化。**

## 连接数上限与资源算术

### 上限与预留

- MySQL `max_connections` 默认 151；PG 默认 100，另有 `superuser_reserved_connections`（默认 3）留给超级用户应急。
- 打满的报错都很有名：MySQL `ERROR 1040 (HY000): Too many connections`；PG `FATAL: sorry, too many clients already`。
- MySQL 打满后，持 `CONNECTION_ADMIN`（SUPER）权限的账号还能再进 1 条——这就是你的应急通道。

### 内存算术：调大 max_connections 之前必做

```text
理论最坏私有内存 ≈ 连接数 ×（每连接基础内存 + 会话/操作缓冲峰值）

PG 例：500 连接 ×（5MB 基础 + 峰值 3 节点 × 64MB work_mem）
      ≈ 500 × 197MB ≈ 98GB   ← 最坏口径；说明全局调大 work_mem 的危险（→ 13 篇）

MySQL 例：1000 连接 ×（256KB 栈 + 峰值 sort 2MB + join 2MB）
        ≈ 1000 × 4.3MB ≈ 4.3GB   ← 同样是最坏口径
```

算完内存还要过文件描述符：每条连接占 1 个 socket fd；PG 每进程另有 `max_files_per_process`（默认 1000）限制；OS 层的 `ulimit -n`、systemd 的 `LimitNOFILE` 都可能是隐形天花板。

一个具体的容量表（8 核 16GB、PG 库）：

- 应用 12 个实例 × 池上限 10 = 120 条
- 定时任务 2 个 × 5 条 = 10 条
- 运维 / 监控预留 10 条
- 合计 140 条 → `max_connections = 180`（留约 20% 余量），加 `superuser_reserved_connections = 3`

内存侧核对：140 ×（5MB 基础 + 平均 1 节点 × 4MB work_mem）≈ 1.3GB，对 16GB 很安全。哪天想把 work_mem 全局调到 64MB，这张表立刻变成约 9.6GB——重算容量表就是任何连接/内存类调参的前置步骤。

### 打满的应急流程

1. 用预留通道连进去（PG 用超级用户；MySQL 用持 CONNECTION_ADMIN 的账号）。
2. 先杀空闲、保业务：

```sql
-- PostgreSQL：终止空闲超过 5 分钟的连接
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle'
  AND state_change < now() - interval '5 minutes'
  AND pid <> pg_backend_pid();
```

```sql
-- MySQL：看谁占着连接，再按 id 终止
SELECT id, user, host, db, command, time, state, left(info, 60) AS sql_text
FROM information_schema.processlist
ORDER BY time DESC;

KILL <id>;
```

3. 若预留通道也被占（例如被脚本用光），最后手段是经跳板机在 OS 层终止空闲连接（PG kill 对应 backend 进程、MySQL `KILL`），并可临时收紧 `pg_hba.conf` / 账号来源阻断问题端。
4. 事后必查三件事：谁在泄漏（见下节）；`max_connections` 是不是被「连了不还」撑爆的；应用重试风暴有没有火上浇油——连接风暴的典型剧本：一次抖动 → 全体客户端同时重连重试 → 连接打满 → 更大的抖动。重试必须有退避（backoff）与上限。

## 连接池：两层方案

### 结构

```text
 应用 A（池上限 10）──┐
 应用 B（池上限 10）──┼──▶┌────────────────┐        ┌─────────────────────┐
 应用 C（池上限 10）──┘   │   PgBouncer     │        │ PostgreSQL          │
                          │   pool_mode =  │──────▶ │ max_connections=100 │
 批处理 / Serverless ───▶ │   transaction  │  ~30 条 └─────────────────────┘
 （不便常驻进程内池）      └────────────────┘  后端连接

 应用内池管「单个进程怎么复用连接」；中间件池管「后端真实连接总数」。
 两层不冲突，规模上来后通常都要有。
```

### 应用内池

HikariCP、Node 的 `pg.Pool`、Prisma 内置池的可调项大同小异：

| 配置 | 含义与建议 |
|---|---|
| max（池大小） | 不是越大越好：经验起点是 CPU 核数的 2~4 倍，再压测校准；超过吞吐拐点后，数据库端上下文切换与锁争用开始主导，连接再多只贡献等待 |
| maxLifetime / idleTimeout | HikariCP 的 maxLifetime 默认 30 分钟。给连接设寿命，防「半死连接」（防火墙静默断开、故障切换后的僵尸连接）；要小于数据库端 `wait_timeout` 类 idle 限制 |
| connectionTimeout | 借不到连接的等待上限，到期抛错，避免请求无界排队 |
| leakDetectionThreshold | HikariCP：借出超过 N 毫秒未还即告警（如 60000）——连接泄漏的第一道网 |

Node 的 `pg.Pool` 默认 `max: 10`；Prisma 用连接串参数 `connection_limit=` 控制（默认约 CPU 核数 × 2 + 1）。多实例部署时记住：**真实连接数 = 每实例池大小 × 实例数**，扩容实例数就是在调大数据库连接数。

```js
// Node（pg）：池的最小可用配置
const { Pool } = require('pg');
const pool = new Pool({
  max: 10,                        // 上限：从 CPU 核数 × 2~4 起步压测
  idleTimeoutMillis: 30_000,      // 空闲连接回收
  connectionTimeoutMillis: 5_000, // 借不到连接 5s 后抛错，而不是无限排队
});
```

```properties
# HikariCP（示例）：连接寿命必须小于数据库端 idle 超时
maximumPoolSize=10
maxLifetime=1500000
leakDetectionThreshold=60000
```

### 中间件池：PgBouncer 与 MySQL 侧方案

PgBouncer 是轻量级 PostgreSQL 连接池中间件，核心是三种 pool mode：

| pool mode | 后端连接绑定多久 | 客户端并发上限 | 语义完整性 |
|---|---|---|---|
| session | 客户端连接存续期独占一条后端连接 | ≈ 后端连接数 | 完整，但池化收益最小 |
| transaction | 事务期间绑定，事务结束即归还 | ≈ 同时活跃的事务数 | 有会话语义陷阱（最常用） |
| statement | 每条语句执行完即归还 | ≈ 同时执行的语句数 | 最激进；多语句事务直接报错 |

transaction 模式的价值：2000 个客户端连接可以被压缩到几十条后端连接上，`max_connections` 的压力立刻消失。但「一条客户端连接」不再等于「一个后端会话」，这些玩法会踩坑：

| 会话级玩法 | transaction 模式下的问题 | 替代方案 |
|---|---|---|
| `SET work_mem = ...` | 设置落在后端连接上，会串给下一个客户端 | 事务内 `SET LOCAL`（结束自动还原） |
| SQL 级 `PREPARE` | 预备语句绑定在某条后端连接上 | 协议级预备语句（PgBouncer ≥ 1.21，配 `max_prepared_statements`），或改写 SQL |
| `LISTEN / NOTIFY` | 通知发到「此刻占着后端连接的人」 | session 模式，或换消息队列 |
| 会话级 advisory lock（应用层主动申请的命名锁，不锁定任何数据行，常用于应用级互斥） | 锁跟着后端连接走，可能被别的客户端释放 | 事务级 `pg_advisory_xact_lock`，或 session 模式 |
| 临时表 / WITH HOLD 游标 | 会话状态跨事务即失效 | transaction 模式下不用；改用常规表 |

注：SQL 级 `PREPARE` 是用 SQL 语句手工创建的预备语句，协议级预备语句是驱动在协议层自动管理的预备语句——二者在 transaction 池化下都可能跨连接错位。

MySQL 生态的对应物一句话定位：ProxySQL 是协议感知的 MySQL 代理（连接复用 + 路由 + 规则改写），RDS Proxy 是云厂商托管版（池化 + 故障切换时保住应用连接），应用侧都不用改代码。

### 连接数与吞吐的关系

```text
 吞吐
  │            ╭─────╮
  │          ╱        ╲
  │        ╱            ╲
  │     ╱                ╲
  │   ╱                    ╲
  └────────────────────────────▶ 连接数
     舒适区            饱和区
   （≈核数×2~4）    上下文切换与缓存失效主导，
                    吞吐反降、尾延迟陡增
```

所以「池调大点总没坏处」是错的：池大小的目标不是「够大」而是「刚好」——压测找到吞吐拐点，通常落在 CPU 核数的 2~4 倍附近。

## 连接泄漏与 idle in transaction

### 连接泄漏：症状与排查

症状很有辨识度：连接数曲线以每天几十上百条的速度爬升，重启应用立刻回落。根因几乎都是代码里借了连接没还：异常路径漏掉 `release`、事务开启后提前 return、finally 缺失。

```sql
-- PostgreSQL：先看连接都停在哪
SELECT state, count(*) AS cnt,
       max(now() - state_change) AS longest_in_state
FROM pg_stat_activity
GROUP BY state
ORDER BY cnt DESC;
-- 大量 'idle' 且 client_addr 来自应用机 → 应用侧泄漏
-- 大量 'idle in transaction' → 事务开了没提交，见下节
```

```sql
-- MySQL：Command=Sleep 且 Time 很大的就是闲置连接
SELECT command, count(*) AS cnt, max(time) AS max_idle_s
FROM information_schema.processlist
GROUP BY command;
```

应用侧同步开泄漏检测（HikariCP `leakDetectionThreshold=60000` 之类），在压测环境就该跑起来，别等到生产数连接。

### idle in transaction：不只是占坑

事务开启后应用去干别的事——调外部 HTTP、发消息、等人工操作——连接就停在 `idle in transaction` 状态。危害是三重的：

- 占住锁，别的会话排队（→ 05 篇）；
- 占住事务快照，VACUUM 无法清理其后的死元组，表持续膨胀（→ 04 篇）；
- 占住一个连接名额，放大连接泄漏。

防护：

```sql
-- PostgreSQL 16：空闲事务超时（默认 0 不启用），超时连接被服务端终止
ALTER SYSTEM SET idle_in_transaction_session_timeout = '5min';
SELECT pg_reload_conf();   -- 对新会话生效
```

配套纪律：应用要能优雅处理连接被终止（错误处理后重连重试）；「事务内不做慢 IO」写进代码规范。PG 14+ 另有 `idle_session_timeout` 管纯闲置连接。MySQL 没有内置的空闲事务超时（`wait_timeout` 默认 28800 秒，只管纯空闲），惯例是 pt-kill 类工具兜底加应用侧框架超时。

## Serverless 场景：连接暴增与托管代理

函数计算 / Serverless 的每个执行实例都可能带着自己的小连接池，实例随流量伸缩到成百上千——「实例数 × 每实例小池」的乘法一算，`max_connections` 必然打满。举例：函数平台扩到 500 个实例、每实例 5 条连接，瞬时就是 2500 条，超过两库默认上限一个数量级；而这类场景又没法部署常驻的应用内池。标准解法是把池化下沉到数据库前面一层托管代理：AWS RDS Proxy（自动池化，故障切换时保住应用连接）、Supabase 的 supavisor（transaction 模式的托管 pooler）等。对应用的卖点是：不改代码，真实连接数被压缩到常数级；代价是多一跳延迟（通常亚毫秒到毫秒级）和 transaction 模式那套会话语义限制（ PgBouncer 一节的陷阱表同样适用）。一句话定位：Serverless 与数据库之间，几乎总该隔一层 transaction 模式的代理。

## 开发者清单

该做：

- 任何长驻服务都用进程内连接池，池大小从 CPU 核数 × 2~4 起步压测校准。
- 给连接设 maxLifetime，且小于数据库端的 idle 超时，防半死连接。
- 压测阶段就开启池的泄漏检测（如 60s 阈值）。
- 多实例部署按「实例数 × 每实例池大小 < max_connections」维护容量表，扩容前先核对。
- PG 库设置 `idle_in_transaction_session_timeout`，并保证应用能处理连接被终止。
- 事务内绝不调外部 HTTP、发消息或等待人工输入。
- 把连接数曲线纳入日常监控（11 篇八项之一）：斜率就是泄漏速度，异常爬升当天就能发现。

不该做：

- 不要每请求建连——哪怕「只是个小脚本」，脚本会被 cron 高频拉起。
- 不要把池调到「看起来够大」就收工；超过吞吐拐点后是负收益。
- 不要用超管账号跑应用；应急通道要留给真正的应急。
- 不要在 PgBouncer transaction 模式下用会话级 SET、会话级 advisory lock、LISTEN/NOTIFY。
- 不要在事务里 return 或抛异常而不回滚/关闭——这就是 idle in transaction 的全部来源。
- 不要无退避地重试失败连接；重试风暴能把一次抖动放大成一次事故。
- 不要在生产「应急调大 max_connections」而不查泄漏——那只是把打满时刻往后推。

## 常见误区

1. **「连接越多并发能力越强」**。超过 CPU 承载后，多出来的连接只贡献上下文切换与锁等待，吞吐反而下降；拐点常在核数的 2~4 倍附近。
2. **「PG 每连接一进程是落后设计」**。进程模型换来了故障隔离（单 backend 崩溃不连坐）与共享内存并发的简单语义，代价是连接更贵——所以才有「PG 必配 pooler」的工程共识。
3. **「MySQL 官方有线程池，开一下就行」**。社区版没有：线程池是 Enterprise Edition 特性；开源替代是 Percona / MariaDB 的插件或外部代理。
4. **「连接打满是数据库的锅」**。多数打满是应用侧泄漏或重试风暴推起来的；先看 `pg_stat_activity` / processlist 里连接的来源与状态，再谈数据库参数。
5. **「PgBouncer transaction 模式即插即用」**。SET、SQL 级 PREPARE、LISTEN/NOTIFY、会话级 advisory lock 都会踩语义坑；上线前按陷阱表逐项过用法。
6. **「idle in transaction 只是浪费一个连接」**。它还占锁、挡 VACUUM 造成表膨胀，是慢查询之外最常见的慢性病来源。

## 自测题

1. 建连与执行一次主键点查的成本差多少量级？这决定了什么架构选择？（毫秒~几十毫秒 vs 几十微秒；决定了必须连接复用即池化）
2. MySQL 与 PG 各用什么模型服务一条连接？每连接基础内存大约多少？（线程 / 进程；约 256KB 栈起 / 数 MB 起）
3. `max_connections` 默认值分别是多少？打满后各自的应急通道？（151 / 100；MySQL 持 CONNECTION_ADMIN 账号可再进 1 条，PG 预留 `superuser_reserved_connections=3`）
4. 为什么池大小不是越大越好？经验区间？（超过 CPU 承载后上下文切换与争用主导、吞吐反降；核数 × 2~4 起步压测）
5. PgBouncer 三种 pool mode 各绑定多久？transaction 模式下 `SET` 为什么危险？（session / 事务 / 单条语句；SET 落在后端连接上会串给别的客户端，应改 `SET LOCAL`）
6. idle in transaction 的三重危害？PG 用哪个参数防护？（占锁、挡 VACUUM 致表膨胀、占连接；`idle_in_transaction_session_timeout`）
7. Serverless 为什么必然打满连接数？托管代理解决什么？（实例数 × 每实例小池的乘法；把复用下沉到数据库前的代理层，真实连接数变常数）
8. `Aborted_connects` 与 `Connection_errors_max_connections` 分别反映什么？（前者是握手/认证失败，后者是到达时连接数已满被拒——排查方向完全不同）

## 关联阅读

- [11 · 性能调优基础](./11-performance-tuning.md)：连接数是监控基线八项之一，本篇是它的展开。
- [13 · 内存管理与排序/哈希](./13-memory-sort-hash.md)：每连接内存缓冲的细节与最坏内存公式。
- [03 · 事务与 ACID](./03-transaction-acid.md) / [04 · 并发控制与 MVCC](./04-mvcc.md)：idle in transaction 为什么占锁、为什么挡 VACUUM。
- [05 · 锁与阻塞](./05-lock.md)：锁等待与死锁的排查路径。
- [09 · 复制与高可用](./09-replication-ha.md)：故障切换时连接与重试风暴的相互作用。
- [16 · 安全与权限](./16-security.md)：scram-sha-256 / caching_sha2_password 与最小权限账号。
