# 11 · 性能调优基础（Performance Tuning）

> 系统变慢时，从哪里下手、按什么顺序下手、怎么证明改对了？本篇不教你背参数，而是给一套「测量 → 定位 → 变更 → 验证」的闭环方法，配齐慢查询定位、EXPLAIN 复查清单、索引健康度、参数速查表与监控基线清单。参数与默认值以 MySQL 8.0 / PostgreSQL 16 为准。

## 读完本篇你应能回答

- 为什么调优必须「先测量后动手」？各类优化手段的收益大致怎么排序？
- MySQL 慢日志与 PostgreSQL 的 pg_stat_statements 分别怎么用？为什么从「最耗总时长」而不是「单条最慢」入手？
- 拿到一条慢 SQL，EXPLAIN 复查至少要看哪五件事？
- 一个「看起来没人用」的索引，如何安全地下线？
- MySQL / PostgreSQL 各有哪几个必查参数？分别管什么？
- 一套够用的监控基线至少包含哪些指标？

## 调优方法论：先测量，后动手

### 直觉

调优像看病：不做检查就开药，治好是运气，治坏是事故。数据库几乎把「哪里慢、慢多少」都记在了自己的统计数据里——你要做的是先看化验单，再决定开不开刀。

### 结构

```text
症状：慢 / 超时 / 资源告警
        │
        ▼
 ① 测量：慢日志 / pg_stat_statements / 等待事件，
         把症状落到具体 SQL 和具体数字上
        │
        ▼
 ② 基线：记录当前耗时、返回行数、执行计划、监控曲线
        │
        ▼
 ③ 变更：一次只改一个变量（加索引 / 改写 SQL / 调参数），
         并事先想好回滚方式
        │
        ▼
 ④ 验证：同条件复测对比 → 保留或回滚，记录结论
        │
        └──── 回到 ①，持续闭环
```

图中「等待事件」指会话当前在等什么资源（锁、IO 等），用于把「慢」落到具体资源类别上——本篇「监控指标基线清单」里的 `wait_event_type`（→ 05 篇）就是它的应用。

### 机制

四条纪律，每一条都来自真实事故：

1. **先测量后动手**。「数据库慢」不是问题定位，「订单列表 P99 从 80ms 涨到 2.4s，其中 95% 时间耗在一条 `orders` 全表扫描上」才是。在没有这句话之前，任何变更都是猜。
2. **基线对比**。改之前记下 `EXPLAIN` 输出、实际行数、耗时与监控曲线；改完用同样的数据与负载复测。没有基线，「感觉快了」不可信。
3. **单变量变更**。同时改了索引、SQL 和三个参数，好了不知道谢谁，坏了不知道抓谁。两次测量之间只允许差一个变量。
4. **每次变更可回滚**。索引先置 `INVISIBLE` 再删（MySQL 8.0）、参数在会话级先试、SQL 改动带开关。回滚成本决定生产上的变更勇气。

优化手段的收益排序——顺序不是审美，是统计规律：

| 优先级 | 手段 | 典型收益量级 | 代价与风险 |
|---|---|---|---|
| 1 | schema 与索引设计（加对索引、消除冗余列） | 单条查询从秒级到毫秒级，常见 10~1000 倍 | 写入变慢、占磁盘，需回归测试 |
| 2 | SQL 写法（减少扫描量、消除 filesort（排序无法利用索引序、需额外排序，07 篇）、砍深分页） | 数倍到数十倍 | 要改代码、走发版 |
| 3 | 参数（缓冲池、work_mem、刷盘策略等） | 百分之几十到数倍，且只救对症的病 | 影响全局，需容量算术，误配可致 OOM |
| 4 | 硬件（SSD、内存、CPU） | 与瓶颈对应的线性收益 | 花钱，且掩盖设计问题，复发只是时间 |

一句话：**先穷尽 1 和 2，再动 3；4 是最后手段，不是第一反应。**

### 对开发者的实际影响

1、2 两层几乎全部发生在开发阶段——建表、加索引、写 SQL 的那一刻，就决定了这条查询九成的性能命运。DBA 能调的参数层通常是锦上添花：索引错了，buffer pool 给到 80% 内存也救不了每秒五百次全表扫描。

## 慢查询定位闭环：从「最耗总时长」入手

### 直觉

