# 05 · 锁与阻塞（Locks & Blocking）

> 事务保证了"全做或全不做"，但没有规定并发时谁先谁后——这是锁的职责。本篇建立锁的类型、粒度、强度三套坐标系，讲清 InnoDB 行锁的真实形态（它锁的是索引记录，不是"行"）、死锁的成因与两套数据库的不同解法，最后给出排查工具与工程规避手段。学完之后，线上"这条 SQL 突然卡住不动"的问题，你应该能自己定位到锁这一层。

## 读完本篇你应能回答

- 共享锁（Shared Lock, S）与排他锁（Exclusive Lock, X）的兼容规则是什么？意向锁（Intention Lock, IS/IX）解决什么问题？
- 为什么说"InnoDB 的行锁挂在索引上"？没有索引可用时，一条 UPDATE 会锁住多少数据？
- 记录锁（Record Lock）、间隙锁（Gap Lock）、下一键锁（Next-Key Lock）分别锁住什么？为什么 REPEATABLE READ 需要它们？
- 死锁（Deadlock）如何形成？MySQL 与 PostgreSQL 各自怎么检测、怎么选牺牲者？
- 出现锁等待时，用什么 SQL 查出"谁在等谁、等在哪一行"？
- PostgreSQL 的表锁 8 种模式、行锁 4 种强度，与 MySQL 的体系差在哪里？

## 一、为什么需要锁：并发下的占用-等待模型

**直觉**：锁是数据库内部的占座牌——"这个座位我坐了，你要么等，要么换一座"。没有占座规则，并发的先读后写就会互相覆盖。

**结构**：最常见的翻车现场是应用层"先 SELECT、算一算、再 UPDATE"：

```text
不加锁：丢失更新（lost update）
──────────────────────────────────────────────
A: SELECT balance → 100（普通读，不加锁）
B: SELECT balance → 100
A: 应用算出 70，UPDATE ... SET balance = 70，COMMIT
B: 应用算出 80，UPDATE ... SET balance = 80，COMMIT
结果：明明扣了 50，账面只少 20 ✗

加 X 锁串行化：SELECT ... FOR UPDATE
──────────────────────────────────────────────
A: SELECT ... FOR UPDATE → 100，对行加 X 锁
B: SELECT ... FOR UPDATE → 阻塞，等 A 释放
A: UPDATE ... SET balance = 70，COMMIT，释放锁
B: 被唤醒，读到 70，UPDATE ... SET balance = 50，COMMIT ✓
```

**机制**：数据库为每个被锁资源维护"持锁者列表"，为每个事务维护"等待队列"。一次加锁申请就是查一次兼容矩阵（见下节）：兼容则登记，冲突则挂入等待队列——MySQL 里表现为锁等待（最终 `ERROR 1205` 或死锁），PG 里表现为 `pg_stat_activity` 里 `wait_event_type = 'Lock'`。

**影响**：请求超时、连接池耗尽、CPU 空转但吞吐为零——生产上一大类"数据库变慢"最后都落到"某个事务拿着锁不放"。理解锁，就是理解数据库的排队规则。

## 二、类型与强度：S/X 锁与表级意向锁

**直觉**：S 锁是"都可以来看"，X 锁是"我一个人改"。看与看不冲突，改与任何人都冲突。

**结构**：行级 S/X 的兼容矩阵（✓ 兼容、✗ 冲突）：

| 已持有 \ 新请求 | S（共享） | X（排他） |
|---|---|---|
| S（共享） | ✓ | ✗ |
| X（排他） | ✗ | ✗ |

**机制**：普通 `SELECT` 不加任何行锁（靠 MVCC，见 [04 篇](./04-mvcc.md)）；`SELECT ... FOR UPDATE` 加 X，`SELECT ... FOR SHARE`（MySQL 8.0 语法，替代旧的 `LOCK IN SHARE MODE`）加 S；INSERT/UPDATE/DELETE 加 X。所以"两个 `FOR UPDATE` 必互斥，两个 `FOR SHARE` 可共存，普通 SELECT 谁都不挡"。

再往上还有表级意向锁。行锁加锁前必须先在表上挂一个"意向"标记：加行级 S 前挂表级 IS，加行级 X 前挂表级 IX。表级四类锁的兼容矩阵：

