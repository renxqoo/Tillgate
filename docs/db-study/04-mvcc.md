# 04 · 并发控制与 MVCC（Concurrency Control & MVCC）

> 隔离级别的承诺背后必然有实现。本篇拆开两套主流 MVCC（Multi-Version Concurrency Control，多版本并发控制）实现：InnoDB 的隐藏列 + undo 版本链 + ReadView，与 PostgreSQL 的 xmin/xmax + 提交状态日志 + 快照。讲清"读写互不阻塞"的代价——旧版本清理，给出"长事务让 PG DBA 焦虑"的完整因果链（表膨胀 → 事务 ID 回卷），并落到丢失更新的三种工程解法、隔离级别选择实践与可动手的验证实验。

## 读完本篇你应能回答

- MVCC 如何做到写不堵读、读不堵写？写与写之间呢？
- InnoDB 行上的隐藏列是什么？ReadView 的可见性判断规则？
- RC 与 RR 在 InnoDB 中的唯一实现差异是什么？
- PG 的 xmin / xmax / clog 如何协作？为什么 PG 的更新等于插入新版本？
- 长事务如何导致 PG 表膨胀与事务 ID 回卷（wraparound）？完整因果链？
- 为什么 MySQL RR 下"SELECT 看到 0 行、UPDATE 却影响 1 行"？
- 丢失更新的三种解法各适用什么场景？`SET TRANSACTION` 怎么用？

## 一、为什么需要 MVCC：读写互不阻塞

### 直觉

最朴素的并发控制是加锁：写者锁行、读者等写者。但真实业务读写比常常是几十比一，读等写会把延迟全部串起来。MVCC 的思路是：**修改不覆盖旧版本，而是保留多个历史版本；每个读按自己的快照决定看哪个版本**——像代码仓库：你提交你的分支，我 checkout 我的 commit，互不打扰。

### 结构：锁方案 vs MVCC 的时间线

```text
纯锁方案（读写互斥）                MVCC 方案（读写并行）

t  写事务 A        读事务 B        t  写事务 A          读事务 B
1  lock(r) 独占                    1  写新版本 r(v2)
2                 SELECT r        2                    SELECT r
3                 [阻塞等待...]    3                    读到 r(v1)，立即返回
4  COMMIT 释放锁                   4  COMMIT
5                 返回结果         5  （旧版本暂留，供更早的快照继续读）
   B 等待 ≈ A 的整个事务              读写双方零等待
```

### 机制细节

MVCC 只解耦"读 vs 写"；**同一行的写与写仍然互斥**——后写者要么等先写者的行锁，要么被中止（两库策略不同，见第四节）。版本也不能无限保留：只有"还可能被某个活跃快照读到"的版本才有存在意义，因此**清理机制（InnoDB 的 purge、PG 的 VACUUM）是 MVCC 的另一半**，这是本篇后半的主线。

### 对开发者的实际影响

高并发读写混合负载（典型 Web 应用：读远多于写）下，普通 SELECT 不加锁、不被写阻塞——这是两库读吞吐的根基。代价是更新成本变高（写新版本 / 记 undo）和空间膨胀风险。

## 二、InnoDB 的 MVCC：隐藏列 + undo 版本链 + ReadView

### 每行自带"修改账本"：三个隐藏列

| 隐藏列 | 大小 | 含义 |
|---|---|---|
| `DB_TRX_ID` | 6 字节 | 最近一次插入或更新该行的事务 ID |
| `DB_ROLL_PTR` | 7 字节 | 回滚指针，指向 undo log 中该行的上一版本 |
| `DB_ROW_ID` | 6 字节 | 表既没有主键也没有非空唯一索引时，InnoDB 自动生成的聚簇行号；有主键则不占 |

UPDATE 就地修改聚簇索引行（更新 `DB_TRX_ID`、`DB_ROLL_PTR`），旧值整行写入 undo log，形成版本链：

