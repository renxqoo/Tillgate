# 07 · 查询执行与优化器（Query Execution & Optimizer）

> 同一句 SQL，昨天 50ms、今天 5s；明明建了索引却不走；换个参数值计划整个变脸——这些日常怪象的答案都在优化器里。本篇讲清一条 SQL 从文本到结果的完整流水线、优化器如何靠统计信息选计划、怎样逐字段精读 EXPLAIN，以及计划变差时按什么顺序修。读完之后，"调优"从背口诀变成可以推理的工程。

## 读完本篇你应能回答

- 一条 SQL 从字符串到结果集要经过哪几个阶段？逻辑计划与物理计划差在哪？
- 优化器凭什么选索引、选 join 顺序？统计信息有哪些成分，怎么失准？
- 四种扫描节点、四种 join 算法各自的选择条件是什么？
- MySQL 与 PostgreSQL 的 EXPLAIN 输出，哪些字段是估算、哪些是事实？
- 估算行数与实际行数偏差巨大，说明什么、先查什么？
- 计划变差时按什么优先级修正？hint 为什么排最后？

## 一、查询处理流水线：从字符串到结果集

### 直觉

数据库处理 SQL 的方式像编译器处理源码：先"读懂"（解析），再"改写"（优化），最后"执行"；只是编译产物不是机器码，而是物理执行计划（Physical Plan）。编译器优化代码，优化器（Optimizer）优化数据访问路径——本质都是"同一语义下选一条更快的路"。

### 结构：六个阶段

```text
SQL 文本
   │
   ▼
① 解析（Parser）
   │  词法分析 + 语法分析 → 抽象语法树（AST）
   │  语法错误在这步报出（MySQL: ERROR 1064; PG: syntax error at or near ...）
   ▼
② 语义分析与重写（Rewrite）
   │  校验表/列/权限/类型；视图展开；常量折叠（constant folding）；
   │  外连接消除（outer join elimination）；子查询提升（subquery unnesting）
   ▼
③ 逻辑计划（Logical Plan）
   │  关系代数表达式：Scan / Filter / Join / Project / Aggregate
   │  只描述"做什么"，不描述"怎么做"
   ▼
④ 基于成本的优化（Cost-Based Optimizer, CBO）
   │  枚举等价变换（join 顺序、谓词下推、投影裁剪）
   │  （谓词＝WHERE/ON 里的条件表达式；下推＝把过滤尽量推到靠近数据源处提前执行）
   │  × 统计信息估算行数 → 给每个候选算成本 → 选最低者
   ▼
⑤ 物理计划（Physical Plan）
   │  为逻辑算子绑定具体算法：Seq Scan / Hash Join / Sort …
   ▼
⑥ 执行器（Executor）
      火山模型逐行拉取，产出结果集
```

### 机制细节

重写阶段做的事比想象中多，举几个会被"悄悄"改写的例子：

- 视图展开：视图只是存好的查询文本，改写期被整体展开进外查询（详见第十节）。
- 常量折叠：`WHERE amount > 100 + 50` 在优化前就算成 `> 150`。
- 外连接消除：`LEFT JOIN` 的内表列被 `WHERE 内表.col = x` 这类 NULL 拒绝（null-rejecting）谓词过滤时，NULL 行最终必被剔除，等价于 `INNER JOIN`，优化器直接降级——两库都会做。
- 子查询提升：MySQL 8.0 把多数 `IN`/`EXISTS` 关联子查询改写为半连接（Semi Join）再统一优化；PG 也常把 `EXISTS` 规划成 Hash Semi Join。

逻辑计划与物理计划的分界：`"orders ⋈ users"` 是逻辑算子；"用 Hash Join、build users 侧"是物理决定。同一逻辑计划可对应多种物理计划，CBO 的全部工作就是在这个空间里挑。

执行器主流是火山模型（Volcano Model）/迭代器模型（Iterator Model）：每个算子实现 `next()`，上层调用下层拉一行、处理、吐出。逐行拉取让内存占用极小（排序、哈希这类"管道破坏者"（pipeline breaker）除外——它们必须吸干上游才能吐出第一行）。