| 已持有 \ 新请求 | IS | IX | S（表级） | X（表级） |
|---|---|---|---|---|
| IS | ✓ | ✓ | ✓ | ✗ |
| IX | ✓ | ✓ | ✗ | ✗ |
| S（表级） | ✓ | ✗ | ✓ | ✗ |
| X（表级） | ✗ | ✗ | ✗ | ✗ |

```text
            表 orders
   ┌──────────┴
   │ 表级锁：S / X / IS / IX
   │   加行级 S 前先挂 IS；加行级 X 前先挂 IX
   │   意向锁之间互相兼容（IS-IX 也不冲突）
   │
   ├─ 索引 PRIMARY(id)
   │    记录 id=1  ←── 行锁挂在这里
   │    记录 id=5  ←── 记录锁 / Next-Key Lock
   │    间隙 (1,5) ←── 间隙锁锁的是"位置"，不是行
   └─ 索引 idx_buyer(buyer) ...

   意向锁的价值：想加表级锁的事务只看表头有没有 IS/IX，
   一眼判断"表里有没有行锁"，不必逐行扫描百万条记录。
```

**影响**：意向锁本身几乎不制造麻烦（意向锁之间兼容）；它解释了锁视图里成对出现的 `TABLE IX + RECORD X`。真正会"锁整张表"的是 DDL 相关的元数据锁（MDL，Metadata Lock）与显式 `LOCK TABLES`——见第七节的排查部分。

## 三、锁粒度与代价：表锁、行锁，以及"没有索引时锁多少"

**直觉**：表锁是锁整本书，行锁是锁某一页。粒度越细并发越高，但簿记成本越高——每锁一条索引记录都要登记一条锁记录。

**结构**：两种粒度的权衡：

| 维度 | 表级锁 | 行级锁 |
|---|---|---|
| 加锁成本 | 一次登记，成本恒定 | 每条索引记录一条锁记录，量大时耗内存与 CPU |
| 并发度 | 整表串行 | 不同行互不干扰 |
| 谁在用 | MyISAM 表锁、`LOCK TABLES`、MDL（DDL） | InnoDB（挂索引记录）、PG（挂行版本） |
| 典型事故 | 长查询/长事务挡住 DDL，后续请求全排队 | 无索引 UPDATE 锁放大、死锁 |

**机制——本节最重要的一个事实**：InnoDB 的行锁挂在索引记录上，不是挂在"行的物理位置"上。因此：

- `UPDATE ... WHERE id = 1` 锁主键上 id=1 这条索引记录；
- `UPDATE ... WHERE buyer = 'alice'` 若有 `idx(buyer)`，锁二级索引上的 alice 记录及对应主键记录；
- 若 WHERE 条件没有任何索引可走，InnoDB 沿主键全表扫描，**对扫过的每一行都加锁**。同时 InnoDB 不做锁升级（lock escalation，SQL Server 那种"行锁多了自动并成表锁"的机制不存在），锁记录一条条挂上去：REPEATABLE READ（RR，MySQL 默认隔离级别）下所有记录连同所有间隙都被 Next-Key 封住，效果接近锁全表；锁本身也吃内存。READ COMMITTED（RC）下借助半一致读（semi-consistent read），不匹配 WHERE 的行加锁后即释放，最终只锁匹配行。

可复现实验（MySQL 8.0，默认 RR）：

```sql
-- MySQL 8.0
CREATE TABLE orders (
  id    BIGINT PRIMARY KEY,
  buyer VARCHAR(32) NOT NULL,   -- 注意：buyer 上没有索引
  amt   INT NOT NULL
) ENGINE = InnoDB;

INSERT INTO orders (id, buyer, amt) VALUES (1, 'alice', 10), (2, 'bob', 20), (3, 'carol', 30);
```

| 时刻 | 会话 A | 会话 B |
|---|---|---|
| t1 | `BEGIN; UPDATE orders SET amt = amt + 1 WHERE buyer = 'alice';`（走主键全表扫描） | |
| t2 | | `INSERT INTO orders VALUES (4, 'dave', 40);` → **阻塞**（间隙也被 A 封住） |
| t3 | `COMMIT;` | B 的插入恢复执行 |

把两个会话都执行 `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;` 后重放：t2 不再阻塞——RC 下没有间隙锁，且不匹配行的锁已释放。

**影响**：UPDATE/DELETE 的 WHERE 必须能命中索引（`EXPLAIN` 确认 `type` 不是 `ALL`），这是"一条 UPDATE 拖垮整个库"的最常见原因；两个数量级的心理锚点：百万行表的无索引 UPDATE，意味着百万条锁记录加全表间隙封锁，期间该表的其他 DML 基本全部排队。

