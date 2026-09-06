# 14 · 分区与分表（Partitioning & Sharding）

> 表涨到数亿行后，"加索引"不再是万能答案：B+ 树变高、缓冲池装不下热点页、归档用的 `DELETE` 一跑几十分钟还把主从延迟拉爆。本篇讲清三条不同的"拆表"路线——水平分区（partitioning）、垂直拆表、分库分表（sharding）——各自的机制、收益边界与真实代价，让你能回答"该不该拆、拆到哪一层、拆完要付出什么"。

## 读完本篇你应能回答

- 分区、垂直拆表、分库分表分别解决什么问题，为什么不能互相替代？
- 分区裁剪（partition pruning）何时生效，如何用 `EXPLAIN` 验证？
- 为什么 MySQL 强制"分区键必须包含在所有唯一键里"？
- 出现什么信号才需要分库分表？在此之前应先走完哪些步骤？
- 分库分表的代价清单是什么，扩容迁移为什么必须"先双写"？

## 一、先把三个概念分清

**直觉**：同样是"图书馆的书太多"，有三种整理法——

- 水平分区：同一馆内按年份分房间，读者查的还是同一个总目录（对应用透明）；
- 垂直拆表：把厚重的"详细摘要卡片"挪去另一个柜子，主柜只留常翻字段；
- 分库分表：直接开分馆，读者必须先知道书在哪一家馆（应用或中间件显式路由）。

| 维度 | 水平分区（Partitioning） | 垂直拆表 | 分库分表（Sharding） |
|---|---|---|---|
| 拆分对象 | 行：按分区键路由到物理分区 | 列：冷热列、大字段分家 | 行：跨实例分布 |
| 是否跨实例 | 否（同一实例、同一个库） | 通常同库 | 是（多实例、多库） |
| 对应用 | 完全透明，仍是一张逻辑表 | 半透明，需 join 或应用组装 | 显式，路由层可见 |
| 主要收益 | 缩小扫描范围、秒级归档 | 缓冲池密度、行宽、锁范围 | 突破单实例写吞吐与存储上限 |
| 典型场景 | 按月的时间序列、订单流水 | 宽表 + TEXT/JSON 大字段 | 海量用户/租户级数据 |

三者不能互相替代：分区与垂直拆表是"实例内"优化，不改变系统拓扑与可用性模型；分库分表改变架构拓扑，是最重的手段，也应当是最后的选择。

## 二、水平分区：价值与边界

### 直觉

分区把一张逻辑表拆成多个物理存储单元，对外仍是一张表。查询条件命中分区键时只需扫相关分区——查"9 月的账单"不必翻整年的账本。

### 结构：分区裁剪

```text
SELECT * FROM events
 WHERE created_at >= '2026-09-01' AND created_at < '2026-09-08';

逻辑表 events（查询只看到这一张表）
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐
│  events_   │  │  events_   │  │  events_   │  │ events_  │
│   2026_08  │  │   2026_09  │  │   2026_10  │  │ default  │
└────────────┘  └────────────┘  └────────────┘  └──────────┘
   剪掉            保留(只扫它)     剪掉            剪掉

不带 created_at 条件 → 四个分区全部要扫，分区数即放大系数
```

### 机制细节

- **裁剪条件**：优化器能从谓词推出分区键的取值范围或列表（RANGE/LIST），或计算出 HASH 的目标分区，才能裁剪。`WHERE created_at >= '2026-09-01'` 可以；`WHERE lower(name) = 'x'` 对按 `created_at` 分区的表毫无帮助。
- **计划时裁剪 vs 执行时裁剪**：常量条件在生成计划时裁剪；绑定参数（如 `WHERE created_at >= $1`）在 PostgreSQL 中于执行初始化时裁剪（执行计划里未扫分区标 `(never executed)`），MySQL 同样支持执行期确定分区。两种都能省扫描，但只有前者在 `EXPLAIN` 计划结构里"消失"得干净。
- **验证方法**：永远用 `EXPLAIN` 确认，不要靠猜（见第三、四节的数据库示例）。

### 边界：分区不是银弹