```text
            ┌─────────┐  next() 每次向下一层"拉"一行
            │  Limit  │
            └────┬────┘
            ┌────▼────┐
            │  Sort   │  ← 管道破坏者：收齐全部输入才能产出第一行
            └────┬────┘
            ┌────▼─────┐   probe 端逐行拉；build 端一次性读入建哈希表
            │ HashJoin │
            └──┬────┬──┘
        ┌──────▼─┐ ┌─▼──────────┐
        │SeqScan │ │ IndexScan  │  叶子算子：向存储层/缓冲池要页，解出行
        └────────┘ └────────────┘
```

### 对开发者的实际影响

- 语法错误与应用层错误是两码事：解析失败连优化器都到不了，别在业务层猜测"是不是索引问题"。
- SQL 是声明式的，你写的是"要什么"，怎么拿由优化器定——书写顺序既不是执行顺序，也不保证 join 顺序。
- 逐行拉取意味着 LIMIT 早停有效（找到即返回），但 ORDER BY + LIMIT 仍需先排序或靠索引序。

## 二、统计信息：优化器的眼睛

### 直觉

CBO 对着模型估算成本，模型需要输入：表多大、每列的值怎么分布。统计信息（Statistics）就是这些输入。统计错，再聪明的优化器也只能错得理直气壮——垃圾进，垃圾出。

### 机制细节：PostgreSQL 16

- `pg_class.reltuples`：表的估算行数；`relpages`：占用的页面数（页 8KB）。EXPLAIN 里的基数就来自它。
- `pg_statistic`（超集表，仅超级用户可读；普通用户看 `pg_stats` 视图）存每列的分布：空值比例、平均宽度、distinct 数（`stadistinct`：负数表示占行数的比例，正数表示绝对个数）、最常见值（Most Common Values, MCV）及其频率、等深直方图（histogram，落在 MCV 之外的值用桶估计）。
- `ANALYZE` 采样估算：每列采样约 `300 × default_statistics_target` 行（默认 target=100，即约 3 万行），target 可按列调（上限 10000）。autovacuum 默认在行变化超过约 10%（`autovacuum_analyze_scale_factor=0.1`）时自动触发 autoanalyze。

```sql
-- PostgreSQL 16：看表的估算行数与某列的分布
SELECT reltuples::bigint AS est_rows, relpages
FROM pg_class WHERE relname = 'orders';

-- 注：n_distinct 即 pg_statistic.stadistinct 在 pg_stats 视图中的对应列名
SELECT attname, n_distinct, null_frac, most_common_vals AS mcv,
       most_common_freqs AS mcf, histogram_bounds
FROM pg_stats
WHERE tablename = 'orders' AND attname = 'status';

-- 手动刷新 + 提高某列精度
ANALYZE orders;
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 500;
ANALYZE orders;
```

### 机制细节：MySQL 8.0

- InnoDB 持久化统计（`innodb_stats_persistent=ON`，默认）：随机采样若干页（`innodb_stats_persistent_sample_pages`，默认 20）算出索引基数（cardinality）；默认行数变化超过 10% 时后台自动重算（`innodb_stats_auto_recalc=ON`）；可按表覆盖 `STATS_SAMPLE_PAGES`。
- 直方图：只影响估算、与索引无关，且是静态的，不会自动刷新；主要补足无索引列的估算，有索引的列走索引统计与"索引下潜"（index dive：实际到索引里探一下范围端点）。

```sql
-- MySQL 8.0：手工构建/删除直方图（默认 100 桶，上限 1024）
ANALYZE TABLE orders UPDATE HISTOGRAM ON status WITH 100 BUCKETS;
ANALYZE TABLE orders DROP HISTOGRAM ON status;

-- 注意：ANALYZE TABLE orders; 只刷新 InnoDB 索引统计，不含直方图
```

### 对开发者的实际影响

- 因果链要背下来：统计过期 → 估错行数 → 选错计划。典型剧本：批量导入 2000 万行，`reltuples` 还停在 10 万，优化器估 500 行选了 Index Scan + Nested Loop，实际执行 10 万次随机回表，一条 SQL 打挂整库。
- 批量导入/大变更后手动 `ANALYZE`（PG）；监控 `pg_stat_user_tables.n_mod_since_analyze` 与 `last_analyze`。
- MySQL 直方图是快照：数据分布大变后记得重新 UPDATE HISTOGRAM，否则它在撒谎。

## 三、成本模型与估算：计划是怎么选出来的

### 直觉

