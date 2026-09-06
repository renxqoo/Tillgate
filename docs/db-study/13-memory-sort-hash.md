# 13 · 内存管理与排序/哈希（Memory, Sort & Hash）

> ORDER BY、GROUP BY、JOIN 都需要在内存里摆开战场；战场不够大时，数据库会把数据分批写到临时磁盘文件，性能从内存级跌到磁盘级。本篇讲清数据库内存的两大类别、PostgreSQL `work_mem` 与 MySQL `sort_buffer_size` 的真实语义、溢出磁盘的观测手段，以及「按查询发放内存」的正确调优姿势。参数与默认值以 MySQL 8.0 / PostgreSQL 16 为准。

## 读完本篇你应能回答

- 数据库内存分哪两大类？为什么配置思路完全不同？
- `work_mem` 到底是谁的配额？最坏情况下一个查询、一个实例要吃多少内存？
- 排序和哈希在内存不足时分别发生什么？代价差几个量级？
- MySQL 的 filesort 与内部临时表是怎么回事？TempTable 引擎管什么？
- 怎么观测「谁在溢出磁盘」？两边的指标分别叫什么？
- 为什么全局调大 `work_mem` 危险？会话级 / 事务级该怎么设置？

## 内存地图：全局共享 vs 每会话私有

### 直觉

数据库内存像一间共享厨房加每人一套随身工具：厨房（全局共享内存）全店共用一口大锅，买一口大的值；工具包（私有内存）每人一套、每个工序甚至还要各领一套——「工具包规格」的定价方式和「锅」完全不同。

### 结构

```text
┌──────────────────── 服务器物理内存 ─────────────────────┐
│                                                          │
│   全局共享内存（整个实例 1 份）      每会话/每操作私有内存     │
│   MySQL：InnoDB buffer pool         （每连接 1 份起）       │
│   PG：shared_buffers                PG：每个排序/哈希/聚合    │
│   （机制 → 08 篇）                       节点一份 work_mem   │
│                                     MySQL：sort_buffer /   │
│                                       join_buffer / 内部    │
│                                       临时表                │
│                                                          │
│   OS page cache、其他进程                                 │
└──────────────────────────────────────────────────────────┘
```

### 机制

| 维度 | 全局共享内存 | 每会话/每操作私有内存 |
|---|---|---|
| 份数 | 整个实例 1 份 | 每连接 1 份，某些还按操作、按执行节点再翻倍 |
| 生命周期 | 实例启动到关闭 | 语句执行期间按需分配，用完释放 |
| 代表参数 | `innodb_buffer_pool_size`、`shared_buffers` | `work_mem`、`sort_buffer_size`、`join_buffer_size`、`tmp_table_size` |
| 调大的收益 | 命中率与读延迟，均匀惠及所有查询（→ 08 篇） | 只让含对应节点的查询受益 |
| 调大的风险 | 挤占 OS 与其他进程（静态、可控） | **乘法效应**：连接数 × 节点数，失控即 OOM |

配置思路因此完全不同：共享内存做一次性容量规划（08 篇主题）；私有内存保持保守默认值，把大额配额按查询、按会话、按事务精确发放——这是本篇主题。

### 对开发者的实际影响

绝大多数「把 work_mem / sort_buffer_size 调大点」的建议都错在没做乘法算术。开发者的正确姿势是：默认值不动，遇到具体慢查询时用观测指标确认它在溢出，再用最小作用域的 `SET` 发放内存，或者干脆改写 SQL 让这个排序/哈希消失。

## PostgreSQL：work_mem 的真实语义

### 直觉

`work_mem`（默认 4MB）不是「每个连接 4MB」，而是「每个排序/哈希/聚合**节点**的预算」：一个查询计划里有三个这种节点，就可能有三个配额；计划并行执行时，每个并行 worker 的每个这种节点又各有一份；并发会话再多乘一层。

### 结构：乘法效应

```text
 SELECT ... FROM a JOIN b ON ... GROUP BY ... ORDER BY ...
       │            │            │
       ▼            ▼            ▼
    Hash Join    Aggregate     Sort        ← 三个需要工作区的节点
   （哈希表）   （哈希聚合）  （排序）
       │            │            │
       └── 4MB×2 ───┴── 4MB×2 ───┴── 4MB   ← 哈希类节点按 work_mem×2 发放（hash_mem_multiplier=2.0，见下文机制），单连接就可能 3 份

 × 并行执行：leader + 2 个并行 worker ≈ ×3
 × 并发会话：50 个这样的查询同时跑 ≈ ×50

 最坏内存 ≈ 活跃连接数 × 每查询节点数 × work_mem
```