1. **不带分区键的查询扫全部分区**。一张 60 个分区的表，`WHERE user_id = 42` 要开 60 棵 B+ 树各查一次；分区数同时放大优化器与锁的开销（PostgreSQL 一次打开大量分区可能触碰 `max_locks_per_transaction` 上限；MySQL 单表分区数上限 8192，含子分区）。
2. **每个分区是一套独立的 B+ 树**。所谓"分区表上的索引"是每个分区各自一份的本地索引（local index），两个数据库都没有跨分区全局索引。分区了照样要建索引；不带分区键的查询能不能走索引，与分区前没有区别。
3. **跨分区唯一性无法用索引保证**（这是 MySQL 唯一键约束的根源，见第四节）。

### 运维收益：归档从小时级降到秒级

| 操作 | 机制 | 千万行量级耗时 | 副作用 |
|---|---|---|---|
| `DELETE FROM events WHERE created_at < '...'` | 逐行标记删除，后台 purge 回收（purge＝InnoDB 后台线程把标记删除的行真正物理回收，04/06 篇） | 分钟到小时 | 大量 undo/redo/binlog，主从延迟激增，页内留下空洞 |
| MySQL `ALTER TABLE ... DROP PARTITION` | DDL，直接丢弃该分区的存储段 | 亚秒到秒 | 隐式提交，期间拿表级元数据锁 |
| PostgreSQL `ALTER TABLE ... DETACH PARTITION` | 把分区从逻辑表上摘下，数据不动 | 亚秒到秒 | 摘下后成为普通表，可导出归档再删 |

对时间序列数据（日志、事件、订单流水），"按月分区 + 到期 DROP/DETACH"是标准做法：归档操作从数小时的批处理变成一条秒级 DDL。

## 三、PostgreSQL 16：声明式分区

PostgreSQL 10 起提供声明式分区（declarative partitioning）：分区本身就是一张普通表，可以单独插入、单独建索引、单独 `COPY` 导数据。

### 三种策略与建表

```sql
-- PostgreSQL 16：按时间范围分区（最常见）
CREATE TABLE events (
    id          bigint       NOT NULL,
    user_id     bigint       NOT NULL,
    payload     jsonb,
    created_at  timestamptz  NOT NULL
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_09 PARTITION OF events
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');   -- 上界不含
CREATE TABLE events_2026_10 PARTITION OF events
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- 兜底分区：接收不匹配任何分区的行（避免插入报错）
CREATE TABLE events_default PARTITION OF events DEFAULT;

-- 主键/唯一约束必须包含分区键，否则报错
ALTER TABLE events ADD PRIMARY KEY (id, created_at);

-- 哈希分区（用于按 user_id 均匀打散，没有天然时间维度的表）
CREATE TABLE users_by_hash (user_id bigint NOT NULL, info jsonb)
    PARTITION BY HASH (user_id);
CREATE TABLE users_p0 PARTITION OF users_by_hash
    FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE users_p1 PARTITION OF users_by_hash
    FOR VALUES WITH (MODULUS 4, REMAINDER 1);
-- ... REMAINDER 2 / 3
```

LIST 分区同理（`PARTITION BY LIST (region)` + `FOR VALUES IN ('cn', 'jp')`），适合枚举值稳定的地域、租户类维度。

注意 DEFAULT 分区的连带成本：往已有 DEFAULT 分区的表上 `ATTACH` 新分区时，PostgreSQL 必须检查 DEFAULT 分区里是否有属于新分区的行，数据多时是一次全量扫描。

### 索引与约束的传播

在分区父表上建索引/主键，会自动传播为每个分区的本地索引，父表上的"分区索引"只是目录，不含数据——再次印证：没有跨分区的全局索引。

### 用 EXPLAIN 验证裁剪

```sql
-- PostgreSQL 16
EXPLAIN SELECT count(*) FROM events
 WHERE created_at >= '2026-09-01' AND created_at < '2026-09-08';
-- 计划只出现 Seq Scan on events_2026_09：裁剪生效

EXPLAIN SELECT count(*) FROM events WHERE user_id = 42;
-- 计划出现全部分区：user_id 不是分区键，裁剪失效

-- 对比开关，量化收益
SET enable_partition_pruning = off;   -- 默认 on
```

### 分区维护：ATTACH/DETACH 实现在线归档与零拷贝迁移