优化一条每天堵三小时的路口红绿灯，比优化一条一年出一次事故的匝道收益大得多。排序依据是「总耗时 = 单次耗时 × 频次」，不是单次最慢。

### 结构

```text
 ① 采集   MySQL：慢日志 + pt-query-digest 聚合
          PostgreSQL：pg_stat_statements 按 total_exec_time 排序
          └─ 产出：Top N 慢查询清单（按总耗时）
                        │
                        ▼
 ② 复查   EXPLAIN / EXPLAIN ANALYZE：估算行数、扫描方式、
          filesort / temporary、join 顺序、过滤时机（机制 → 07 篇）
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
    索引问题         SQL 写法问题     统计信息/参数
   （→ 02 篇）       （本篇案例）     （案例 3 / 参数表）
                        │
                        ▼
 ③ 修复后回到监控曲线验证，闭环
```

### MySQL：慢日志 + pt-query-digest

```sql
-- MySQL 8.0：动态开启慢日志，无需重启
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 0.2;      -- 秒，支持小数；默认 10 太钝
SET GLOBAL log_queries_not_using_indexes = ON;  -- 噪音很大，见下
```

三个注意点：

- `long_query_time` 默认 10 秒，对在线业务等于没开。抓真问题常设 0.1~0.5 秒；专项排查可临时降到 0.05，日志量会暴涨，用完调回。
- `log_queries_not_using_indexes` 会把「没走索引但本来就快」的查询也记进来——50 行的小表全表扫描就是最优解，但它照样记。可用 `log_throttle_queries_not_using_indexes`（每分钟最多记多少条）限流。
- 慢日志文件路径看 `slow_query_log_file` 变量。

裸日志几万行没法看，用 Percona Toolkit 的 pt-query-digest 聚合，它默认按总耗时排名，正好是我们要的口径：

```bash
# 输出：按总耗时排名的查询类别、每类占比、样例与统计
pt-query-digest /var/lib/mysql/<hostname>-slow.log | head -80
```

### PostgreSQL：pg_stat_statements + auto_explain

```sql
-- PostgreSQL 16：需先在 postgresql.conf 设置并重启一次
--   shared_preload_libraries = 'pg_stat_statements'
-- 然后在目标库：
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 按「总耗时」找大头：total_ms = mean_ms × calls 才是优化收益的口径
SELECT round(total_exec_time::numeric)  AS total_ms,
       calls,
       round(mean_exec_time::numeric,1) AS mean_ms,
       rows,
       temp_blks_written,               -- 溢出到临时盘的块数（8KB/块，→ 13 篇）
       left(query, 80)                  AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

要点：

- 查询文本已归一化（常数变 `$1`），同一模板的 10 万次调用自动聚合成一行。
- 换个排序列就是不同视角：`ORDER BY mean_exec_time DESC` 看单条最慢（用户体验口径）、`ORDER BY temp_blks_written DESC` 看谁在吃临时盘（→ 13 篇）、`ORDER BY rows DESC` 看谁扫得最多。
- 统计是累计值，怀疑漂移时 `SELECT pg_stat_statements_reset();` 后重新采样一个周期。

pg_stat_statements 看到的是平均值，抓不到「偶尔 8 秒」的偶发坏计划，用 auto_explain 抓现行：

```sql
-- PostgreSQL 16：只给超过 3 秒的语句记录真实执行计划（可仅本会话开启）
SET session_preload_libraries = 'auto_explain';
SET auto_explain.log_min_duration = 3000;  -- 毫秒
SET auto_explain.log_analyze = on;         -- 记录真实行数与耗时（有轻微开销）
```

日志里会出现该语句当时的完整计划与每步实际行数，直接对照「估算 vs 实际」。

### 为什么不是「单条最慢」

| 视角 | 例子 | 一天总耗时 | 优化优先级 |
|---|---|---|---|
| 单条最慢 | 月报 SQL：10s × 5 次 | 50 秒 | 看业务，可能不急 |
| 总耗时最大 | 列表查询：120ms × 200 万次 | 约 67 小时 | 必须最先处理 |
| 临时盘最大 | 导出 SQL：30s × 200 次 | 6000 秒 + 磁盘压力 | → 13 篇主题 |

频次高出四个数量级的中等慢查询，才是大多数系统的头号杀手。

## EXPLAIN 复查清单（机制细节见 07 篇）

定位到 SQL 后过这五项，前三项通常能解释 80% 的慢查询：

1. **估算行数 vs 实际行数**。`rows`（估算）与 `EXPLAIN ANALYZE` 的 actual rows（实际）差一个数量级以上 → 统计信息过期或数据分布倾斜，先 `ANALYZE`（见案例 3）再谈别的。
2. **扫描方式**。MySQL 的 `type = ALL`、PG 的 `Seq Scan` 出现在不小的表上 → 该有的索引没有，或索引被写法废掉（函数包裹列、隐式类型转换、前导 `%` 的 LIKE）。
3. **Extra / 节点细节**。MySQL 的 `Using filesort`、`Using temporary`；或 PG 计划里 Sort 节点显示 `Sort Method: external merge` → 在做磁盘级排序/物化，→ 13 篇。
4. **join 顺序**。驱动表选错（先扫大表再过滤小表）→ 检查过滤条件的选择性与连接字段类型是否一致。
5. **过滤时机**。PG 的 `rows removed by filter: 990000` 说明扫了 100 万行只留 1 万行——这个过滤条件本该进索引。

```sql
-- MySQL 8.0.18+：真实执行，树形输出，含每步实际行数与循环次数
EXPLAIN ANALYZE SELECT id, status FROM orders WHERE customer_id = 42;