成本（cost）≈ IO 代价 + CPU 代价。IO 按页算（读多少页、随机还是顺序），CPU 按行和表达式算。优化器给每个候选计划算总成本，选最低的——它最小化的是"模型里的成本"，不是你手表上的时间。

### 结构：join 顺序的搜索空间

```text
3 张表的左深树（left-deep tree，主流优化器优先搜索的形状）：

        Join                 Join                 Join
       /    \               /    \               /    \
    Join     C           Join     A           Join     B
   /    \                /    \               /    \
  A      B              B      C             A      C

N 张表的 join 顺序组合是 NP-hard 问题：全部树形约 O(N!·2^(N-1))，
10 张表即 ~10^10 量级。优化器靠剪枝与启发式活下来：
- PG：≤ 12 个 FROM 项做动态规划；超过 geqo_threshold（默认 12）切遗传算法 GEQO
- MySQL：受控穷举 + 启发式剪枝（optimizer_prune_level=1 默认开，
  optimizer_search_depth 默认 62），并偏好左深树
```

### 机制细节

行数估算怎么来（以 PG 为例）：等值条件先查 MCV——`status='done'` 若命中 MCV（频率 0.62），选择性就是 0.62；不在 MCV 里就落在直方图某个桶，按桶内均匀假设取比例；完全没有统计时兜底假设（如等值默认选择性 0.005）。多条件组合默认按独立事件相乘：`P(A AND B) = P(A) × P(B)`。

成本单位是无量纲的内部值，不是毫秒：PG 把一次顺序页读定为 1（`seq_page_cost=1.0`，`random_page_cost` 默认 4.0，`cpu_tuple_cost=0.01`）。成本只用于候选之间的相对比较；觉得"cost=8712 应该跑 8 秒"是常见误读。`random_page_cost=4` 是机械盘时代的假设，SSD/NVMe 上常调到 1.1~2，否则优化器系统性高估随机读、偏向顺序扫描。

独立假设是低估的重灾区：`city='杭州' AND status='active'` 若两列高度相关（该城市订单大多 active），实际行数会远大于两选择性的乘积——估 500 行、实际 8 万行，Nested Loop 就地爆炸。PG 的对策是扩展统计（PG 10 起支持函数依赖、distinct；PG 12 起支持 MCV）：

```sql
-- PostgreSQL 16：对相关列建扩展统计并刷新
CREATE STATISTICS st_orders_city_status (dependencies, ndistinct, mcv)
  ON city, status FROM orders;
ANALYZE orders;
```

MySQL 8.0 没有等价的扩展统计，相关列低估只能靠直方图、改写 SQL（把相关条件合并成一个生成列 + 索引）或 hint 兜底。

### 对开发者的实际影响

- 看到"rows 估 500、actual 500000"式的偏差，第一反应是统计，第二反应是列相关性。
- 复杂查询里表别太多：PG 超过 12 张表用遗传算法（质量不保证），MySQL 深度受限后偏贪心——超多表 join 本身就是设计问题。

## 四、扫描节点：四种取数方式

单表怎么读，决定了整条查询的底价。两库节点名不同但思想相通（下表以 PG 节点名为主轴，MySQL 的对应行为标注在备注里）：

| 节点 | 做法 | 适合 | 代价特征 | 备注 |
| --- | --- | --- | --- | --- |
| Seq Scan（顺序扫描） | 整表逐页读 | 返回行占比高（经验上 >5%~10%）、无可用索引 | 顺序 IO，每页必读 | MySQL type=ALL |
| Index Scan（索引扫描） | 沿 B+ 树找条目，逐条回表取整行 | 点查/低选择性范围 | 命中行少时快；命中行多时大量随机回表 | MySQL：回表即二级索引 → 主键聚集索引的查找 |
| Index Only Scan（仅索引扫描） | 只读索引条目，不回表 | 查询列全部包含在索引里（覆盖索引，Covering Index） | 省掉回表；PG 需可见性映射（visibility map）标记页"全可见"才真免回表，否则仍要访问堆取可见性 → 看 `Heap Fetches` | MySQL Extra=`Using index`；InnoDB 二级索引免回表无此附加条件 |
| Bitmap Heap Scan + Bitmap Index Scan（位图扫描） | 先在索引里收集所有元组号（TID）成位图，再按页序批量回表，回表后 Recheck | 单索引命中较多行（几千到几十万），想避免逐行随机 IO | 随机 IO 转为近似顺序；代价是位图本身占内存（受 work_mem 限制，超限退化为"有损位图"只记页号，Recheck 变多），且输出失去索引序 | MySQL 无此节点，等价行为：index merge（type=index_merge，多索引取主键合并）与 MRR（Multi-Range Read，Extra=`Using MRR`，收集主键排序后顺序回表） |