```sql
-- 到期归档：摘下 8 月分区（PG 14+ 可 CONCURRENTLY，避免阻塞查询）
ALTER TABLE events DETACH PARTITION events_2026_08 CONCURRENTLY;

-- 摘下的分区成为独立表：导出走对象存储/数仓后删除
COPY events_2026_08 TO '/archive/events_2026_08.csv' WITH (FORMAT csv);

-- 反向操作：把一张结构与约束一致的普通表挂回分区树（零数据拷贝）
ALTER TABLE events ATTACH PARTITION events_2026_08
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

`ATTACH`/`DETACH` 只改目录元数据、不搬数据，这是"大表在线迁移到新存储"的零拷贝基础——零拷贝说的是 ATTACH/DETACH 操作本身只改元数据、不动数据，跨机迁移时数据只需复制一次：在新机器建好表 → 复制数据 → 校验后 ATTACH 挂回原实例的分区母表。

### 分区不会自动创建

PostgreSQL 原生不会自动建未来分区，插入时无匹配分区即报错（有 DEFAULT 分区则落入兜底）。两种解法：

- 扩展 [pg_partman](https://github.com/pgpartman/pg_partman) 配合定时任务（pg_cron）自动预建；
- 应用或运维脚本提前建好未来 N 个月分区，监控缺分区的告警。

## 四、MySQL 8.0：分区

### 类型与建表

MySQL 8.0 支持 RANGE、LIST、HASH、KEY 四类（InnoDB 才支持原生分区），RANGE/LIST 的分区函数必须返回整数（`TO_DAYS()`、`YEAR()`），或改用 `RANGE COLUMNS` 直接比较列值：

```sql
-- MySQL 8.0：按月 RANGE 分区
CREATE TABLE orders (
    id          BIGINT       NOT NULL,
    user_id     BIGINT       NOT NULL,
    amount      DECIMAL(12,2) NOT NULL,
    created_at  DATETIME     NOT NULL,
    PRIMARY KEY (id, created_at)          -- 分区键必须包含在主键里，见下文
) PARTITION BY RANGE COLUMNS (created_at) (
    PARTITION p202609 VALUES LESS THAN ('2026-10-01'),
    PARTITION p202610 VALUES LESS THAN ('2026-11-01'),
    PARTITION pmax     VALUES LESS THAN (MAXVALUE)
);

-- 哈希打散（无时间维度时）
CREATE TABLE shards_demo (id BIGINT NOT NULL, PRIMARY KEY (id))
    PARTITION BY HASH(id) PARTITIONS 8;

-- KEY 分区：用 MySQL 内部哈希，可多列，不指定列时要求表有主键
CREATE TABLE shards_key (id BIGINT NOT NULL, PRIMARY KEY (id))
    PARTITION BY KEY(id) PARTITIONS 8;
```

MySQL 没有 DEFAULT 分区，惯例是加一个 `pmax` 兜底；从 `pmax` 里"拆"出新月分区要用 `ALTER TABLE ... REORGANIZE PARTITION`，若 `pmax` 已堆积数据则会发生数据搬迁——所以要预建分区，别等数据落进 `pmax`。

### 硬约束：分区键必须包含在所有唯一键里

```sql
-- MySQL 8.0：直接用 id 做主键 + 按 created_at 分区 → 失败
CREATE TABLE bad (
    id BIGINT PRIMARY KEY,
    created_at DATETIME NOT NULL
) PARTITION BY RANGE COLUMNS (created_at) (...);
-- ERROR 1503 (HY000): A PRIMARY KEY must include all columns
-- in the table's partitioning function
```

**为什么**：`PRIMARY KEY(id)` 承诺 id 全表唯一，但插入新行时必须检查"这个 id 是否已存在于其他分区"。分区索引是每分区一套的本地索引，没有任何一棵索引能看到全部分区——唯一性无法跨分区验证。数据库只能强制分区键进唯一键，把唯一性约束收缩到"分区内唯一 + 分区键联合唯一"（`(id, created_at)` 联合主键意味着不同分区允许出现相同 id）。PostgreSQL 同理：分区表的 `PRIMARY KEY`/`UNIQUE` 必须包含分区键列。

推论：需要全局唯一 id 的分区表，id 要靠应用或发号器保证（自增列在单实例内仍唯一，但语义上已不构成约束）。

### EXPLAIN 的 partitions 列

```sql
-- MySQL 8.0
EXPLAIN SELECT * FROM orders WHERE created_at < '2026-09-15';
-- partitions 列显示 p202609：裁剪生效
EXPLAIN SELECT * FROM orders WHERE user_id = 42;
-- partitions 列列出全部分区：裁剪失效