### 机制

- `work_mem` 约束排序、哈希表、哈希聚合等节点在「写临时文件」前最多可用的内存。注意 PG 15 起 `hash_mem_multiplier` 默认 2.0：哈希类节点的实际配额是 `work_mem × 2`。
- 超过配额不报错，而是**静默降级**：
  - 排序 → 外部归并排序（external merge）：在内存里分批排序，批次写入临时文件，最后多路归并；
  - 哈希 → 分批（batches）：哈希表按键分区，装不下的分区写盘，执行期间反复读回。
- 代价差的是数量级：内存随机访问约 100 纳秒级，SSD 单次读约 100 微秒级，机械盘约 10 毫秒级。溢出后同一算法从「全内存」变「盘上反复倒腾」，慢 10~1000 倍很常见，且临时文件还会挤占 buffer pool 与 OS page cache（08 篇）。给个体感：约 100MB 的外部归并在 NVMe 上通常增加几十到上百毫秒，机械盘则到秒级。
- 并行查询把乘法再放大一层：每个并行 worker 执行的同类节点同样各有一份 `work_mem` 配额。`EXPLAIN ANALYZE` 里看到 `Parallel Seq Scan` / `Workers Planned: N` 时，这条查询的内存预算就要按「leader + N 个 worker」放大。
- 用到 work_mem 的不只是 ORDER BY：哈希连接的构建端、哈希聚合、窗口函数的排序、递归 CTE 的工作表、`DISTINCT` 的去重缓冲都从同一配额取——一个「看起来没有 ORDER BY」的查询照样可能占多份 work_mem。
- 相关但独立的 `maintenance_work_mem`（默认 64MB）管 VACUUM、CREATE INDEX 等维护操作，autovacuum 的每个 worker 默认也按它取（`autovacuum_work_mem = -1` 表示跟随），可以设得比 work_mem 大方。

### 观测：让溢出现形

```sql
-- PostgreSQL：同一个查询，两种 work_mem 的对照实验
SET work_mem = '64kB';   -- 允许的最小值，强制溢出
EXPLAIN ANALYZE
SELECT g FROM generate_series(1, 1000000) AS g ORDER BY g;
--   Sort Method: external merge  Disk: 12000kB   ← 溢出实锤（Disk 数值为示例量级）
RESET work_mem;

SET work_mem = '64MB';
EXPLAIN ANALYZE
SELECT g FROM generate_series(1, 1000000) AS g ORDER BY g;
--   Sort Method: quicksort  Memory: 8896kB        ← 全内存
RESET work_mem;
```

- `Sort Method: quicksort`（内存）与 `external merge (Disk: ...)`（磁盘）一眼分界；哈希节点看 `Batches: N`，大于 1 就是在分批写盘。
- 实例级累计：`pg_stat_database.temp_files / temp_bytes`（含排序、哈希、显式临时表等一切临时文件）。临时文件写在实例数据目录的 `base/pgsql_tmp/` 下，磁盘目录的监控告警常常先于数据库指标发现溢出。
- 定位到语句：`pg_stat_statements.temp_blks_written`（8KB/块）按语句聚合，直接找出吃临时盘的 SQL（11 篇的定位闭环用它排序）。

哈希溢出的样子（对照实验同思路）：

```sql
-- PostgreSQL：把 work_mem 压到最小，观察 Hash Join 分批
SET work_mem = '64kB';
EXPLAIN ANALYZE
SELECT count(*) FROM generate_series(1, 200000) a
JOIN generate_series(1, 200000) b ON a.g = b.g;
--   Hash Join
--     Hash  Buckets: ...  Batches: 64  Memory Usage: ...
-- （数值为示例；Batches 越大，执行期间的盘上往返越多）
RESET work_mem;
```

为什么溢出后选归并/分批，而不是「想办法跑一个更大的快排」：归并把输入切成若干块，每块独立在内存内快排，再对有序块做多路归并——任意规模的输入都只需要固定大小的内存；哈希的分批（batch）同理，按键的哈希值分区后，每次只把一个分区装回内存。这是溢出场景下唯一可行的算法形态，代价是反复的临时文件 IO。