```text
当前行（最新值）              undo log 中的版本链（由新到旧）

+====================+
| name    = 'bob'    |
| balance = 80       |        +====================+
| DB_TRX_ID    = 103 |------->| balance = 70       |
| DB_ROLL_PTR  = ●   |        | DB_TRX_ID    = 101 |---+
+====================+        | DB_ROLL_PTR  = ●   |   |   +====================+
  trx 103: 70 → 80            +====================+   +-->| balance = 100      |
  （已提交）                    trx 101: 100 → 70          | DB_TRX_ID    = 99  |
                                                           | DB_ROLL_PTR  = NULL|
                                                           +====================+
                                                             trx 99: 初始 INSERT

一致性读：从当前行开始判断可见性；不可见就沿 DB_ROLL_PTR 向旧走，
直到找到第一个可见版本；走到链尾仍不可见 → 该行对本事务"不存在"。
```

### ReadView：可见性判断的"时间切片"

一致性读（consistency read）开始时生成读视图（ReadView），本质是给事务 ID 数轴拍一张快照，由四部分组成：

- `m_ids`：生成时刻仍活跃（未提交）的事务 ID 集合；
- `min_trx_id`：`m_ids` 中的最小值（资料中也叫 up_limit_id，可见上界）；
- `next_trx_id`：系统中下一个将要分配的事务 ID（也叫 low_limit_id / max_trx_id，不可见下界——命名反直觉，记语义别记名字）；
- `creator_trx_id`：创建该 ReadView 的事务自己。

```text
生成 ReadView 时的事务 ID 数轴：

  已提交（可见）           快照时刻仍活跃（不可见）              未来（不可见）
 ◄──────────────┤├────────────────────────────────┤├─────────────────────►
            min_trx_id                             next_trx_id
         （活跃集合中最小）                    （下一个将分配的 ID）
                m_ids：活跃事务集合（不含已提交、不含创建者自己）
                creator_trx_id：创建者自己
```

行可见性判断，逐步伪代码：

```text
function visible(row, rv):                 # rv = ReadView
    trx = row.DB_TRX_ID
    1. trx == rv.creator_trx_id → 可见     # 自己改的，当然可见
    2. trx <  rv.min_trx_id      → 可见     # 快照之前已提交
    3. trx >= rv.next_trx_id     → 不可见   # 快照之后才开启的事务
    4. trx in rv.m_ids           → 不可见   # 快照时仍活跃，提交与否与我无关
    5. 否则                      → 可见     # 快照期间提交完成

一致性读主流程：
    版本 = 当前行
    while 版本不可见 且 有上一版本:
        版本 = DB_ROLL_PTR 指向的下一旧版本
    return 可见版本；链尾仍不可见 → "行不存在"
```

### RC 与 RR 的唯一实现差异

| | READ COMMITTED | REPEATABLE READ（MySQL 默认） |
|---|---|---|
| ReadView 生成时机 | **每条**一致性读语句生成新的 | 事务内**第一条**一致性读时生成，之后一直复用 |
| 效果 | 每句都能看到此前已提交的最新数据 | 整个事务固定在同一个快照 |
| 快照建立点 | 语句执行时 | 第一条 SELECT 时；`START TRANSACTION WITH CONSISTENT SNAPSHOT` 则在 BEGIN 时 |

推论：RR 下 `BEGIN` 后停 10 分钟才执行第一条 SELECT，看到的是 **SELECT 那一刻**的世界，不是 BEGIN 那一刻——排障时最容易搞错的一点。

## 三、PostgreSQL 的 MVCC：xmin / xmax + clog + 快照

### 直觉

PG 不维护 undo 链，而是把堆表（heap）当版本仓库：**UPDATE = 插入一个新版本行 + 旧版本标记删除**。可见性不靠回溯链，靠每行的创建/删除事务 ID 与全局提交状态比对。

### 结构：一次 UPDATE 前后的堆页

每个堆元组带两个系统列：`xmin` = 创建该版本的事务 ID（INSERT 或 UPDATE 产生的新行）；`xmax` = 删除（或更新/锁定）该版本的事务 ID，0 表示尚未删除。