-- PostgreSQL：BUFFERS 额外给出共享块/磁盘块读写细节
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, status FROM orders WHERE customer_id = 42;
```

提醒：`EXPLAIN ANALYZE` 会真执行，DML 语句会真改数据，生产上不要拿 UPDATE/DELETE 直接来。

## 索引健康度：冗余识别与安全下线

### 冗余索引

`(a)` 与 `(a,b)` 并存时，`(a)` 几乎总是冗余的——`(a,b)` 的最左前缀就能服务 `WHERE a = ?`。冗余索引白白拖慢每次 INSERT/UPDATE/DELETE，还占 buffer pool 空间。例外：`(a)` 是 UNIQUE 约束或外键的载体时不能删。

### 未使用索引的安全下线

```sql
-- PostgreSQL：自上次统计重置以来从未被扫描过的索引
SELECT schemaname, relname AS table_name, indexrelname AS index_name, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY relname, indexrelname;
```

```sql
-- MySQL 8.0：sys 视图做同样的事
SELECT * FROM sys.schema_unused_indexes;

-- 下线三步走：先隐形（优化器看不见，但仍在维护）→ 观察一周无回归 → 删除
ALTER TABLE orders ALTER INDEX idx_created_at INVISIBLE;
-- 确认无慢查询、无错误后：
ALTER TABLE orders DROP INDEX idx_created_at;
```

判断前必须排除两类「看着没用其实不能删」：唯一约束索引（没人扫也要维护唯一性）、只在月底报表用的索引（采样窗口没覆盖到）。`INVISIBLE` 一键可逆，就是这个流程的安全带。

## 关键参数速查表

### MySQL 8.0

| 参数 | 默认值 | 管什么 | 调优要点 |
|---|---|---|---|
| `innodb_buffer_pool_size` | 128MB | 数据页缓存，读性能第一参数（→ 08 篇） | 专用 DB 机器常给物理内存的 50%~70%；支持在线调整 |
| `innodb_flush_log_at_trx_commit` / `sync_binlog` | 1 / 1（「双 1」） | redo / binlog 刷盘持久性（→ 06 篇） | 双 1 最安全；非核心库放宽到 2/0 换吞吐，宕机可能丢最近约 1 秒事务 |
| `max_connections` | 151 | 并发连接上限 | 先做内存算术再调大（→ 12 篇） |
| `tmp_table_size` / `max_heap_table_size` | 各 16MB | 内存内部临时表上限（→ 13 篇） | 有效上限取两者较小值；盲目调大只是浪费内存 |
| `sort_buffer_size` | 256KB | 每个排序操作的缓冲 | **不是越大越好**：每连接每操作一份，乘法效应见 13 篇 |

### PostgreSQL 16

| 参数 | 默认值 | 管什么 | 调优要点 |
|---|---|---|---|
| `shared_buffers` | 128MB | 共享页缓存（→ 08 篇） | 经验起点是物理内存的 25%，再拿命中率验证 |
| `work_mem` | 4MB | 每个排序/哈希节点的配额（→ 13 篇） | 是每节点不是每连接；大查询按会话/事务发放 |
| `maintenance_work_mem` | 64MB | VACUUM / CREATE INDEX 的内存 | 可以大方些，如 256MB~1GB |
| `max_connections` | 100 | 连接上限 | 宁小勿大，并发靠连接池扩（→ 12 篇） |
| `effective_cache_size` | 4GB | 告诉优化器「OS 层大约还有多少缓存可用」 | 不分配内存，只是成本估算的输入；常设为总内存的一半左右 |
| `random_page_cost` | 4.0 | 随机读相对顺序读的成本假设 | 默认值假设机械盘；全 SSD 库常调到 1.1~2.0。也有反方观点：命中率高的库缓存内外成本差异被抹平，调了收益有限——调了必须用真实计划验证 |

### 读表的方式

参数表不是待办清单。每个参数只在「测量表明对应资源成为瓶颈」时才动：命中率低先看 buffer pool，临时盘暴涨先看 tmp/work_mem（13 篇），连接报错先查泄漏而不是 max_connections（12 篇）。改参数同样遵守单变量与回滚纪律，`ALTER SYSTEM` / `SET GLOBAL` 都要留下记录。

## 表结构层面：类型、拆分与归档

- **够用的最小类型**。`VARCHAR(255)` 存两位国家码、`BIGINT` 存永远不会超过千万的自增 ID，都在浪费内存与索引空间——每个二级索引行都带着这份宽度。类型收窄是少数「不改查询就能提速」的手段。
- **大字段垂直拆分**。把 TEXT/BLOB/超长 JSON 拆到旁表：主表更窄 → 每页容纳更多行 → 顺序扫描与 buffer pool 命中都受益。拆分策略与取舍见 14 篇。
- **历史数据归档**。在线表只留热数据，冷数据搬到归档表/归档库。注意别一条 `DELETE FROM t WHERE create_time < ?` 删千万行：长事务 + 锁 + binlog 风暴（→ 03/05 篇）。分批删（每批几千行、批间停顿）或用分区表直接 `DROP PARTITION`（→ 14 篇）。

## 监控指标基线清单

没有基线的监控只是仪表盘装饰。下表是「慢了」之后第一时间要看的八项，也是平时画趋势曲线的最小集：

| 指标 | MySQL | PostgreSQL | 异常信号 |
|---|---|---|---|
| QPS / TPS | `Questions` / (`Com_commit`+`Com_rollback`) | `pg_stat_database.xact_commit + xact_rollback` | 突降：连接打满或被锁住 |
| 缓存命中率 | `Innodb_buffer_pool_reads` / `read_requests` | `blks_hit / (blks_hit + blks_read)` | 长期 < 99% 值得追查（→ 08 篇） |
| 活跃连接 | `Threads_connected` / `Threads_running` | `pg_stat_activity` 按 state 计数 | 逼近 max_connections（→ 12 篇） |
| 锁等待 | `Innodb_row_lock_waits`、`Innodb_row_lock_time` | `pg_stat_activity` 的 `wait_event_type = 'Lock'` | 突增：业务锁冲突（→ 05 篇） |
| 死锁数 | `SHOW ENGINE INNODB STATUS` 中的记录 | `pg_stat_database.deadlocks` | 持续增长必须查代码 |
| 复制延迟 | `Seconds_Behind_Source`（8.0.22 前叫 `Seconds_Behind_Master`） | `pg_stat_replication.replay_lag` | 读从库时直接变慢查询（→ 09 篇） |
| 慢查询计数 | `Slow_queries` 状态计数器 | 需自建：pg_stat_statements 或日志采样 | 斜率变化 = 负载结构变化 |
| 临时盘落地 | `Created_tmp_disk_tables` / `Created_tmp_files` | `temp_files` / `temp_bytes` | 上涨 = 查询溢出到磁盘（→ 13 篇） |

```sql
-- MySQL：一次取多数状态计数器；两次采样求差、除以秒数得速率
SHOW GLOBAL STATUS WHERE Variable_name IN (
  'Questions','Com_commit','Threads_connected','Threads_running',
  'Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads',
  'Slow_queries','Created_tmp_disk_tables','Created_tmp_files');