## 四、InnoDB 行锁三形态：记录锁、间隙锁、Next-Key Lock

**直觉**：记录锁锁"点"，间隙锁锁"线段"，Next-Key Lock 是"线段+右端点"。RR 要防的不只是"别人改我读过的行"，还有"别人往我读过的范围里插入新行"（幻读，phantom read）——防插入就得锁位置之间的空隙。

**结构**：对唯一索引上的值 {10, 20, 30}，InnoDB 把索引划成四个 Next-Key 区间（左开右闭，最大值后还有一条 supremum 伪记录）：

```text
索引 idx 上的值：    10          20          30        supremum
                    │           │           │            │
间隙划分：    (-∞,10)  (10,20)   (20,30)    (30,+∞)
Next-Key：    (-∞,10]  (10,20]   (20,30]    (30,+∞]

会话 A 执行：SELECT * FROM items WHERE id > 10 FOR UPDATE;
获得 Next-Key：(10,20] + (20,30] + (30,+∞]

会话 B 的插入：
   INSERT 5  → 落在 (-∞,10]，未上锁        → 立即成功
   INSERT 15 → 落在 (10,20]，被锁          → 阻塞
   INSERT 25 → 落在 (20,30]，被锁          → 阻塞
   INSERT 99 → 落在 (30,+∞)，被锁          → 阻塞
```

**机制**：三种形态逐个说。

- **记录锁（Record Lock）**：锁索引记录本身。唯一索引等值命中已存在的记录时，Next-Key 退化为纯记录锁（唯一了就没有"插入同值"的威胁，无需封间隙）。反之，唯一索引等值**未命中**（如 `WHERE id = 15 FOR UPDATE` 而 15 不存在）会锁住 (10,20) 这个间隙，别人的 `INSERT 15` 被阻塞。
- **间隙锁（Gap Lock）**：锁开区间 (a, b)，只在 RR 存在，唯一目的是阻止别人向区间插入。注意一个反直觉的性质：**不同事务可以同时持有同一间隙的 Gap Lock**——间隙锁只挡插入，不挡彼此。
- **Next-Key Lock**：记录锁 + 该记录前面的间隙，即左开右闭区间 (a, b]。RR 下 InnoDB 范围扫描的默认加锁单位。

可复现实验（MySQL 8.0，默认 RR）：

```sql
-- MySQL 8.0
CREATE TABLE items (id INT PRIMARY KEY) ENGINE = InnoDB;
INSERT INTO items VALUES (10), (20), (30);
```

| 时刻 | 会话 A | 会话 B |
|---|---|---|
| t1 | `BEGIN; SELECT * FROM items WHERE id > 10 FOR UPDATE;`（锁 (10,20]、(20,30]、(30,+∞)） | |
| t2 | | `INSERT INTO items VALUES (15);` → 阻塞 |
| t3 | | `INSERT INTO items VALUES (5);` → 立即成功（该区间未锁） |
| t4 | `COMMIT;` | t2 的插入恢复执行 |

在第三个连接里可以看到 A 拿到的锁：

```sql
-- MySQL 8.0 · 第三个连接
SELECT ENGINE_TRANSACTION_ID, LOCK_TYPE, LOCK_MODE, LOCK_DATA
FROM performance_schema.data_locks
WHERE OBJECT_NAME = 'items' AND LOCK_TYPE = 'RECORD';
-- LOCK_DATA 出现 20、30、supremum；LOCK_MODE 为 X
-- （纯 X 即 Next-Key；X,REC_NOT_GAP 是纯记录锁；X,GAP 是纯间隙锁）
```

**影响**：RC 下基本没有间隙锁（外键检查、唯一键冲突检查除外），并发更好但放弃了"范围防插入"；RR 下"先 `SELECT FOR UPDATE` 圈住一段范围再 INSERT"的并发模式极易互相阻塞，也更容易死锁（两个事务都持有同一间隙的 Gap Lock，然后都想往里插）。业务上通常改用唯一键 + `INSERT ... ON DUPLICATE KEY UPDATE` 或切到 RC 来规避。

## 五、插入意向锁与唯一键冲突

**直觉**：插入意向锁（Insert Intention Lock）是 INSERT 发出的"我要在这个空档的这个位置落座"的预告——位置不同就互不妨碍，但空档被别人封了就得等。