```text
UPDATE accounts SET balance=80 WHERE id=1;   （事务 103，已提交）

堆页：旧版本（trx 99 INSERT 的行）     新版本（trx 103 UPDATE 产生的行）
+------------------------------+     +------------------------------+
| (1, 'alice', balance=100)    |     | (1, 'alice', balance=80)     |
| xmin=99        xmax=103      |     | xmin=103       xmax=0        |
+------------------------------+     +------------------------------+
         ↑                                    ↑
 快照在 103 提交前建立：              快照在 103 提交后建立：
 xmin=99 已提交 → 可见；              旧版本 xmax=103 已提交且对我可见
 xmax=103 的删除对我不可见            → 该版本"已删除"；新版本可见
 → 旧版本继续可见

103 提交后，旧版本不再被任何未来快照需要 → 死元组（dead tuple）
```

### 机制细节

- "某事务到底提交没有"查提交日志（commit log，clog，数据目录 `pg_xact/`）：每个事务 2 bit 状态（进行中 / 已提交 / 已中止）。
- **快照**是三元组 `(xmin, xmax, xip_list)`：xmin = 当前最老活跃事务 ID，xmax = 下一个将分配的 ID，xip_list = 两者之间仍活跃的事务集合。版本可见 ≈ "创建者已提交且早于我的快照，且删除者未提交或不早于我的快照"。
- PG 索引项不含版本信息，指向堆版本；同一行更新后新旧版本都可能被索引指到。若更新的列不被任何索引引用，可走 HOT（Heap-Only Tuple）更新：新版本放同一页、不写新索引项，靠页内指针跳转——PG 更新开销的关键优化点。
- **回滚极廉价**：把事务在 clog 标为 aborted 即可，新版本行立即对所有人不可见，不需要逻辑反演（对比 InnoDB 的 undo 补偿，03 篇）。

### 对开发者的实际影响

PG 频繁 UPDATE 的表会持续堆积死元组，表与索引膨胀 → 扫描变慢、页内版本链变长；写密集更新热点是 PG 调优重点（autovacuum 调参、fillfactor、HOT 利用率，见 11 篇）。

## 四、快照读 vs 当前读

| 读类型 | 语句 | 读哪个版本 | 加锁 |
|---|---|---|---|
| 快照读（一致性读） | 普通 `SELECT`（MySQL、PG 都是） | ReadView / 快照决定的版本 | 不加锁 |
| 当前读（locking read） | MySQL：`UPDATE`、`DELETE`、`SELECT ... FOR UPDATE / FOR SHARE` | 最新已提交版本 | 行锁 / Next-Key Lock |
| 锁定读（PG 等价物） | PG：`SELECT ... FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE` 四档；`UPDATE`/`DELETE` 内部同样锁行 | 最新版本 | 行锁 |

经典翻车现场——MySQL RR 下"SELECT 0 行、UPDATE 1 行"。准备：`CREATE TABLE t (id INT PRIMARY KEY, val INT NOT NULL);`（表为空）

| t | 会话 A（RR） | 会话 B |
|---|---|---|
| 1 | `BEGIN;` | |
| 2 | `SELECT * FROM t WHERE id = 1;` → **0 行**（ReadView 建立） | |
| 3 | | `INSERT INTO t VALUES (1, 0); COMMIT;` |
| 4 | `SELECT * FROM t WHERE id = 1;` → **0 行**（同一 ReadView，看不见 B 的提交） | |
| 5 | `UPDATE t SET val = 1 WHERE id = 1;` → **Query OK, 1 row affected** | |
| 6 | `SELECT * FROM t WHERE id = 1;` → **1 行**（该行 DB_TRX_ID 已变成自己） | |
| 7 | `COMMIT;` | |

原因：第 4 步是快照读，第 5 步 UPDATE 是**当前读**——直接操作最新已提交版本，绕过 ReadView。这不是 bug：更新必须建立在最新数据上，否则会覆盖别人的提交。同场景下 PG 行为不同：RR（快照隔离）中 A 的 UPDATE 会报 `ERROR: could not serialize access due to concurrent update`（SQLSTATE 40001），要求整个事务重试。**InnoDB 选择"读最新并继续"，PG 快照隔离选择"拒绝并重试"——这是两库隔离语义最重要的分歧点。**

## 五、旧版本清理：purge vs VACUUM

MVCC 的账单：旧版本占空间，必须回收；回收的前提是"没有任何快照还要读它"。

### InnoDB：purge 线程