-- 也可以显式指定分区（绕过优化器）
SELECT COUNT(*) FROM orders PARTITION (p202609);
```

## 五、垂直拆表：按列分家

**直觉**：一张 120 列的宽表，日常查询只用 12 列，剩下 108 列（大都是低频的 TEXT/JSON 详情）却让每个缓冲页装不下几行——冷数据把热数据挤出缓冲池。

```text
拆分前 orders（行宽 ~4KB，一页 16KB 只放 4 行）
┌──────── 热列 ────────┬──────────── 冷列/大字段 ───────────┐
│ id,user_id,amount,   │ detail_json TEXT, remark, ...      │
│ status,created_at    │ （溢出到 TOAST/溢出页，见 01/08）   │
└──────────────────────┴─────────────────────────────────────┘
拆分后 orders（行宽 ~100B，一页放下 100+ 行） + order_details（按 id 1:1）
        ↑ 热查询全部命中缓冲池                 ↑ 详情页按需读取
```

**机制**：

- 行越窄，单个 16KB 页（InnoDB）或 8KB 页（PostgreSQL）容纳的行越多，热点查询的缓冲池命中率越高——这是 [08 缓冲池](./08-buffer-pool.md) 的"密度"问题；
- 大字段（`TEXT`/`BLOB`/`jsonb`）在 InnoDB DYNAMIC 行格式下存溢出页、行内只留 20 字节指针；PostgreSQL 超过约 2KB 触发 TOAST 压缩外存。即使外存，主表频繁更新仍可能带来额外开销，把大字段拆到独立的 1:1 表（同主键）是更彻底的隔离，见 [01 存储引擎](./01-storage-engine.md)；
- 拆出的表更新/锁各自独立，高频小字段更新不再触碰大字段所在页。

**代价**：详情要按 id 二次查询或 join；两张表无外键强制的 1:1（可用同主键约束近似）；写入路径从一条 `INSERT` 变两条，需要应用或事务保证一致。

## 六、分库分表（Sharding）：跨实例拆行

### 直觉

分区受限于"一个实例"：写入吞吐、存储容量、可用性都以实例为上限。分库分表（sharding）把同一张逻辑表的不同行放到不同实例上，用路由换取水平扩展——代价是应用要面对"一张表散落多台机器"的全部复杂度。

### 什么时候才需要

单表行数的经验阈值（如千万级）只是信号，不是定律——索引与 SQL 调优到位的表在数亿行时点查依然毫秒级。先走完这条链路，每一步都可能让分库分表变得不必要：

1. 索引与 SQL 调优、执行计划核对（[07](./07-query-optimizer.md)、[11](./11-performance-tuning.md)）；
2. 读写分离，把读流量卸到副本（[09](./09-replication-ha.md)）；
3. 缓存层承接热读；
4. 水平分区/冷热归档控制单表体积（本篇第二、七节）。

只有当**单实例写入吞吐成为瓶颈**（主库 CPU/IO 打满、复制延迟不可控）或**存储超出单实例可承受容量与成本**时，sharding 才是正解。读瓶颈、慢查询、单表过大都不构成充分理由。

### 路由策略

```text
                        路由层（应用 SDK / 代理）
                              │ shard = f(shard_key)
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        shard 0          shard 1          shard 2
        db_0.t_order_0   db_1.t_order_1   db_2.t_order_2
        db_0.t_order_3   db_1.t_order_4   db_2.t_order_5
        db_0.t_order_6   db_1.t_order_7   db_2.t_order_8   ← 表号 = shard_key % 9，库号 = 表号 % 3
```

| 策略 | 分布 | 扩容 | 热点 | 备注 |
|---|---|---|---|---|
| 哈希取模 `user_id % N` | 非常均匀 | 差：N 从 4 到 8 约一半 key 换位，需大范围迁移 | 无 | 实现最简单；N 建议预留翻倍空间 |
| 范围 `id` 或时间段 | 可不均匀 | 好：新增分片只接新数据 | 新分片写热点集中在最新范围 | 天然支持范围扫描 |
| 一致性哈希（consistent hashing） | 均匀 | 好：只迁移新环段相邻数据（约 1/N） | 无 | 需引入哈希环/虚拟节点实现 |
| 查表映射（映射表/目录服务） | 完全可控 | 最好：改映射即迁移 | 可人工再平衡 | 每次路由多一次查表；单点需缓存 |

路由键的选择决定能力边界：按 `user_id` 分片，用户维度的查询单分片完成；跨用户的运营查询、后台分页就要扫全部分片。选键的原则是**让最高频、最关键的路径单分片可达**。

### 扩容迁移的通用流程

```text
旧库（单表 orders）                    新集群（8 分片）
────────────────                      ─────────────────
[1] 应用双写 ───────────────────────► 新写入同时落旧库与新集群
        │