**机制**：INSERT 执行前先设置插入意向锁（一种特殊间隙锁）。它与别的事务的间隙锁/Next-Key 冲突（所以上一节 t2 会阻塞），但**不同事务在同一间隙不同位置的插入意向锁彼此兼容**——两个事务往同一大区间插不同的值，互不阻塞。真正要防的是唯一键冲突（MySQL 8.0，承接上节的 items 表）：

| 时刻 | 会话 A | 会话 B |
|---|---|---|
| t1 | `BEGIN; INSERT INTO items VALUES (40);`（未提交，A 持有 40 的 X 锁） | |
| t2 | | `INSERT INTO items VALUES (40);` → **阻塞**（重复检查要对 40 加 S 锁，与 A 的 X 冲突） |
| t3 | `COMMIT;` | B 报 `ERROR 1062: Duplicate entry` |
| t3' | （若 A 改为 `ROLLBACK;`） | B 的插入成功 |

**影响**：INSERT 也会等待行锁——"INSERT 还能被锁住？"是排查时的高频盲区。并发插入同一唯一键的多个事务，加上间隙锁，也是死锁的高发组合（下一节）。

## 六、死锁：环形等待、检测与牺牲者

**直觉**：两个人各抱一个箱子互抢对方的——谁都不撒手，谁也拿不到。死锁（Deadlock）就是等待关系成环。

**结构**：环形等待图（wait-for graph）：

```text
        会话 A                          会话 B
     持有: id=1 的 X 锁              持有: id=2 的 X 锁
         │                               │
         │  想要 id=2 ───────────────►   │
         │                               │
         │   ◄─────────────── 想要 id=1  │

   wait-for graph：  A ──► B
                     ▲     │        边 = "在等谁"
                     └─────┘        有环 = 死锁
   检测到环 → 选一个牺牲者回滚，打破环
```

完整可复现（MySQL 8.0，默认 RR）：

```sql
-- MySQL 8.0
CREATE TABLE accounts (
  id      INT PRIMARY KEY,
  balance INT NOT NULL
) ENGINE = InnoDB;

INSERT INTO accounts VALUES (1, 1000), (2, 1000);
```

| 时刻 | 会话 A | 会话 B |
|---|---|---|
| t1 | `BEGIN; UPDATE accounts SET balance = balance - 100 WHERE id = 1;` | |
| t2 | | `BEGIN; UPDATE accounts SET balance = balance - 100 WHERE id = 2;` |
| t3 | `UPDATE accounts SET balance = balance - 100 WHERE id = 2;` → 阻塞（等 B） | |
| t4 | | `UPDATE accounts SET balance = balance - 100 WHERE id = 1;` |
| t5 | | → **`ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction`**，B 整个事务被回滚 |
| t6 | t3 恢复执行，A 正常跑完提交 | 应用收到 1213，重试 B 的事务 |

同样的剧本在 PostgreSQL 16 上重放（建表语句相同，`balance INT`，主键 id），t4 时 B 报：

```text
ERROR:  deadlock detected
DETAIL:  Process 12345 waits for ShareLock on transaction 98765;
         blocked by process 67890.
SQLSTATE: 40P01
```

第五节点到的"并发插入同一唯一键 + 间隙锁"死锁组合，用前面的 items 表即可最小复现——关键前提正是间隙锁彼此兼容：

| 时刻 | 会话 A | 会话 B |
|---|---|---|
| t1 | `BEGIN; SELECT * FROM items WHERE id > 10 AND id < 20 FOR UPDATE;`（锁住间隙 (10,20)） | |
| t2 | | 同一条语句 → 同样获得间隙 (10,20) 的 Gap Lock（间隙锁之间不冲突，双方都拿到） |
| t3 | `INSERT INTO items VALUES (15);` → 阻塞（插入意向锁与 B 的间隙锁冲突） | |
| t4 | | `INSERT INTO items VALUES (15);` → 阻塞（与 A 的间隙锁冲突）→ **等待成环，一方报 `ERROR 1213`** |

**机制——两套数据库的检测策略差异很大**：