一条实用判断线（量级感受，非定律）：命中几十行走 Index Scan；命中几万行且能用索引，PG 会转 Bitmap；命中百万行不如 Seq Scan + 哈希。Index Only Scan 在 PG 上的大坑：大量 UPDATE 后可见性位图被清掉，`Heap Fetches` 暴涨、计划没变但慢了——跑 VACUUM 才恢复。

## 五、Join 算法：两表怎么碰面

### 直觉

join 的本质是对两集合按条件配对。算法差异全在"怎么减少碰面次数"：无序硬碰（Nested Loop）、缓存外层批量碰（Block Nested Loop）、给内层建目录（Hash Join）、双方排好队对齐走（Sort-Merge Join）。

### 结构

```text
Nested Loop（逐行驱动）            Hash Join（建目录再探测）
for r in 外表:                     build: 把小表按 join key 装进哈希表
    在内表索引上查 r 的配对        probe : 扫另一表，逐行查哈希表
外表 1 万行 → 内表查 1 万次        两表各扫一遍，代价与行数线性
（内表有索引时每次 ~O(树高)）

Sort-Merge Join（两边有序后归并）
两输入各自有序（靠索引或先 Sort）→ 双指针对齐推进
天然产出有序结果；支持范围型 join 条件
```

### 机制细节

| 算法 | 触发条件 | 成本直觉 | 内存 | 两库支持 |
| --- | --- | --- | --- | --- |
| Nested Loop | 任意条件（含非等值） | 外层行数 × 内层单次查找成本 | 几乎不用 | 都有；外层小 + 内层有索引时最优 |
| Block Nested Loop | MySQL 历史算法：外表按 `join_buffer_size`（默认 256KB）分块缓存，内层每块扫一次而非每行扫一次 | 外层行数 / 块容量 × 内层扫描成本 | join buffer | 8.0.18 引入 Hash Join 后被替代，8.0.20 起移除 |
| Hash Join | 等值条件 | O(build + probe)，两表各一遍 | PG：work_mem（超限分批落盘，计划里 Batches>1）；MySQL：join_buffer_size 分块 | PG 常用主力；MySQL 8.0.18+（无索引等值 join 的默认选择，Extra=`Using join buffer (hash join)`） |
| Sort-Merge Join | 等值或范围条件；输入已有序（索引序）或反正要排序 | 排序成本（若需排）+ 一次归并 | 排序内存 | PG 有；MySQL 无此算法 |

驱动表选择的直觉：Nested Loop 时代"小结果集驱动大表"是铁律（注意是过滤后的小，不是表本身小），且内层必须有索引——内层无索引时 NL 是外层行数 × 全表扫。MySQL 8.0.18 引入 Hash Join 后这条经验松动：等值 join 无索引时两表各扫一遍，build 小侧即可，"小表必须驱动"不再是通用结论。

### 对开发者的实际影响

- 内层 join 列没索引是 join 慢的第一嫌疑人：MySQL 8.0 前无 Hash Join，无索引 join 退化为 BNL 灾难；8.0.18+ 好一些但仍是两表全扫。
- PG 上 Hash Join 落盘（Batches 很大）时，适当调 work_mem 比加索引更对症——分批落盘的哈希可能比内存哈希慢几倍。

## 六、EXPLAIN 精读：MySQL 8.0

先建示例表（后文 MySQL/PG 通用此结构，PG 把类型换成 BIGINT/VARCHAR/TIMESTAMPTZ 即可）：

```sql
-- MySQL 8.0
CREATE TABLE users (
  id    BIGINT PRIMARY KEY,
  city  VARCHAR(32) NOT NULL,
  email VARCHAR(100) DEFAULT NULL,
  KEY idx_users_city (city),
  UNIQUE KEY uk_users_email (email)
);
CREATE TABLE orders (
  id         BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  status     VARCHAR(16) NOT NULL,
  amount     DECIMAL(12,2) NOT NULL,
  created_at DATETIME NOT NULL,
  KEY idx_orders_user (user_id),
  KEY idx_orders_created (created_at)
);
```