[2] 存量迁移 ──────────────────────► 按主键区间分批搬运历史数据
        │
[3] 数据校验 ─────────────────────► 行数、抽样校验和、双写窗口核对
        │
[4] 灰度切读 ─────────────────────► 读流量按比例切新集群，新旧对比
        │
[5] 停旧写 ───────────────────────► 旧库转只读归档，新集群成主
```

为什么双写放第一步：迁移耗时不可控，只有新数据先行双写，才能保证切换时刻新旧两侧收敛；校验（行数、抽样校验和、迁移期间更新是否同步）是切换的前置条件。停旧写之后旧库保留只读一段时间，作为回滚窗口。

### 代价清单（拆之前逐条对账）

- **跨分片 join**：只能应用层聚合（各分片查询后内存拼装）或预先宽表化，无法用一条 SQL 表达。
- **跨分片分页**：`LIMIT 50 OFFSET 10000` 会让每个分片都取出 offset+limit 行再归并排序，深分页代价随分片数线性放大；常见的替代是把翻页改游标（`WHERE id > last_id`），或把检索类需求外移到 Elasticsearch/宽表。
- **跨分片事务**：本地事务边界被打穿，要么业务侧规避（路由键设计让关键事务单分片），要么引入 Saga/TCC/消息最终一致（见 [10 分布式事务](./10-distributed-consistency.md)）。
- **全局唯一 ID**：各分片自增不可用，需雪花（Snowflake）或号段模式发号（见 [10](./10-distributed-consistency.md)）。
- **DDL 困难**：`ALTER TABLE` 要在所有分片逐个执行并处理失败重试，没有原生"全分片原子 DDL"；字段变更需配套灰度与回滚脚本。
- **运维复杂度翻倍**：实例数 × 分表数 = 监控、备份、扩缩容、故障演练的对象数量；排查一条慢查询要先定位它在哪个分片。

**中间件定位**：ShardingSphere-JDBC（客户端 SDK，Java 应用内嵌路由）与 ShardingSphere-Proxy（独立代理，语言无关）负责分片路由、结果归并；Vitess（CNCF 项目，YouTube 出身）面向超大规模 MySQL 集群提供分片与在线扩缩容。中间件解决"路由与归并"，解决不了上面清单里的业务改造。

## 七、冷热分离与归档：更轻的替代

大量场景的"表太大"其实是"热数据窗口小"：最近 3 个月活跃、之前的数据只剩审计价值。此时按月分区 + 到期归档就够了，不需要 sharding。

流程：到期分区 `DETACH`（PostgreSQL）或 `DROP PARTITION`（MySQL）→ `COPY`/`SELECT INTO OUTFILE` 导出为 CSV/Parquet，上传对象存储或写入列式数仓 → 删除在线分区。效果是在线表体积恒定在热窗口内：缓冲池命中率、索引高度、备份时长、备份体积随之稳定；温数据在数仓侧用更低成本支撑分析查询；合规留存（数年）落在归档桶按需拉回。

## 开发者清单

该做：

- 时间序列大表优先按时间做 RANGE 分区，并预建未来分区、监控兜底分区的数据量——归档与裁剪收益直接。
- 上线前后都用 `EXPLAIN` 验证分区裁剪（PG 看计划里出现的分区，MySQL 看 partitions 列）——裁剪失效的分区表比不分区更慢。
- 分区表的唯一约束一律设计为"业务键 + 分区键"联合——两库都不允许不含分区键的唯一索引。
- 新表上线前评估冷热列与 TEXT/JSON 字段，大字段独立 1:1 表——提升缓冲池密度，见 08。
- 决定 sharding 前，先量化瓶颈确实在单实例写入/存储，并走完调优→读写分离→缓存→分区链路——sharding 是单向门。
- 扩容迁移严格按"双写→迁移→校验→灰度切读→停旧写"推进，校验不通过不切——顺序错了无法收敛。

不该做：

- 不带分区键的高频查询打在多分区表上——每次都是全分区扇出，把这类查询改到带分区键或走宽表/检索引擎。
- 以为"分区了就不用建索引"——索引是每分区一套的本地索引，该建的一样不能少。
- 用大事务 `DELETE` 做周期性归档——秒级的 DROP/DETACH 是分区存在的意义之一。
- 哈希取模分片时不预留扩容方案——模数一变约半数数据换位，迁移窗口极长。
- 跨分片 join/分页硬塞给中间件——归并代价随分片数放大，应在路由键设计或数据冗余层解决。
- 为了"看起来先进"上 sharding——运维对象数量翻倍，且很难回头。

## 常见误区

1. **"分区和分库分表是一回事。"** 分区在单实例内、对应用透明；sharding 跨实例、路由对应用/中间件可见。前者优化扫描与运维粒度，后者突破实例吞吐与容量上限，问题域不同。
2. **"分了区，查询自然就快。"** 只有谓词含分区键、能被裁剪的查询受益；不带分区键的查询反而要扇出到更多 B+ 树，可能更慢。
3. **"分区表可以不建索引。"** 分区只是把一棵大树变成多棵小树，每棵小树内部的查找仍靠索引；`WHERE user_id = ?` 在 60 个分区里各做一次全表扫描是灾难。
4. **"MySQL 那个主键包含分区键的限制是实现不完善。"** 这是数据结构决定的：本地索引无法跨分区验证唯一性。PostgreSQL 有完全相同的限制。
5. **"表到一千万行就必须分库分表。"** 行数只是信号。索引与调优良好的表数亿行仍可正常服务；先走完调优、读写分离、缓存、分区归档，再谈 sharding。
6. **"分库分表之后事务由中间件搞定。"** ShardingSphere 等对跨库事务的支持限于特定模式且有明显约束（性能、语义），主流做法仍是让关键事务单分片化，或按 10 篇的最终一致方案改造。

## 自测题

1. 查询 `WHERE created_at BETWEEN '2026-09-01' AND '2026-09-30'` 打在按月 RANGE 分区的表上，会扫几个分区？（1 个：9 月分区，两边界都落在同一分区。）
2. 为什么 `WHERE user_id = 42` 在按 `created_at` 分区的表上无法裁剪？（user_id 不是分区键，优化器推不出任何分区可排除。）
3. MySQL 分区表主键为什么必须是 `(id, created_at)` 而不能只有 `id`？（唯一索引必须包含分区函数的全部列，否则跨分区唯一性无法验证。）
4. 归档 5000 万行历史数据，`DELETE` 与 `DROP PARTITION` 的差别是什么？（DELETE 逐行标记删除、分钟到小时级且产生大量日志；DROP PARTITION 是秒级 DDL 直接丢弃存储段。）
5. 哈希取模 4 分片扩到 8 分片，约多少数据需要迁移？一致性哈希呢？（约一半；一致性哈希只迁移新加入环节点相邻区间，约 1/8。）
6. 跨 8 个分片做 `ORDER BY created_at LIMIT 20 OFFSET 10000`，数据库层实际要取多少行参与归并？（每分片至少 10020 行，共约 8 万行，深分页代价随分片数放大。）
7. sharding 的路由键选 `user_id` 还是 `order_id`，判断依据是什么？（让最高频、最关键的路径——通常是"某用户的订单列表"——单分片可达；按事务相关性选键。）
8. PG 里 `DETACH PARTITION` 之后，这个分区变成了什么？（一张独立的普通表，可导出归档，也可在结构与约束一致时 ATTACH 回分区树。）

## 关联阅读

- [01 · 存储引擎与数据组织](./01-storage-engine.md)——行格式、溢出页，垂直拆表的物理依据
- [02 · 索引原理](./02-index.md)——B+ 树高度与查找成本，分区裁剪的收益基础
- [06 · 日志与恢复](./06-wal-recovery.md)——理解 DELETE 为何产生大量日志
- [07 · 查询执行与优化器](./07-query-optimizer.md)——执行计划与裁剪的判定细节
- [08 · 缓冲池与缓存](./08-buffer-pool.md)——缓冲池密度，垂直拆表与分区共同的动机
- [09 · 复制与高可用](./09-replication-ha.md)——读写分离，sharding 之前的减压手段
- [10 · 分布式事务与一致性](./10-distributed-consistency.md)——跨分片事务、全局唯一 ID
- [11 · 性能调优基础](./11-performance-tuning.md)——分库分表之前的完整调优链路
- [15 · 备份与恢复](./15-backup-recovery.md)——分片数翻倍后备份体系的变化