```sql
-- PostgreSQL：写临时盘最多的查询 Top 10
SELECT temp_blks_written * 8 AS written_kb,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       calls,
       left(query, 70) AS query
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 10;
```

## MySQL：sort_buffer 与内部临时表

MySQL 的私有内存与 PG 同一思路，但参数拆得更细，且内部临时表自成体系。

### 私有缓冲：每连接、每操作一份

| 参数 | 默认值 | 给谁用 |
|---|---|---|
| `sort_buffer_size` | 256KB | 每个排序操作（ORDER BY、建索引时的排序） |
| `join_buffer_size` | 256KB | 无索引 join（块嵌套循环，及 8.0.18+ 的 hash join） |
| `read_buffer_size` | 128KB | 顺序扫描缓冲（主要影响 MyISAM 与批量场景，InnoDB 影响小） |

同样有乘法效应：`max_connections × 各缓冲峰值` 是最坏内存口径（12 篇的算术）。排序按需增长缓冲、上限即 `sort_buffer_size`——所以「全局调到 4MB 求快」会放大所有并发排序的内存占用，通常得不偿失。

### filesort 的三条路径

排序吃不到索引序时走 filesort，按数据规模分三种形态：

1. **优先队列（堆）**：`ORDER BY ... LIMIT n` 且 n 小——只维护前 n 个元素的小顶堆，内存占用小，代价最低；
2. **单次内存排序**：数据装得进 sort_buffer，一趟快排完成；
3. **外部归并**：超过 `sort_buffer_size` → 分块排序、写临时文件、多路归并。状态计数器 `Sort_merge_passes` 持续非零，说明归并在反复发生。

顺带一提：MySQL 8.0.18+ 的 hash join 超出 `join_buffer_size` 时同样分块写临时文件再回读——与 PG 的 batch 机制是同一思路。filesort 走哪条路径由优化器按数据量决定，EXPLAIN 不直接展示，但效果体现在耗时与 `Sort_merge_passes` 上。

### 内部临时表：GROUP BY / DISTINCT / UNION / 派生表的落点

聚合、去重、UNION、派生表物化常需要内部临时表（Internal Temporary Table）暂存中间结果。MySQL 8.0 的路径：

```text
 GROUP BY / DISTINCT / UNION / 派生表物化
        │
        ▼
 内存内部临时表：TempTable 引擎（8.0 默认，
   internal_tmp_mem_storage_engine = TempTable）
   约束：单表上限 min(tmp_table_size, max_heap_table_size)
   （默认各 16MB）+ 实例级 temptable_max_ram（默认 1GB）
        │ 超限
        ▼
 磁盘内部临时表：InnoDB 引擎（temp tablespace）
   ——代价从内存级跌到磁盘级
```

两个补充事实：TempTable 引擎支持把 BLOB/TEXT 一类大对象先留在内存（这是它取代旧 MEMORY 引擎成为默认的原因之一）；磁盘内部临时表由 InnoDB 实现、放在 temp tablespace 中且不写 redo 日志，落盘成本主要是 IO 本身（临时文件的落盘不走 redo 日志，与 06 篇讲的数据页落盘是两回事，此处不展开）。

### 观测

```sql
-- MySQL 8.0：会话级对照，看一次 GROUP BY 是否落地
SHOW SESSION STATUS LIKE 'Created_tmp%';
SELECT store_id, count(*) FROM orders GROUP BY store_id;   -- 假设 store_id 无索引
SHOW SESSION STATUS LIKE 'Created_tmp%';
-- Created_tmp_tables +1；若 Created_tmp_disk_tables +1，就是转磁盘了

-- 全局累计与排序归并
SHOW GLOBAL STATUS WHERE Variable_name IN
 ('Created_tmp_tables','Created_tmp_disk_tables','Created_tmp_files','Sort_merge_passes');
```

排序溢出的对照实验与 PG 同理：

```sql
-- MySQL 8.0：把会话排序缓冲压到允许的最小值，排序一张大表
SET SESSION sort_buffer_size = 32768;          -- 最小 32KB
SELECT * FROM orders ORDER BY created_at;      -- 假设百万行级
SHOW SESSION STATUS LIKE 'Sort%';              -- Sort_merge_passes > 0 即发生归并
SET SESSION sort_buffer_size = DEFAULT;        -- 用完还原
```