点查主键/唯一索引，type 到顶：

```sql
-- MySQL 8.0
EXPLAIN SELECT id FROM users WHERE email = 'a@b.c';
```

```text
+----+-------------+-------+------------+-------+----------------+----------------+---------+-------+------+----------+-------+
| id | select_type | table | partitions | type  | possible_keys  | key            | key_len | ref   | rows | filtered | Extra |
+----+-------------+-------+------------+-------+----------------+----------------+---------+-------+------+----------+-------+
|  1 | SIMPLE      | users | NULL       | const | uk_users_email | uk_users_email |     403 | const |    1 |   100.00 | NULL  |
+----+-------------+-------+------------+-------+----------------+----------------+---------+-------+------+----------+-------+
```

两表 join：

```sql
-- MySQL 8.0
EXPLAIN
SELECT o.id, o.amount
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.city = '杭州' AND o.created_at >= '2026-08-01';
```

```text
+----+-------------+-------+------------+------+------------------------+-----------------+---------+-----------+------+----------+-------------+
| id | select_type | table | partitions | type | possible_keys          | key             | key_len | ref       | rows | filtered | Extra       |
+----+-------------+-------+------------+------+------------------------+-----------------+---------+-----------+------+----------+-------------+
|  1 | SIMPLE      | u     | NULL       | ref  | PRIMARY,idx_users_city | idx_users_city  |     130 | const     | 8200 |   100.00 | Using index |
|  1 | SIMPLE      | o     | NULL       | ref  | idx_orders_user        | idx_orders_user |       8 | mydb.u.id |   18 |    33.33 | Using where |
+----+-------------+-------+------------+------+------------------------+-----------------+---------+-----------+------+----------+-------------+
```

逐字段读：

- `id`：SELECT 的编号。同 id 属同一查询块，自上而下执行；id 不同（子查询/UNION）时，大 id 先执行。
- `select_type`：SIMPLE（无子查询/UNION）、PRIMARY、SUBQUERY、DERIVED（派生表）、UNION 等。
- `type`：访问方式的等级，从好到坏：

| type | 含义 | 典型场景 | 风险信号 |
| --- | --- | --- | --- |
| system / const | 系统表单行 / 主键或唯一索引等值，至多一行 | 点查 | — |
| eq_ref | join 内层走主键或唯一索引 | 主键关联 | — |
| ref | 普通二级索引等值 | 索引列 = 值 | rows 很大 + filtered 很低 → 索引区分度差 |
| range | 索引范围 | `>`、`BETWEEN`、`IN` | 范围太大时接近全索引扫 |
| index | 扫整棵索引树 | 覆盖但无更窄入口 | 未覆盖时每行回表，可能比 ALL 更糟 |
| ALL | 全表扫描 | 无索引或优化器误判 | join 内层 ALL + 外层 rows 大 = 灾难 |

- `key_len`：实际用到的前缀字节数。上例 130 = city VARCHAR(32) utf8mb4（32×4）+ 2 长度字节；可空列还需额外 1 字节存 NULL 标志，本列是 NOT NULL，不加这 1 字节；o 行的 8 = BIGINT。它能告诉你联合索引到底用了几列——范围条件之后的列不计入。
- `ref`：与什么比较，const 或另一表的列（`mydb.u.id` 说明 o 是被 u 驱动的内层）。
- `rows` / `filtered`：都是估算。rows 是预计经索引取出的行数，filtered 是再经其余条件过滤后剩下的百分比（o 行 18 × 33.33% ≈ 6 行进入上层）。
- `Extra` 高频值：
  - `Using index`：覆盖索引，免回表；
  - `Using index condition`：索引下推（Index Condition Pushdown, ICP），把索引列上的 WHERE 条件提前到引擎层、在回表前过滤（5.6+）；
  - `Using where`：服务层再过滤；
  - `Using filesort`：无法靠索引序完成排序，需额外排序（内存 sort buffer，超限落盘）；
  - `Using temporary`：建临时表（DISTINCT/GROUP BY/UNION 常见），关注临时表是否落盘；
  - `Using join buffer (hash join)`：无索引 join 走哈希（8.0.18+）；
  - `Using MRR`：多范围读优化，回表前先按主键排序减少随机 IO。