```

```sql
-- PostgreSQL：命中率、事务、临时盘、死锁
SELECT datname, xact_commit, xact_rollback,
       round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS hit_pct,
       temp_files, pg_size_pretty(temp_bytes) AS temp_written, deadlocks
FROM pg_stat_database
WHERE datname = current_database();

-- 连接状态分布与等待事件
SELECT state, wait_event_type, wait_event, count(*) AS cnt
FROM pg_stat_activity
GROUP BY 1, 2, 3
ORDER BY cnt DESC;
```

采样频率建议：核心指标 1 分钟粒度、保留至少 30 天——很多性能问题是「上周三 15 点开始」式的，没有历史曲线就永远靠猜。

## 三个走查案例

### 案例 1：深分页——`LIMIT 100000, 20` 的隐藏成本

后台导出页翻到第 5000 页，查询 1.8 秒，慢日志定位到它。

```sql
-- MySQL：慢的写法。沿索引取出前 100020 行，丢掉前 100000 行，才返回 20 行
SELECT * FROM orders ORDER BY id DESC LIMIT 100000, 20;
```

```text
 LIMIT 100000,20                     游标（keyset）分页
 ─────────────────────               ─────────────────────
 沿索引读出并丢弃前 100000 行          每页从「上一页末尾」精确定位，
 才返回 20 行                          再读 20 行
 成本 ∝ 页码：越翻越慢                 成本 ∝ 每页行数：翻多深都一样
 第 5000 页 ≈ 第 1 页成本的 5000 倍    第 5000 页 ≈ 第 1 页