`Created_tmp_disk_tables / Created_tmp_tables` 比例偏高时，再考虑调大 `tmp_table_size`，同时把 11 篇的 EXPLAIN 清单过一遍（`Using temporary` 就是内部临时表）。

### 两库观测指标速查

| 想知道什么 | PostgreSQL | MySQL |
|---|---|---|
| 这条查询的排序在内存还是磁盘 | `Sort Method: quicksort` / `external merge` | 计划里无直接输出；看会话 `Sort_merge_passes` 增量 |
| 这条哈希是否溢出 | `Batches: N > 1` | hash join 超出 join_buffer 时分块写盘，看临时文件计数 |
| 实例累计溢出量 | `temp_files` / `temp_bytes` | `Created_tmp_files` / `Sort_merge_passes` |
| 内部临时表落地比例 | 一并计入 temp_files | `Created_tmp_tables` vs `Created_tmp_disk_tables` |
| 哪条 SQL 在吃临时盘 | `pg_stat_statements.temp_blks_written` | `performance_schema.events_statements_summary_by_digest` 的 `SUM_CREATED_TMP_DISK_TABLES`（sys 视图 `statements_with_temp_tables`） |

临时盘问题的定位路径（与 11 篇闭环衔接）：

1. 巡检发现 `temp_bytes` / `Created_tmp_disk_tables` 曲线上涨（11 篇监控基线）；
2. `pg_stat_statements.temp_blks_written`（或 MySQL 的 digest 汇总表）排序，锁定 SQL；
3. `EXPLAIN ANALYZE` 确认是哪个节点在溢出（Sort / Hash / 内部临时表）；
4. 三选一：索引序消除排序、`SET LOCAL` 发放配额、改写 SQL 减少输入行数；
5. 回到指标验证——溢出计数应归零或明显回落。

## 调优策略：默认值保守是故意的

4MB / 256KB 这些「小气」的默认值，是为了让「几百连接 × 若干节点」的乘法不至于失控。正确方向不是全局调大，而是**按需、按最小作用域发放**：

| 方式 | 写法（以 PG 为例） | 生效范围 | 适用 |
|---|---|---|---|
| 全局 | `ALTER SYSTEM SET work_mem = '64MB'` | 所有人所有查询 | 几乎不适用；乘法失控 |
| 会话级 | `SET work_mem = '256MB'`（用完 `RESET`） | 当前会话 | ETL / 报表专用连接 |
| 事务级 | `BEGIN; SET LOCAL work_mem = '256MB'; ...; COMMIT;` | 单个事务，结束自动还原 | 首选：作用域最小 |
| 角色级 | `ALTER ROLE report SET work_mem = '256MB'` | 该角色新会话的默认值 | 固定报表账号 |

```sql
-- PostgreSQL：重报表查询的标准姿势
BEGIN;
SET LOCAL work_mem = '256MB';
-- 这里放大排序/大哈希的报表 SQL
COMMIT;   -- work_mem 自动还原，连接池里的下一个使用者不受影响
```

MySQL 同理：`sort_buffer_size` / `tmp_table_size` 都是会话级可设变量，可 `SET SESSION sort_buffer_size = 4 * 1024 * 1024;` 给特定任务临时发放，用完还原。

配额发多大有客观依据：`EXPLAIN ANALYZE` 输出的 `Disk: N` / `Memory: N` 就是这次操作的实测体积，按它的大约 1~2 倍发放即可（如 `Disk: 120000kB` → `SET LOCAL work_mem = '256MB'`），不需要拍脑袋翻倍再翻倍。

### 在 SQL 层面少排序：最便宜的优化

内存配额再大，也不如让这个排序根本不发生：

- **让索引序满足 ORDER BY**：`ORDER BY created_at DESC, id DESC` 配上同序索引后，计划里的 Sort 节点直接消失，top-N 只需读前 N 行；
- **GROUP BY / DISTINCT 交给索引前缀**：索引本身有序，分组退化为顺序扫描时的分段计数，Sort/临时表节点消失；
- **避免大 OFFSET 分页**：`LIMIT 100000, 20` 本质是对前 100020 行排序再丢弃（11 篇案例 1），游标分页让排序输入只剩每页 20 行；
- **别用 `SELECT *` 喂排序与聚合**：每多带一列，排序/临时表就多一截体积；
- **给报表和导出加行数上限或分批**：无界聚合永远按最坏情况消耗内存与临时盘，先确认业务真的需要全量。