MySQL 8.0.16 起有 `EXPLAIN FORMAT=TREE`，8.0.18 起有 `EXPLAIN ANALYZE`（真执行，带每算子实际耗时与行数），排查必备：

```text
-> Inner hash join (o.user_id = u.id)  (cost=10231 rows=1476) (actual time=2.9..38.4 rows=1501 loops=1)
    -> Table scan on o  (cost=6128 rows=9800) (actual time=0.10..21.7 rows=9812 loops=1)
    -> Hash
        -> Index scan on u using idx_users_city  (cost=2841 rows=82) (actual time=0.04..1.1 rows=79 loops=1)
```

## 七、EXPLAIN 精读：PostgreSQL 16

```sql
-- PostgreSQL 16（会真实执行，别在慢查询上随手跑 ANALYZE）
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, o.amount
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.city = '杭州' AND o.created_at >= '2026-08-01';
```

```text
Nested Loop  (cost=0.86..8712.40 rows=1470 width=16) (actual time=0.091..61.72 rows=1501 loops=1)
  ->  Index Scan using idx_users_city on users u  (cost=0.43..284.11 rows=82 width=24) (actual time=0.038..0.65 rows=79 loops=1)
        Index Cond: ((city)::text = '杭州'::text)
        Buffers: shared hit=86
  ->  Bitmap Heap Scan on orders o  (cost=0.43..102.55 rows=18 width=12) (actual time=0.019..0.681 rows=19 loops=79)
        Recheck Cond: (user_id = u.id)
        Filter: (created_at >= '2026-08-01'::date)
        Heap Blocks: exact=812
        Buffers: shared hit=1432
        ->  Bitmap Index Scan on idx_orders_user  (cost=0.00..0.43 rows=18 width=0) (actual time=0.014..0.018 rows=19 loops=79)
              Index Cond: (user_id = u.id)
Planning:
  Buffers: shared hit=31 read=4
Planning Time: 0.385 ms
Execution Time: 62.091 ms
```

逐项读：

- `cost=启动..总`：启动代价是吐出第一行前要花的（Sort/Hash 的启动代价高），第二个数字才是全量代价——产出全部行的总开销。单位是内部成本值（见第三节），不是毫秒。
- `rows=82`（估算）vs `actual ... rows=79`：估算接近事实，本例健康。
- `actual time=首行..末行`：毫秒，且是**每次循环的平均值**——这是最大的读数陷阱：`loops=79` 时该节点真实总耗时 ≈ 0.681 × 79 ≈ 54ms，占整条查询的九成。同理 actual rows 也是每循环平均（19 × 79 ≈ 1501 行）。
- `Buffers: shared hit/read`：hit=命中 shared_buffers，read=未命中（可能落在 OS cache，也可能真打盘）。IO 归因靠 `track_io_timing=on` 后的 I/O Timings。
- `Sort Method: quicksort  Memory: 25kB` / `Hash Buckets: ... Batches: 1  Memory: ...`：内存内完成是 Batches=1；Batches>1 表示哈希分批落盘，work_mem 不够，常是调参或缩小 build 侧的信号。
- `Heap Fetches`：Index Only Scan 实际回堆次数，非 0 说明可见性映射未覆盖。

偏差信号怎么用：估算 rows 与 actual rows 差一个数量级以上（如 rows=2000 actual=850000），基本可断定统计问题（过期或列相关）；若行数估得准、计划选择仍慢，问题在成本模型假设（如 random_page_cost）或硬件与模型脱节。

## 八、劣质计划的常见来源与对策

1. 统计过期：批量导入、大删除后没刷新。对策：手动 ANALYZE（PG）/ ANALYZE TABLE（MySQL，只刷索引统计）；调 autovacuum 阈值或对大表设按列 target。
2. 相关列低估：独立假设失效（见第三节）。对策：PG 用 `CREATE STATISTICS`；MySQL 用直方图或改写。
3. 参数化计划缓存：
   - PG 的预备语句（prepared statement）默认先用定制计划（custom plan，按当前参数重新优化），前 5 次执行都用 custom；第 6 次起比较通用计划（generic plan）的估算成本与已用 custom 计划的平均成本，generic 不更差就切换并固定。数据分布倾斜时，"倒霉参数"被套进为多数参数优化的 generic plan，慢且难复现（字面量 EXPLAIN 是好的，应用里慢）。诊断：同一语句字面量 EXPLAIN vs 预备后 EXPLAIN ANALYZE 对比。对策：`plan_cache_mode`（auto/force_custom_plan/force_generic_plan）会话级切换，或改写让倾斜参数走独立语句。
   - MySQL 的 PREPARE 在准备阶段完成解析与优化，EXECUTE 复用计划（依赖对象变更时会重新准备）；占位符让估算用不上具体参数值，直方图与 index dive 都退化。对策：倾斜参数拆成非预备语句，或 FORCE INDEX 指定。