| 维度 | MySQL 8.0 / InnoDB | PostgreSQL 16 |
|---|---|---|
| 检测方式 | 每次进入锁等待时立即构建等待图递归找环 | 平时不检测；等待超过 `deadlock_timeout`（默认 1s）才做一次检测 |
| 牺牲者 | 回滚"代价更小"的事务（undo 量/改动行数更少的那个） | 检测到环的那个事务（谁撞上环谁回滚） |
| 相关参数 | `innodb_deadlock_detect`（默认 ON，可动态关闭） | `deadlock_timeout` 只调检测时机，不能关 |
| 等待兜底 | `innodb_lock_wait_timeout`（默认 50s，超时报 `ERROR 1205`，只管行锁） | `lock_timeout`（默认 0 = 无限等，超时报 `ERROR 57014`） |
| 报错 | `ERROR 1213` / SQLSTATE `40001` | SQLSTATE `40P01` |

两个实战要点：

- **MySQL 超时默认只回滚当前语句**：`innodb_rollback_on_timeout` 默认 OFF，收到 `ERROR 1205` 后事务其余语句仍持锁，应用应当显式 `ROLLBACK` 再重试，不要让残缺事务挂着。
- **高并发热点行的权衡**：几百个连接同时更新同一行时，每个新等待者都要触发等待图遍历，检测本身会吃掉大量 CPU。MySQL 官方文档对这类场景给出的方案是 `SET GLOBAL innodb_deadlock_detect = OFF`，靠 `innodb_lock_wait_timeout`（同时调小，如 2~5s）+ 应用重试兜底——代价是真死锁要等到超时才解开。PG 的"等到 1s 才检测"策略天然回避了这个问题，代价是每个真死锁至少阻塞 1s。

## 七、排查工具箱：找出"谁在等谁"

**直觉**：锁问题的排查永远是三问——谁在等、等谁、等在哪条记录上。两边各有一套现成视图。

```sql
-- MySQL 8.0
-- 1) 最顺手的一站式视图：等待开始时间、锁的表/索引/类型、双方 SQL
SELECT wait_started, wait_age_secs, locked_table, locked_index,
       waiting_pid, waiting_query, blocking_pid, blocking_query
FROM sys.innodb_lock_waits\G

-- 附赠：视图里的 sql_kill_blocking_connection 列直接给出 KILL 语句
SELECT sql_kill_blocking_connection FROM sys.innodb_lock_waits;

-- 2) 底层明细：到底锁了哪些记录（8.0 起替代已移除的 innodb_locks）
SELECT ENGINE_TRANSACTION_ID, LOCK_TYPE, LOCK_MODE, INDEX_NAME, LOCK_DATA
FROM performance_schema.data_locks
WHERE OBJECT_NAME = 'items';

-- 3) 等待关系：哪个事务在等哪个事务
SELECT REQUESTING_ENGINE_TRANSACTION_ID, BLOCKING_ENGINE_TRANSACTION_ID
FROM performance_schema.data_lock_waits;

-- 4) 最近一次死锁的完整现场（双方各持什么锁、等什么锁）
SHOW ENGINE INNODB STATUS\G   -- 看 LATEST DETECTED DEADLOCK 段
```

```sql
-- PostgreSQL 16
-- 1) 所有未获锁的等待（行锁等待表现为对 transactionid 的等待，
--    因为 PG 行锁存在行版本里，pg_locks 只登记"在等某个事务"）
SELECT pid, locktype, relation::regclass, mode, granted
FROM pg_locks
WHERE NOT granted;

-- 2) 一句话定位阻塞链：谁在等谁、等了多久、双方在跑什么
SELECT pid,
       pg_blocking_pids(pid)          AS blocked_by,
       now() - state_change           AS waiting_for,
       query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

**机制补充——MySQL 的 MDL**：DML 执行时对表加 MDL 读锁，DDL（如 `ALTER TABLE`）要 MDL 写锁；写锁请求会让后续所有查询排队。于是"一个未提交的长事务 + 一条 ALTER"就能拖住整张表的全部读写。MDL 的观测需要先开 instrument：

```sql
-- MySQL 8.0 · 该 instrument 默认关闭
UPDATE performance_schema.setup_instruments SET ENABLED = 'YES'
WHERE NAME = 'wait/lock/metadata/sql/mdl';