当某行的 undo 版本对现存所有 ReadView 都不再可见（最老 ReadView 之后的版本），purge 线程（`innodb_purge_threads`，默认 4）清理过期 undo，并物理删除 delete-marked 的行。undo 表空间独立于数据表空间，MySQL 8.0 默认开启自动收缩（`innodb_undo_log_truncate = ON`，超过 `innodb_max_undo_log_size` 默认 1GB 时触发 truncate）。**长事务持有老 ReadView → purge 水位推不动 → undo 表空间膨胀。**

### PostgreSQL：VACUUM / autovacuum

死元组回收依赖 VACUUM：普通 `VACUUM` 把死元组空间标记为页内复用（一般不还给操作系统；缩小文件需要 `VACUUM FULL`（锁表）或 pg_repack）。autovacuum worker 按统计自动触发，默认阈值约为"表 20% 的死元组 + 50 行"（`autovacuum_vacuum_scale_factor` / `autovacuum_vacuum_threshold`）。

观测死元组（可直接执行）：

```sql
-- PostgreSQL 16
CREATE TABLE demo (id INT PRIMARY KEY, pad TEXT);
INSERT INTO demo SELECT g, 'x' FROM generate_series(1, 10000) g;
UPDATE demo SET pad = 'y';   -- 10000 个新版本；旧版本全部成为死元组
SELECT n_live_tup, n_dead_tup
FROM pg_stat_user_tables WHERE relname = 'demo';
-- n_dead_tup ≈ 10000（统计有毫秒级延迟）
VACUUM demo;
SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'demo';   -- 0
```

### 事务 ID 回卷（wraparound）：长事务让 PG DBA 焦虑的完整因果链

PG 的事务 ID（xid）是 **32 位**，共约 42.9 亿个。xid 比较按模 2^32 环形进行，任意时刻必须能用一半环形空间区分"过去"与"未来"，**实际可用窗口约 21 亿（2^31）**。因此每一行的 `xmin` 必须在老化到回卷距离之前被替换为特殊的冻结 ID（FrozenXID，语义为"比一切快照都老、永远可见"），这个动作叫 freeze。因果链如下：

1. 任意一种"钉子"出现：长事务 / `idle in transaction` 连接 / 复制槽（replication slot）积压 / 未决的两阶段提交事务；
2. 全库最老快照（oldest xmin）被钉住，清理水位线不再前进；
3. 水位线之后产生的死元组一个都回收不了 → 表和索引持续膨胀（bloat）；
4. freeze 同样推不动 → 数据库的 xid 年龄（age）持续增长；
5. 逼近 2^31 时：autovacuum 发起反回卷（anti-wraparound）清理（不可禁用、高 I/O）；仍推不动则告警 `database "..." must be vacuumed within N transactions`；最终拒绝分配新 xid，报 `database is not accepting commands to avoid wraparound data loss`，整库只读级故障。

所以 PG 圈的口头禅是：**表膨胀往往不是 VACUUM 没跑，而是有东西钉住了清理水位线**。排查顺序：长事务 → 复制槽（`pg_replication_slots`）→ 两阶段残留（`pg_prepared_xacts`）。MySQL 的事务 ID 为 48 位且随 undo 生命周期管理，没有等价的全库回卷风险，长事务的伤害集中在 undo 膨胀与锁。

### 两库清理机制对比

| 维度 | InnoDB | PostgreSQL |
|---|---|---|
| 旧版本存放 | undo log（集中存放，表中只留最新版本） | 堆表本身（新旧版本混在页里） |
| 清理者 | purge 线程（自动、持续） | VACUUM / autovacuum（批量、按需） |
| 膨胀表现 | undo 表空间增长 | 表 + 索引膨胀，页内版本链变长 |
| 水位线被谁钉住 | 长事务的 ReadView | 长事务快照、复制槽、两阶段残留 |
| 空间回收 | undo 表空间自动 truncate（8.0） | 页内复用为主；还给 OS 需 VACUUM FULL / pg_repack |
| 特有风险 | undo 膨胀、回滚成本 | bloat + 事务 ID 回卷 |

## 六、丢失更新的三种解法

回顾 03 篇的时间线：两个事务都"读旧值 → 计算 → 写回"，后写覆盖先写。三种工程解法，按成本递增：

### 1. 数据库原子 UPDATE：把计算下推到 SQL