4. 成本模型与硬件不符：`random_page_cost=4` 用在 NVMe 上会高估索引扫描成本。对策：SSD 调到 1.1~2；MySQL 侧对应关注 `innodb_stats_persistent_sample_pages` 是否采样不足。

## 九、修正手段的优先级

按"侵入性从小到大、可持续性从强到弱"排：

1. 改 SQL / 加（或删）索引：覆盖索引、调整联合索引列序、表达式索引（PG 原生支持；MySQL 8.0.13 起支持函数索引）、keyset 分页——修的是病根。
2. 更新/增强统计：ANALYZE、target、CREATE STATISTICS——修的是优化器的眼睛。
3. hint：有效但属于"替优化器做决定"，数据分布变化后可能反噬：

```sql
-- MySQL 8.0
SELECT * FROM orders FORCE INDEX (idx_orders_user) WHERE user_id = 42;
SELECT STRAIGHT_JOIN u.id, o.id FROM users u JOIN orders o ON o.user_id = u.id;  -- 按书写顺序驱动
SELECT /*+ JOIN_FIXED_ORDER */ ... ;   -- 8.0.20+，hint 形式固定 join 顺序

-- PostgreSQL 16（需安装 pg_hint_plan 扩展）
/*+ Leading(u o) HashJoin(u o) */ SELECT ...;
```

4. 会话级参数：`enable_seqscan=off` 这类只用于诊断（确认"有索引就快"），不要留在生产；成本参数调整要全库评估。

hint 纪律：写 hint 必须带注释说明原因、日期与工单链接，并安排复核——它是债，不是资产。

## 十、视图、CTE 与子查询

- 视图：MySQL 视图分 MERGE（把视图定义合并进外查询，谓词可下推到基表索引）与 TEMPTABLE（先物化成临时表，外层 WHERE 进不去）两种算法，含聚合/DISTINCT/LIMIT 的视图通常只能 TEMPTABLE。PG 的简单视图（纯 SELECT）在改写期被整体展开，效果等同 MERGE；聚合/窗口/LIMIT 视图同样构成优化栅栏（optimization fence）——先算完整张视图再过滤，谓词推入只能覆盖部分场景，写慢视图查询前先想清楚栅栏在哪。
- CTE（Common Table Expression）：PG 12 前 `WITH` 恒物化，是优化栅栏；PG 12 起默认内联展开（被引用多次或含副作用时仍物化），`WITH x AS MATERIALIZED (...)` 强制物化、`NOT MATERIALIZED` 强制内联。MySQL 8.0 的 CTE 由优化器决定 merge 还是 materialize；8.0.22 起支持派生表条件下推（derived condition pushdown），把外层谓词推进派生表/CTE。
- 关联子查询：直觉是"外层每行执行一次内层"。MySQL 8.0 会把多数 IN/EXISTS 提升为半连接统一优化（策略：FirstMatch、LooseScan、Duplicate Weedout、Materialization）；PG 里看计划：`InitPlan` 只执行一次（无关联）、`SubPlan` 逐行执行（关注它的 loops）、`hashed SubPlan` 建一次哈希表。`Filter: ... SubPlan 1` 且 loops 数万，就是逐行子查询在烧 CPU。

## 开发者清单