SELECT * FROM performance_schema.metadata_locks;
```

**影响**：把"查阻塞链"做成运维手册里的固定两条 SQL（上面的一站式视图），故障时刻直接粘贴执行；PG 侧同理备好 `pg_blocking_pids` 那条。定位到 blocking_pid 后先看 `blocking_query` 与事务开始时间，多数答案就出来了。

## 八、PostgreSQL 的锁体系差异

**直觉**：PG 与 InnoDB 解决同样的问题，但行锁的实现位置完全不同——InnoDB 把锁登记在锁系统里，PG 把锁直接写在行版本的头字段里。

**机制一：表级 8 种模式**（按强度从弱到强，简化版冲突关系）：

| 强度 | 锁模式 | 典型触发 | 与之冲突的典型持锁 |
|---|---|---|---|
| 弱 | ACCESS SHARE | `SELECT` | DROP / TRUNCATE / VACUUM FULL / 多数 ALTER TABLE |
| ↑ | ROW SHARE | `SELECT ... FOR UPDATE/SHARE` | EXCLUSIVE、ACCESS EXCLUSIVE |
| │ | ROW EXCLUSIVE | `INSERT` / `UPDATE` / `DELETE` | SHARE 及以上（如普通 `CREATE INDEX`） |
| │ | SHARE UPDATE EXCLUSIVE | `VACUUM`、`ANALYZE`、`CREATE INDEX CONCURRENTLY` | 同级互斥 + SHARE 及以上 |
| │ | SHARE | `CREATE INDEX`（非 CONCURRENTLY） | ROW EXCLUSIVE 及以上 → 建普通索引阻塞一切写 |
| │ | SHARE ROW EXCLUSIVE | 显式 `LOCK TABLE`、个别 DDL | 几乎所有写类模式 |
| │ | EXCLUSIVE | 显式 `LOCK TABLE` | 除 ACCESS SHARE 外全部 |
| 强 | ACCESS EXCLUSIVE | `DROP` / `TRUNCATE` / `VACUUM FULL` / 多数 `ALTER TABLE` | 全部（连普通 SELECT 都挡） |

要点：PG 的普通 SELECT 也持 ACCESS SHARE，所以"长查询挡住 ALTER TABLE"在 PG 同样存在——DDL 要的是 ACCESS EXCLUSIVE，与一切冲突，且等待队列里排在它后面的查询都得等它。关键规则：PG 的锁请求按先来先服务排队——队列前部有未满足的冲突请求时，新请求即使与当前持锁者兼容也不能越过它插队。

**机制二：行锁由 xmax 承载**。PG 的行版本头部有 `xmax` 字段：`UPDATE`/`DELETE`/`SELECT FOR ...` 执行时把自己的事务号写进 xmax 并在标记位注明锁强度。行锁因此**不占锁管理器内存、锁一亿行也不会升级为表锁**（结构上不存在升级）。锁强度有四档：

| 已持有 \ 新请求 | FOR KEY SHARE | FOR SHARE | FOR NO KEY UPDATE | FOR UPDATE |
|---|---|---|---|---|
| FOR KEY SHARE | ✓ | ✓ | ✓ | ✗ |
| FOR SHARE | ✓ | ✓ | ✗ | ✗ |
| FOR NO KEY UPDATE | ✓ | ✗ | ✗ | ✗ |
| FOR UPDATE | ✗ | ✗ | ✗ | ✗ |

- `UPDATE` 不改主键/唯一键时自动取 FOR NO KEY UPDATE，改键或 DELETE 取 FOR UPDATE（最强）。
- 分四档的实际收益在外键场景：子表引用检查在父表行上取 FOR KEY SHARE，此时对父行"不改键"的普通 UPDATE（FOR NO KEY UPDATE）仍可并发执行，二者兼容。

**机制三：咨询锁（Advisory Lock）**——应用层互斥不住表结构、也不挡数据读写，纯粹"抢一个名字"：

```sql
-- PostgreSQL 16
SELECT pg_try_advisory_lock(hashtext('job:sync-contacts'));  -- 会话级，抢不到立即返回 false
-- ... 抢到锁的进程干活，其余跳过 ...
SELECT pg_advisory_unlock(hashtext('job:sync-contacts'));