```

两种解法（都需要排序键上有索引）：

```sql
-- 解法 A（延迟关联）：子查询用覆盖索引只取 20 个主键，再回表 20 行
--   （覆盖索引 = 查询所需列全在索引里；回表 = 拿主键回主键树取整行，见 02 篇）
-- MySQL
SELECT o.* FROM orders o
JOIN (SELECT id FROM orders ORDER BY id DESC LIMIT 100000, 20) t ON t.id = o.id;

-- 解法 B（游标分页）：记住上一页末尾，从那儿继续
SELECT * FROM orders WHERE id < :last_seen_id ORDER BY id DESC LIMIT 20;
```

解法 B 是治本，但要求排序键唯一且有序——按时间排序时要兜住并列，用复合键 `WHERE (created_at, id) < (:last_time, :last_id) ORDER BY created_at DESC, id DESC LIMIT 20`，并配索引 `(created_at DESC, id DESC)`。解法 A 不改交互，收益通常也有数倍到数十倍。

### 案例 2：无索引字段 join，全表扫描

订单报表从 300ms 涨到 25 秒——上周新增了「按客户外部编码关联」的字段，忘了配索引。

```sql
-- PostgreSQL：EXPLAIN ANALYZE 一眼定位
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, c.name
FROM orders o
JOIN customers c ON c.ext_code = o.customer_ext_code   -- ext_code 没索引
WHERE o.created_at >= date '2026-08-01';

-- 修复（在线建索引，不阻塞写入），随后刷新统计
CREATE INDEX CONCURRENTLY idx_customers_ext_code ON customers (ext_code);
ANALYZE customers;
```

同类陷阱还有两种「有索引但用不上」：

- 类型不一致：一边 `VARCHAR` 一边 `BIGINT`，隐式转换让一侧索引失效。MySQL 里「字符串列 = 数字常量」是重灾区。
- 排序规则/字符集不一致（MySQL join 两侧 collation 不同），索引直接废掉（→ 18 篇）。

### 案例 3：统计信息过期，计划跳变

一条稳定运行半年的查询突然变成 6 秒。`EXPLAIN` 显示估算行数 800、实际 85 万——优化器拿着旧地图开车。排查发现昨夜批量导入 500 万行，自动统计没跟上。

```sql
-- PostgreSQL：查统计新鲜度
SELECT n_live_tup, n_mod_since_analyze, last_analyze, last_autoanalyze
FROM pg_stat_user_tables
WHERE relname = 'orders';