- 上线前对核心查询逐条 EXPLAIN，确认 join 内层有索引、扫描行数量级可接受——估算偏差是生产翻车第一名。
- 联合索引把等值列放前、范围列放后——范围条件之后的索引列不参与定位。
- 只 SELECT 需要的列——给覆盖索引留出可能，同时降低排序/传输宽度。
- WHERE 列上别包函数——普通索引失效；确有需要就建表达式索引（PG / MySQL 8.0.13+）。
- 大偏移分页改 keyset（`WHERE id > ? ORDER BY id LIMIT n`）——`LIMIT 100000, 20` 要产出并丢弃 10 万行。
- 批量导入/大变更后手动 ANALYZE（PG）/ ANALYZE TABLE（MySQL）——统计失准是慢计划的头号来源。
- MySQL 直方图记得随分布变化重建——它是静态快照，不会自动更新。
- 用 EXPLAIN (ANALYZE, BUFFERS)（PG）/ EXPLAIN ANALYZE（MySQL 8.0.18+）核对估算与实际——只看估算计划容易自欺。
- hint 必须附原因注释并登记复核——数据分布一变它就从药变成病。
- 压测/验证计划要用生产量级数据——千行小表上优化器的选择毫无参考价值。

## 常见误区

1. "优化器总会选出最优计划。" 它选的是"成本模型与搜索空间内的最优"，受估算误差、剪枝和启发式约束；模型错了，选择必然错。
2. "EXPLAIN 的 rows 是实际行数。" 它是估算；只有 ANALYZE 变体（MySQL 8.0.18+ / PG ANALYZE 选项）给出实际值。
3. "索引越多越好。" 每个索引都在放大写入（DML 维护所有索引）、占空间，还扩大优化器选错的可能。
4. "PG 的 cost 单位是毫秒。" 是无量纲内部单位（顺序页读=1），只做相对比较。
5. "JOIN 写在左边的表就是驱动表。" 优化器可自由重排；MySQL 8.0 hash join 连 build/probe 侧都可能换。别按书写顺序推理执行顺序。
6. "出现 Using filesort 就是慢。" 排 20 行无所谓；要看排序行数、宽度和是否落盘，别见字报警。

## 自测题

1. LEFT JOIN 在什么条件下会被优化器改写成 INNER JOIN？
   （内表列上有 NULL 拒绝谓词，使外补的 NULL 行必然被过滤时。）
2. type=index 一定优于 type=ALL 吗？给一个反例。
   （不一定：扫整棵索引且未覆盖时，每行还要回表，随机 IO 下可能比顺序全表扫更慢。）
3. PG 的 Index Only Scan 为什么有时仍访问堆？怎么消除？
   （页未在可见性映射中标记 all-visible 时需查堆确认可见性；VACUUM 后 Heap Fetches 归零。）
4. MySQL 8.0.18 之前，等值 join 无索引时会发生什么？之后呢？
   （之前退化为 Block Nested Loop，内层按块反复扫；之后走 hash join，两表各扫一遍，8.0.20 起 BNL 移除。）
5. EXPLAIN 显示 rows=2000，实际 500000，你的前两步排查是什么？
   （先查统计是否过期并 ANALYZE；再查条件列是否相关导致独立假设低估，考虑 CREATE STATISTICS。）
6. PG 预备语句什么时候从 custom plan 切到 generic plan？什么情况下会出问题？
   （前 5 次 custom，之后 generic 估算成本不劣于已用 custom 的平均值则切换；参数分布倾斜时"倒霉参数"套进 generic plan 变慢。）
7. 修正劣质计划的手段优先级是什么？为什么 hint 排最后？
   （改 SQL/索引 → 更新统计 → hint → 会话参数；hint 替优化器做决定，数据分布变化后失效甚至反噬，维护成本最高。）
8. CTE 在 PG 12 前后的行为差异是什么？MATERIALIZED 关键字有什么用？
   （12 前恒物化、是优化栅栏；12 起默认内联；MATERIALIZED 强制回到物化语义。）

## 关联阅读

- [./02-index.md](./02-index.md)——B+ 树结构与最左前缀，本篇扫描节点与 key_len 的物理基础。
- [./01-storage-engine.md](./01-storage-engine.md)——页、聚集索引与回表路径的存储层背景。
- [./08-buffer-pool.md](./08-buffer-pool.md)——成本模型里"随机 IO vs 顺序 IO"的真实来源。
- [./13-memory-sort-hash.md](./13-memory-sort-hash.md)——Sort/Hash 节点的内存与落盘细节。
- [./11-performance-tuning.md](./11-performance-tuning.md)——把本篇诊断方法落成调优流程。
- [./18-charset-collation.md](./18-charset-collation.md)——比较规则如何影响索引可用性与 key_len。