```sql
-- MySQL 8.0 / PostgreSQL 16 通用
UPDATE counters SET n = n + 1 WHERE id = 1;
UPDATE accounts SET balance = balance - 30 WHERE id = 1 AND balance >= 30;
-- 应用只检查 affected rows：0 表示余额不足（或行不存在）
```

单语句天然原子，行锁保证并发串行执行，"读 → 算 → 写"在一个不可分割的动作里完成。**适用：增量/条件语义（加减、状态机迁移）。凡是能用一条 UPDATE 表达的，不要写成先 SELECT 再 UPDATE。**

### 2. 悲观锁：SELECT ... FOR UPDATE

```sql
-- MySQL 8.0 / PostgreSQL 16 通用（先锁后算）
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;  -- 行锁；并发同语句在此排队
-- 应用层执行复杂校验与计算（必须快，锁正被持有）
UPDATE accounts SET balance = <计算结果> WHERE id = 1;
COMMIT;   -- 或 ROLLBACK，锁同样释放
```

**适用：写前需要复杂业务判断（多表联动、外部规则）**。注意三点：持锁区间只含必要逻辑；MySQL RR 下 FOR UPDATE 是当前读，会打破"快照"直觉；多行加锁按固定顺序访问，避免死锁（05 篇）。

### 3. 乐观锁：版本列 CAS

```sql
-- MySQL 8.0 / PostgreSQL 16 通用
ALTER TABLE docs ADD COLUMN version INT NOT NULL DEFAULT 0;

-- 读出 (body, version=7)，用户编辑提交后：
UPDATE docs SET body = '新内容', version = version + 1
WHERE id = 1 AND version = 7;
-- affected rows = 0 → 期间有人先提交 → 重读、合并、重试或提示冲突
```

**适用：冲突率低的场景（后台表单编辑、协作文档）；跨用户交互的长流程无法持锁，乐观锁是唯一现实选择。** 冲突率升高后重试风暴反而劣化吞吐——乐观不等于更快，只是把等待换成了重试。

| 方案 | 一致性来源 | 适用场景 | 代价 / 风险 |
|---|---|---|---|
| 原子 UPDATE | 单语句原子性 + 行锁 | 增量、条件迁移 | 几乎为零，首选 |
| FOR UPDATE 悲观锁 | 显式互斥 | 复杂读写决策、多表联动 | 持锁等待、死锁、吞吐下降 |
| 版本列乐观锁 | 应用层 CAS | 低冲突、长交互流程 | 冲突重试、需要冲突处理逻辑 |

## 七、隔离级别选择实践

- **默认级别够用就别动**：MySQL RR 让普通读免费获得可重复读；PG RC 语义直白、写冲突少。绝大多数 CRUD / 展示场景的正确性来自约束与写法，不来自更高级别。
- **显式升级的场景**：多表联动的金额操作，要么 SERIALIZABLE + 重试逻辑，要么显式 FOR UPDATE 编排；PG SERIALIZABLE 下被中止的事务收到 SQLSTATE 40001，应用必须捕获并整体重试；MySQL SERIALIZABLE 下普通 SELECT 隐式加共享锁，读写互相阻塞，吞吐代价要事先压测。
- **容忍陈旧的读取**：报表、看板可用 PG 的 RR 快照读或备库读（09 篇），换取主库压力下降。
- **`SET TRANSACTION` 只影响下一个事务**，用完自动恢复会话默认——把特殊语义限制在最小范围：

```sql
-- MySQL 8.0：须在事务外执行（事务内报 ERROR 1568）
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN;
-- ... 金额联动操作 ...
COMMIT;   -- 之后自动回到会话默认（RR）

-- PostgreSQL 16：作为事务内第一条语句，或直接写进 BEGIN
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- 等价于：BEGIN; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
COMMIT;

-- 改会话默认（慎重：影响该连接所有后续事务）
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;         -- MySQL
SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED; -- PostgreSQL
```

## 八、验证实验：复现不可重复读（RR vs RC）

### MySQL 8.0（两个 mysql 客户端，按行序执行）