对照实验：让 Sort 节点整个消失（PostgreSQL）。

```sql
-- 无匹配索引：排序不可避免，输入是全表
EXPLAIN ANALYZE
SELECT id, status FROM orders ORDER BY created_at DESC, id DESC LIMIT 20;
--   Limit  (...)
--     ->  Sort  (...)
--           ->  Seq Scan on orders

-- 建同序索引后：top-N 沿索引直接读前 20 行，Sort 节点消失
CREATE INDEX idx_orders_created_id ON orders (created_at DESC, id DESC);
EXPLAIN ANALYZE
SELECT id, status FROM orders ORDER BY created_at DESC, id DESC LIMIT 20;
--   Limit  (...)
--     ->  Index Scan using idx_orders_created_id on orders
```

排序输入从「全表」变成「20 行」——这是调大内存永远给不了的收益，也是 11 篇把索引设计排在收益第一的原因。MySQL 侧同理，且 8.0 起降序索引（`ORDER BY c DESC` 配 `INDEX (c DESC)`）是真实生效的，不再像 5.7 那样忽略 DESC 方向。

## 与 08 篇的边界：全局容量算术

私有内存与共享内存共享同一台机器的物理内存。`work_mem` 全局调大，先被挤压的不是抽象的「资源」，而是 OS page cache 和数据库自己的 buffer pool——后者命中率下降后，所有查询一起变慢，而你还以为自己在「优化内存」。

```text
 容量算术示例（64GB 内存、PG、shared_buffers = 16GB）：

 全局 work_mem = 4MB：  100 活跃 × 平均 1.5 节点 × 4MB   ≈ 0.6GB   安全
 全局 work_mem = 64MB： 100 活跃 × 平均 1.5 节点 × 64MB  ≈ 9.6GB   挤压 page cache
 全局 work_mem = 256MB：最坏 100 活跃 × 3 节点 × 256MB   = 76.8GB  超过物理内存，OOM 风险

 结论：全局留在 4~16MB；256MB 只以 SET LOCAL 发给单条重查询
```

MySQL 侧同一个公式，变量换成它的私有缓冲：

| 场景（32GB 内存、buffer pool 16GB、max_connections = 500） | 最坏私有内存口径 |
|---|---|
| 默认值：栈 256KB + sort 256KB + join 256KB | 500 × 约 0.75MB ≈ 0.4GB，安全 |
| 把 `sort_buffer_size` 全局调到 8MB | 500 ×（8MB + …）≈ 数 GB 起；且这是「每操作」口径，一个查询多个排序还要再翻 |

判断标准始终是乘法公式的最坏值，而不是「单条查询需要多少」。验证容量假设的办法：低峰期让最坏并发（所有批任务同时跑）真实发生一次，观察数据库进程 RSS 与 OS 可用内存，同时盯 `temp_files` 与 buffer pool 命中率——RSS 顶到物理内存、命中率同步下滑，就说明乘法项已经在越界。

## 开发者清单

该做：

- 写 ORDER BY 前想一下索引序：能被索引满足的排序，一分私有内存都不占。
- 重报表/导出 SQL 用 `SET LOCAL`（PG）或 `SET SESSION` + 用完还原（MySQL）临时发放配额。
- 大 OFFSET 分页一律改游标（keyset）方案。
- 把 `temp_files / temp_bytes`（PG）、`Created_tmp_disk_tables / Sort_merge_passes`（MySQL）纳入例行巡检（11 篇清单）。
- 核心查询上线前跑一次 `EXPLAIN ANALYZE`，扫一遍 `external merge`、`Batches > 1`、`Using temporary`。
- 给 ETL / 报表走独立账号并在角色级挂配额（`ALTER ROLE ... SET work_mem`），让「谁可能吃大内存」成为显式清单。
- 调整配额后用 `EXPLAIN ANALYZE` 复测：`Disk:` / `Batches` 应归零——没有指标对比的调参等于没调。
- 在 PR 模板里给涉及大表查询的改动留一栏「EXPLAIN 结论」，把观测习惯固化进流程。
- 换硬件或调过共享内存后，重做一遍最坏内存算术。