-- 手动刷新（大表也是秒级），计划随即恢复
ANALYZE orders;
```

- PG 自动分析的触发阈值默认是「50 行 + 表现有行数 × 10%」（`autovacuum_analyze_scale_factor = 0.1`），大表批量导入后经常滞后。大表可按表收紧：`ALTER TABLE orders SET (autovacuum_analyze_scale_factor = 0.02);`
- MySQL 侧对应操作是 `ANALYZE TABLE orders;`（重建 InnoDB 持久化统计）。
- 教训：把 `ANALYZE` 写进批量导入/大删除流程的收尾步骤，别等自动机制追。

## 开发者清单

该做：

- 上线前给核心查询留一份 `EXPLAIN` 输出存档，变更时对比——多数计划回退能提前一版发现。
- 新 SQL 走查三问：过滤列有索引吗？join 两边类型一致吗？ORDER BY 能吃到索引序吗？
- 分页默认用游标方案；`LIMIT offset` 只留给翻不了几页的管理后台。
- 批量导入/大删除的收尾步骤里写上 `ANALYZE`（MySQL 用 `ANALYZE TABLE`）。
- 删索引永远走「INVISIBLE → 观察 → DROP」三步。
- 监控曲线按「八项基线」采样并保留 30 天以上，出问题先看曲线再动手。

不该做：

- 不要没看 `EXPLAIN` 就提「优化了查询」的 PR——没有证据的优化是改命。
- 不要为低频报表查询调全局参数；用会话级设置，用完还原。
- 不要一条 SQL 删/改千万行；分批，或换分区方案。
- 不要把 `SELECT *` 带进大表 join——多出的每列都是网络、内存与临时表的直接成本。
- 不要「以防万一」地加索引——每个索引都是写入路径上的固定税。

## 常见误区

1. **「数据库慢就该调参数 / 加内存」**。参数层收益通常只有百分之几十，而一个缺失索引是 10~1000 倍。先查索引和 SQL，再谈参数。
2. **「单条最慢的 SQL 最值得优化」**。收益 = 单次耗时 × 频次。120ms × 每秒 50 次的查询，比 10 秒 × 每天 5 次的报表急得多。
3. **「`log_queries_not_using_indexes` 记下的都是坏查询」**。50 行小表的全表扫描就是最优解；它只说明「没走索引」，不说明「慢」。
4. **「估算行数不准是优化器的 bug」**。多数是统计过期或数据分布倾斜（热点值），`ANALYZE` 与按表调采样比例才是正路。
5. **「索引越多越保险」**。每个二级索引都是写入时的固定开销，冗余索引还挤占 buffer pool。索引是要还的债。
6. **「EXPLAIN 显示走索引就万事大吉」**。回表几十万次的「索引扫描」可能比顺序扫描更慢；要看扫描行数与实际耗时，不只看访问类型。

## 自测题

1. 调优四步闭环是什么？为什么必须单变量变更？（测量→基线→变更→验证；多变量无法归因，也不知道回滚谁）
2. 为什么优化的排序口径是 `mean_exec_time × calls` 而不是 `mean_exec_time`？（收益等于总耗时下降，频次是隐藏的放大器）
3. `EXPLAIN` 估算 800 行、实际 85 万行，第一反应做什么？（查统计新鲜度并 `ANALYZE`，再复查计划）
4. MySQL 里怎么安全删一个疑似没用的索引？（`ALTER INDEX ... INVISIBLE` 观察后再 `DROP`；唯一约束/外键索引除外）
5. `innodb_flush_log_at_trx_commit=2`、`sync_binlog=0` 换来了什么、赌上了什么？（换更低的刷盘频率即吞吐；赌上宕机时最近约 1 秒事务的持久性，→ 06 篇）
6. `LIMIT 100000,20` 为什么慢？两种解法各自的适用条件？（扫描并丢弃前 10 万行；延迟关联不改交互，游标要求排序键唯一有序）
7. 监控里 `Created_tmp_disk_tables` 持续上涨说明什么？去哪篇继续查？（大量查询把内部临时表溢出到磁盘，→ 13 篇）

## 关联阅读

- [07 · 查询执行与优化器](./07-query-optimizer.md)：EXPLAIN 输出的逐列解读、统计信息与代价模型。
- [02 · 索引原理](./02-index.md)：为什么「加对索引」是收益最高的优化。
- [08 · 缓冲池与缓存](./08-buffer-pool.md)：buffer pool / shared_buffers 的工作机制与命中率口径。
- [13 · 内存管理与排序/哈希](./13-memory-sort-hash.md)：work_mem / sort_buffer_size 的真实语义与溢出磁盘的代价。
- [12 · 连接管理与线程/进程模型](./12-connection-model.md)：max_connections 与连接成本的算术。
- [06 · 日志与恢复](./06-wal-recovery.md)：「双 1」参数在持久性光谱上的位置。
- [14 · 分区与分表](./14-partition-shard.md)：历史数据归档与大表拆分的方案选型。