```sql
-- 任一会话执行一次：
CREATE TABLE t (id INT PRIMARY KEY, val INT NOT NULL);
INSERT INTO t VALUES (1, 10);

-- ── 实验 1：默认 REPEATABLE READ ──────────────────────────────
-- 会话 A                                     会话 B
BEGIN;
SELECT val FROM t WHERE id = 1;   -- 10
                                              BEGIN;
                                              UPDATE t SET val = 20 WHERE id = 1;
                                              COMMIT;
SELECT val FROM t WHERE id = 1;   -- 10（同一 ReadView，看不到 B 的提交）
COMMIT;

-- ── 实验 2：切到 READ COMMITTED ──────────────────────────────
-- 会话 A 先执行：
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN;
SELECT val FROM t WHERE id = 1;   -- 20
                                              BEGIN;
                                              UPDATE t SET val = 30 WHERE id = 1;
                                              COMMIT;
SELECT val FROM t WHERE id = 1;   -- 30（每条语句新建 ReadView）
COMMIT;
```

### PostgreSQL 16（两个 psql 会话，按行序执行）

```sql
-- 任一会话执行一次：
CREATE TABLE t (id INT PRIMARY KEY, val INT NOT NULL);
INSERT INTO t VALUES (1, 10);

-- ── 实验 1：默认 READ COMMITTED ──────────────────────────────
-- 会话 A                                     会话 B
BEGIN;
SELECT val FROM t WHERE id = 1;   -- 10
                                              BEGIN;
                                              UPDATE t SET val = 20 WHERE id = 1;
                                              COMMIT;
SELECT val FROM t WHERE id = 1;   -- 20（RC：每语句新快照，读到新值）
COMMIT;

-- ── 实验 2：REPEATABLE READ（快照隔离）───────────────────────
-- 会话 A：
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT val FROM t WHERE id = 1;   -- 20（快照在此刻建立）
                                              BEGIN;
                                              UPDATE t SET val = 30 WHERE id = 1;
                                              COMMIT;
SELECT val FROM t WHERE id = 1;   -- 20（SI：固定快照）
UPDATE t SET val = val + 1 WHERE id = 1;
-- ERROR: could not serialize access due to concurrent update
ROLLBACK;
```

实验 2 的最后一步就是两库语义分歧的现场：**同样 RR，MySQL 的当前读直接操作最新已提交值，PG 的快照隔离拒绝写入并要求重试。**

## 开发者清单

**该做：**

- 普通 SELECT 交给快照读——不加锁、不被写阻塞，锁定读只在真正要互斥时用。
- 任何"读-改-写"用原子 UPDATE / FOR UPDATE / 版本列三选一——隔离级别不防丢失更新。
- 能用一条条件 UPDATE 表达的判断，不要拆成 SELECT + UPDATE——单语句天然原子，affected rows 就是判定依据。
- PG 应用必须处理 40001（serialization_failure）与事务中止——SI / SSI 下重试是协议的一部分（SSI = Serializable Snapshot Isolation，可串行化快照隔离，即 PG SERIALIZABLE 级别的实现方式）。
- PG 写密集表盯 `n_dead_tup`、表年龄（`age(relfrozenxid)`）与复制槽积压——它们钉住清理水位线。
- MySQL 盯 undo 表空间尺寸与 `innodb_trx`——长事务是膨胀与锁链的共同上游。
- 需要特殊隔离时用 `SET TRANSACTION` 限定单事务——缩小影响面，避免隐性行为变化。
- 频繁 UPDATE 的 PG 表避免更新索引列——保住 HOT 更新路径，降低索引维护与膨胀。

**不该做：**

- 不要说"MVCC 所以没有锁"——只是读写不互斥；同行写-写依旧串行，FOR UPDATE 依旧是锁。
- 不要在 MySQL RR 下假设 SELECT 结果就是"当前数据状态"——UPDATE / DELETE 走当前读，看到的是另一份世界。
- 不要让事务横跨用户思考时间或外部调用——快照水位、死元组、锁全部随事务时长恶化。
- 不要指望升级隔离级别解决丢失更新——RC / RR 都挡不住写覆盖写，要换写法或用显式锁。
- 不要把 PG 的膨胀全归咎于 autovacuum 没跑——更常见的是长事务 / 复制槽钉住水位线，让它跑不了。
- 不要在冲突率高的路径上用乐观锁——重试风暴比排队更伤吞吐。