-- 事务级：COMMIT/ROLLBACK 自动释放，不怕忘 unlock（推荐）
BEGIN;
SELECT pg_advisory_xact_lock(42);
-- ... 临界区 ...
COMMIT;
```

MySQL 侧的对应物是 Server 层的 `GET_LOCK('name', timeout)` / `RELEASE_LOCK('name')`。

**MySQL 与 PG 锁体系总对比**：

| 维度 | MySQL 8.0 / InnoDB | PostgreSQL 16 |
|---|---|---|
| 行锁载体 | 锁系统中的索引记录锁（占内存） | 行版本 xmax 字段（不占锁管理器内存） |
| 锁升级 | 不做 | 不做（结构上不可能） |
| 间隙锁 | RR 下有（Next-Key 防插入） | 没有（幻读由 SERIALIZABLE 隔离级别的冲突检测处理，见 [04 篇](./04-mvcc.md)） |
| 死锁检测 | 即时等待图，可选关闭 | 超时（1s）触发检测 |
| 应用层互斥 | `GET_LOCK()` | `pg_advisory_*` 函数族 |

## 九、工程规避：让死锁和长等待少发生

**直觉**：死锁不可能靠运气消灭，工程目标是"发生频率低 + 发生后能自愈"。

| 手段 | 解决什么 | 要点 |
|---|---|---|
| 固定顺序访问 | 死锁 | 批量操作按主键升序处理（先 `SELECT id ... ORDER BY id`，再按序逐条更新），等待图成不了环 |
| WHERE 命中索引 | 锁放大 | `EXPLAIN` 确认 UPDATE/DELETE 不走全表扫描 |
| 短事务 | 锁持有时长 | 事务内不发 RPC、不调外部 API、不做慢计算——锁的持有时间=事务的持续时间 |
| 失败重试 | 死锁/超时残留 | `1213`/`40001`/`40P01` 当瞬时错误：小退避 + 有限次数重试；超时类先显式 ROLLBACK 再重试 |
| 原子 UPDATE | 热点行读写竞争 | `UPDATE stock SET n = n - 1 WHERE id = ? AND n >= 1`：判断进 WHERE，别先 SELECT 回应用算 |
| 限额拆行 | 热点行互更 | 库存 100 拆成 10 行×10，随机选行扣减，单行竞争÷10 |
| 队列串行化 | 极热点 | 写请求入队、单消费者落库，数据库只见单写者，锁竞争消失 |

拆行示例（两库通用思路，MySQL 8.0 / PostgreSQL 16 均可执行）：

```sql
-- 限额拆行：单行热点 → 分桶摊薄（示意 3 桶）
CREATE TABLE stock_bucket (
  id     INT PRIMARY KEY,     -- 同一商品拆成多个桶
  sku    BIGINT NOT NULL,
  remain INT NOT NULL
);
-- 扣减：随机挑一个有余量的桶；失败（该桶不足或被锁）换桶重试
UPDATE stock_bucket SET remain = remain - 1
WHERE id = $bucket_id AND remain >= 1;
```

## 开发者清单

**该做：**

- UPDATE/DELETE 上线前跑 `EXPLAIN`，确认 WHERE 命中索引——防无索引全扫把全表锁死。
- 多行写入按固定顺序（如主键升序）访问——等待关系是链不是环，死锁自然消失。
- 把 `1213`/`40P01` 当作瞬时错误：自动回退（如 50ms 起指数退避）+ 上限（如 3 次）重试——死锁无法绝对避免，自愈才是目标。
- 收到锁等待超时后显式 `ROLLBACK` 再重试——MySQL 默认只回滚当前语句，残缺事务还持有锁。
- 事务里只放数据库操作——不发 HTTP、不调消息队列，锁持有时间与事务同长。
- 热点计数/扣减用原子 UPDATE（`SET n = n - 1 WHERE ... AND n >= 1`）——一次往返、一把锁、无丢失更新。
- 排查卡顿先跑阻塞链查询（`sys.innodb_lock_waits` / `pg_blocking_pids()`）——定位"谁在等谁"永远先于改代码。
- DDL 安排在低峰并对长事务预警——MDL/ACCESS EXCLUSIVE 排队会冻结整表读写。

**不该做：**

- 不要在 RR 隔离级别下用"SELECT FOR UPDATE 圈范围再 INSERT"防重复——间隙锁互堵与死锁高发，改唯一键 + `ON DUPLICATE KEY UPDATE` 或 `INSERT ... ON CONFLICT`。
- 不要"先 SELECT 回应用、再 UPDATE 写回计算值"——普通读不加锁，并发下丢失更新；要么 FOR UPDATE，要么原子 UPDATE。
- 不要用"锁不住就加大重试次数"硬扛死锁——高频死锁说明访问顺序有问题，先修顺序。
- 不要在长事务里穿插 DDL——写锁请求会让后续所有查询排队（见第八节 MDL）。
- 不要用行锁/表锁这类数据锁包裹"分布式选主/任务互斥"等长流程互斥——进程内的应用级互斥用咨询锁（`pg_advisory_xact_lock` / `GET_LOCK`）这类轻量原语，跨实例的互斥交给专门的分布式协调组件，且要考虑连接断开后的语义。

## 常见误区

1. **"InnoDB 锁的是行。"** 锁挂在索引记录上。同一个"行"从主键和二级索引看到的是不同记录；没有索引可走时全表扫描逐行加锁，RR 下效果近似锁全表。说"锁了这行"只是方便沟通，准确说法是"锁了这条索引记录（及其间隙）"。
2. **"行锁一定比表锁好。"** 行锁的并发优势以簿记成本为前提：每条锁记录占内存，百万行无索引 UPDATE 可能先把锁内存和 CPU 打爆。表锁/意向锁在 DDL、`LOCK TABLES` 等场景本来就是正确工具。
3. **"死锁是程序的 bug，修完就不该再出现。"** 死锁是并发调度的正常产物，任何按多顺序访问资源的应用都有概率触发。正确姿势是低频化（固定顺序）+ 可自愈（重试），追求"零死锁"性价比极低。
4. **"锁等待超时后事务就回滚了。"** MySQL 默认 `innodb_rollback_on_timeout = OFF`，只回滚当前语句，事务其余部分连同锁都还在；不显式 ROLLBACK 就重试，会继续持有旧锁制造新的阻塞。
5. **"间隙锁之间互相冲突。"** 恰恰相反，不同事务可以同时持有同一间隙的 Gap Lock（它只挡插入）。这也是 RR 下"两个事务都锁住同一间隙、又都想插入"这种典型死锁的成因。
6. **"PostgreSQL 的 SELECT 不加锁，所以 DDL 随时能做。"** 普通 SELECT 持 ACCESS SHARE 表锁，与 DDL 的 ACCESS EXCLUSIVE 冲突；长查询和长事务一样会让 ALTER TABLE 排队，且排队会波及后续所有查询。

## 自测题

1. 会话 A 持某行 S 锁，B 请求该行 X 锁，C 请求该行 S 锁，谁成功谁等待？（C 成功——S-S 兼容；B 等待。）
2. RR 下对百万行表执行无索引的 `UPDATE ... WHERE name = 'x'`，锁影响范围多大？（主键全表扫描：所有记录加 Next-Key、全部间隙被封，近似锁全表且阻塞插入；同时产生海量锁记录消耗内存。）
3. 索引值 {10,20,30} 上，会话 A 持有 Next-Key (10,20] 与 (20,30]，插入 15、25、8、35 各会怎样？（15、25 阻塞——落在被锁区间；8、35 不阻塞——所在区间未锁。）
4. 唯一索引等值 `WHERE id = 20 FOR UPDATE` 且 20 存在，加什么锁？（Next-Key 退化为纯记录锁；若 20 不存在则锁其所在间隙。）
5. MySQL 和 PG 的死锁牺牲者分别是谁？（MySQL 回滚 undo 量较小的事务；PG 回滚触发检测的事务——谁撞上环谁死。）
6. 为什么 PG 锁一亿行也不会耗尽锁管理器内存？（行锁写在行版本的 xmax 字段里，不进锁管理器；也不存在锁升级。）
7. 两个事务互相 UPDATE 对方持有的行，MySQL 与 PG 各报什么错？应用层怎么处理？（MySQL `ERROR 1213`/SQLSTATE 40001；PG SQLSTATE 40P01。都当作瞬时错误，回退后有限次重试。）

## 关联阅读

- [03 · 事务与ACID](./03-transaction-acid.md)——隔离级别决定锁的用法与范围
- [04 · 并发控制与MVCC](./04-mvcc.md)——普通读为什么不加锁、PG 的 SERIALIZABLE 如何代替间隙锁
- [06 · 日志与恢复](./06-wal-recovery.md)——锁保护的是内存中的修改，崩溃后靠日志找回来
- [08 · 缓冲池与缓存](./08-buffer-pool.md)——锁与页的脏读路径在哪里交汇
- [09 · 复制与高可用](./09-replication-ha.md)——热点行、死锁重试对主从延迟的影响
- [11 · 性能调优基础](./11-performance-tuning.md)——锁等待是"数据库慢"排查清单的固定一项