不该做：

- 不要全局调大 `work_mem` / `sort_buffer_size` 求「快点」——乘法效应会以 OOM 或命中率下降还账。
- 不要忘记会话级 `SET` 的存在：在连接池里它会串到下一个使用者（12 篇），用完必须还原或改 `SET LOCAL`。
- 不要看到 `Sort_merge_passes > 0` 就先调大 `sort_buffer_size`：先确认这条排序是否本该被索引消除。
- 不要在 transaction 池化模式下依赖会话级内存设置——作用域对不上（12 篇）。
- 不要假设溢出会报错：它静默发生，只能靠指标发现。
- 不要在生产高峰做「压到最小 work_mem」的对照实验——那会人为放大临时盘压力；实验放只读从库或低峰期。
- 不要套用来路不明的「调优模板」改私有内存参数——模板不知道你的连接数与并发形态。

## 常见误区

1. **「work_mem 是每连接的内存」**。它是每个排序/哈希/聚合节点一份；单查询可能多份、并行 worker 各一份、并发连接再乘——最坏是三层乘法，且哈希类节点还要乘 `hash_mem_multiplier`（默认 2.0）。
2. **「超过 work_mem 会报错」**。不会报错，是静默降级为外部归并 / 分批写盘；结果正确但性能跌几个量级，所以必须靠观测指标而不是报错来发现。
3. **「调大 sort_buffer_size 总能加速排序」**。它同时放大所有并发排序的内存占用；很多排序的正解是被索引序消除，而不是更大的缓冲。
4. **「MySQL 的内部临时表都在内存里，不用管」**。超过 `tmp_table_size / max_heap_table_size`（默认各 16MB）就转 InnoDB 磁盘临时表；`Created_tmp_disk_tables` 就是这个转换的计数器。
5. **「GROUP BY 天生需要临时表」**。索引前缀有序时，PG 与 MySQL 都能做「顺序扫描 + 增量聚合」，Sort/临时表节点消失。
6. **「OOM 了调小 buffer pool 就行」**。私有内存的乘法项（连接数 × 节点数 × work_mem）经常才是真凶；先做最坏值算术，再动共享内存。

## 自测题

1. 数据库内存两大类的核心区别？各自代表参数？（全局共享 1 份 vs 每会话/每操作 N 份；buffer pool / shared_buffers vs work_mem / sort_buffer_size）
2. `work_mem` 的真实语义？一个「Hash Join + HashAggregate + Sort」的查询最多几份？（每个排序/哈希/聚合节点的配额；至少 3 份，哈希类再乘 hash_mem_multiplier=2.0）
3. 最坏内存公式是什么？为什么全局调大 work_mem 危险？（活跃连接数 × 节点数 × work_mem；三层乘法，OOM 或挤压缓存）
4. 排序/哈希溢出磁盘后分别走什么算法？对应观测指标？（external merge / batches 分批；`Sort Method: external merge`、`Batches: N>1`、temp_files/temp_bytes）
5. MySQL 里 `Created_tmp_disk_tables` 增长说明什么？（内存内部临时表超限，转 InnoDB 磁盘临时表）
6. PG 会话级调优的首选写法？为什么不用裸 `SET`？（`BEGIN; SET LOCAL ...; COMMIT;`——事务结束自动还原，不会在连接池里串到别的使用者）
7. `work_mem` 全局调大挤压的是谁？（OS page cache 与 buffer pool，命中率下降殃及所有查询）
8. 怎么让一条 GROUP BY 完全不用临时表？（在分组列上建索引，用索引前缀序做增量聚合，扫一遍 11 篇 EXPLAIN 清单确认节点消失）

## 关联阅读

- [08 · 缓冲池与缓存](./08-buffer-pool.md)：全局共享内存那一半的机制与命中率口径，本篇是它的边界。
- [07 · 查询执行与优化器](./07-query-optimizer.md)：Sort / Hash 节点从哪来、执行计划怎么读。
- [02 · 索引原理](./02-index.md)：用索引序消除排序与去重的理论基础。
- [11 · 性能调优基础](./11-performance-tuning.md)：把 temp 指标纳入慢查询定位闭环与监控基线。
- [12 · 连接管理与线程/进程模型](./12-connection-model.md)：每连接内存与连接数上限的算术。