## 常见误区

1. **"MVCC 意味着没有锁。"** 只解除了读写互斥；同行写-写依旧串行（行锁），`FOR UPDATE` 依旧是锁。更新热点行多时 MVCC 救不了吞吐。
2. **"MySQL RR 下 SELECT 查不到的行，UPDATE 也不会影响。"** UPDATE 是当前读，操作最新已提交版本——"0 行 SELECT、1 行 affected"完全可能同时成立（第四节实例）。
3. **"PG RR 防住了幻读，所以事务结果一定正确。"** 快照隔离防不可重复读与幻读，但存在写倾斜（write skew）类异常：并发更新不同行仍可能破坏跨行不变量。要绝对可串行化需 SERIALIZABLE（SSI）。
4. **"VACUUM 之后空间就还给磁盘了。"** 普通 VACUUM 只做页内复用；缩小物理文件需要 VACUUM FULL（锁表）或 pg_repack。
5. **"读旧版本是免费的。"** InnoDB 版本链越长回溯越慢；PG 页内死版本越多扫描越贵、膨胀本身就是性能问题，不只是空间问题。
6. **"ReadView 是 BEGIN 时生成的。"** MySQL RR 的 ReadView 在事务内第一条一致性读时才生成（`WITH CONSISTENT SNAPSHOT` 除外）；PG 快照同样在事务第一条语句执行时取得。BEGIN 与第一条读之间隔了多久，排障时必须算进去。

## 自测题

1. 不看上文，默写 ReadView 的四条可见性判断规则。
   （== creator_trx_id 可见；< min_trx_id 可见；>= next_trx_id 不可见；在 m_ids 不可见；否则可见。不可见则沿版本链向旧走。）
2. InnoDB RC 与 RR 的唯一实现差异是什么？
   （ReadView 生成时机：RC 每条语句新建，RR 首条快照读建立后全程复用。）
3. PG 的 UPDATE 物理上做了什么？回滚时又发生什么？
   （插入新版本行（新 xmin）+ 旧版本记 xmax；回滚只需 clog 标记 aborted，新版本即不可见。）
4. xid 共 42.9 亿个，为什么回卷窗口说约 21 亿？
   （比较按模 2^32 环形进行，任意时刻只能用一半空间区分过去/未来。）
5. "长事务让 PG DBA 焦虑"的因果链有哪五步？
   （钉住 oldest xmin → 死元组不可回收 → 膨胀 + freeze 停滞 → xid 年龄增长 → 反回卷高 I/O / 拒绝新事务。）
6. RR 下对"快照建立后被人更新过的行"，MySQL 与 PG 分别怎么处理？
   （MySQL 当前读读最新已提交值并加锁继续；PG 报 40001 要求整个事务重试。）
7. 计数器 +1、后台表单保存、转账多表校验，分别选哪种防丢失更新？
   （原子 UPDATE；版本列乐观锁；FOR UPDATE（或 SERIALIZABLE + 重试）。）
8. 快照读会阻塞写吗？写会阻塞快照读吗？那什么还在互斥？
   （都不阻塞；同行写-写互斥；且写产生的历史版本会留到清理者能回收为止。）

## 关联阅读

- [./03-transaction-acid.md](./03-transaction-acid.md)——隔离级别矩阵、四种并发异常与事务边界设计。
- [./05-lock.md](./05-lock.md)——行锁、间隙锁、Next-Key Lock、死锁与锁等待排查。
- [./06-wal-recovery.md](./06-wal-recovery.md)——redo/WAL 如何支撑提交与恢复，MVCC 版本的另一半账本。
- [./01-storage-engine.md](./01-storage-engine.md)——聚簇索引、堆表与页结构：版本存放位置的物理基础。
- [./08-buffer-pool.md](./08-buffer-pool.md)——脏页、刷盘与 checkpoint：与 undo/版本清理的联动。
- [./09-replication-ha.md](./09-replication-ha.md)——复制槽钉住 xmin、备库读与陈旧读取。
- [./11-performance-tuning.md](./11-performance-tuning.md)——膨胀治理、autovacuum 调参与更新热点。
