# 03 · 事务与 ACID（Transactions & ACID）

> 事务是数据库区别于"带索引的文件系统"的分水岭：一组写操作要么全部生效、要么全部消失，且这个承诺在进程崩溃与并发访问面前依然成立。本篇建立 ACID 的实现级心智模型——每个字母分别靠什么机制兑现——并用两个会话的时间线复现脏读、不可重复读、幻读、丢失更新四种并发异常，最后落到生产中最容易出事的两件事：长事务与事务边界设计。

## 读完本篇你应能回答

- ACID 四个性质各自由什么机制实现？为什么说 C 是目的、A/I/D 是手段？
- 脏读、不可重复读、幻读、丢失更新分别是什么？如何用两个会话复现？
- 标准四级隔离级别各挡住了哪些现象？MySQL 与 PostgreSQL 的现实实现差在哪？
- 为什么 PostgreSQL 事务内一条语句报错后必须 ROLLBACK，而 MySQL 可以继续执行？
- 长事务到底伤害了什么？两个库里分别怎么发现它？
- 应用层的事务边界画在哪？事务里绝对不能放什么？

## 一、事务是什么

### 直觉

转账 = "A 扣 30" + "B 加 30"两步。任何一步成功另一步失败，账就错了。事务（Transaction）把这样一组操作打包成不可分割的单元：外部观察者要么看到全部效果，要么什么都没发生——不存在"钱从 A 扣了但没到 B"的中间状态。

### 结构：事务的生命周期状态机

```text
+------------+                                  +---------------------+
                     最后一条语句执行完毕
|   active   | -------------------------------> | partially committed |
+-----+------+                                  +---------+-----------+
      | 任何一步出错 / 显式 ROLLBACK                      |
      |                              持久化失败           |
      |               +-----------------------------------+
      |               |                                   |
      |               |                                   | redo/WAL 持久化成功
      v               |                                   v
+------------+        |                         +---------------------+
|   failed   |<-------+                         |      committed      |
+-----+------+                                  +---------+-----------+
      |                                                   |
      | 依据 undo 反向补偿，数据回到事务之前              | 事务结束
      v                                                   |
+------------+                                            |
|   aborted  |                                            |
+-----+------+ 事务结束                                   |
      +--------------------+         +--------------------+
                           v         v
                      +--------------------+
                      |     terminated     |
                      +--------------------+
```

图中每个状态一句话：

- **active（活跃）**：事务正在执行语句，尚未到达提交点。
- **partially committed（部分提交）**：最后一条语句执行完毕，事务进入提交点，等待 redo/WAL 持久化。
- **committed（已提交）**：持久化成功，修改效果永久生效。
- **failed（失败）**：事务无法继续（任何一步出错或显式 ROLLBACK），等待回滚。
- **aborted（已中止）**：回滚完成，数据恢复到事务开始之前。
- **terminated（已终止）**：事务结束并从系统中移除，是 committed 与 aborted 的共同终点。

### 机制细节

SQL 标准语法：`BEGIN` / `START TRANSACTION` 开始，`COMMIT` 确认，`ROLLBACK` 撤销（两库对这两个开始语句都支持；MySQL 额外有 `START TRANSACTION WITH CONSISTENT SNAPSHOT`，见 04 篇）。

```sql
-- MySQL 8.0 / PostgreSQL 16 皆可运行（示例表见第三节）
BEGIN;
UPDATE accounts SET balance = balance - 30 WHERE id = 1;  -- A 扣 30
UPDATE accounts SET balance = balance + 30 WHERE id = 2;  -- B 加 30
COMMIT;   -- 中途任何异常执行 ROLLBACK，两步一起消失
```

三个语法要点：

```sql
-- 1) autocommit：MySQL 默认 ON（SELECT @@autocommit; 可查），单条语句自动包成事务。
--    PostgreSQL 服务器端没有 autocommit 参数：语句是否自动提交由客户端协议决定
--    （psql 默认自动提交，\set AUTOCOMMIT off 可关；JDBC 用 setAutoCommit(false)）。

-- 2) SAVEPOINT：事务内设命名回滚点，可只撤销其后一部分：
BEGIN;
UPDATE accounts SET balance = balance - 30 WHERE id = 1;
SAVEPOINT after_debit;
UPDATE accounts SET balance = balance + 3000 WHERE id = 2;  -- 手滑多打一个 0
ROLLBACK TO SAVEPOINT after_debit;                          -- 只撤销这一句
UPDATE accounts SET balance = balance + 30 WHERE id = 2;
COMMIT;

-- 3) RELEASE SAVEPOINT：删除回滚点本身（不触发回滚）。
```

### 对开发者的实际影响

`ROLLBACK TO SAVEPOINT` 不是结束事务：锁、事务资源、快照都还在，直到 `COMMIT` / `ROLLBACK`。"ORM 里每条 SQL 一个事务"与"一个请求一个事务"的行为差异很大（见第六节）。

## 二、ACID：一个目的，三套机制

### 直觉

很多人把 ACID 当一个词背。实现视角下它是 **1 个目的 + 3 个手段**：原子性（Atomicity）、隔离性（Isolation）、持久性（Durability）是数据库机制，共同服务于一致性（Consistency）——"数据永远符合业务不变量"这个最终目的。

| 字母 | 性质 | 一句话定义 | 核心机制 | InnoDB 8.0 组件 | PostgreSQL 16 组件 |
|---|---|---|---|---|---|
| **A** | Atomicity 原子性 | 全做或全不做 | undo 反演 / 提交状态位 | undo log | clog（commit log，事务提交状态位图）提交状态 + MVCC |
| **C** | Consistency 一致性 | 不变量不被破坏 | 目的：约束 + A/I/D | 约束、外键、触发器 | 约束、外键、触发器 |
| **I** | Isolation 隔离性 | 并发互不干扰 | 锁 + MVCC | 行锁、Next-Key Lock、ReadView | 行锁、快照、SSI |
| **D** | Durability 持久性 | 提交即永存 | 预写日志先行落盘 | redo log | WAL |

### 一致性 C：目的，不是机制

数据库能替你守住的是**声明式约束**：主键、外键、唯一、CHECK、NOT NULL。

```sql
-- MySQL 8.0 / PostgreSQL 16 通用
ALTER TABLE accounts ADD CONSTRAINT balance_non_negative CHECK (balance >= 0);
```

但"A 与 B 余额之和不变"这类**跨行不变量数据库不检查**：外键管引用存在性，CHECK 只看单行。它们只能靠把相关写操作放进同一事务 + 应用逻辑 + 对账兜底。**把一致性全托付给数据库，是业务资损事故的常见起点。**

### 原子性 A：undo log 反向补偿

**直觉**：InnoDB 不是"没写"，而是"写了再撤销"。每次改行前，先把旧值作为前镜像（before image）记入回滚日志（undo log）；`ROLLBACK` 时沿日志反向执行补偿操作，把数据改回去。

```text
事务 trx_id=103 执行：UPDATE accounts SET balance=80 WHERE id=1;（原值 100）

  聚簇索引上的行（就地更新）       undo log（该行的前镜像链）
+----------------------+
| balance = 80         |           +----------------------+
| DB_TRX_ID = 103      |<----------| balance = 100        |
| DB_ROLL_PTR = ●      |           | DB_TRX_ID = 99       |
+----------------------+           +----------------------+
   新值（已写入、未提交）            旧值前镜像

ROLLBACK：沿 DB_ROLL_PTR 取前镜像，反向执行一次 UPDATE，把 80 改回 100。
```

**机制细节**：PostgreSQL 走的是另一条路线——更新时另写一个新版本行，回滚只需把该事务在提交日志中标记为中止（aborted），新版本立刻对所有快照不可见，死空间交给 VACUUM（04 篇）。同样是原子性，两库的实现完全不同，这决定了它们回滚的成本与副作用。

### 持久性 D：redo / WAL 先行落盘

**直觉**：提交时数据页多半还在内存里，逐页刷盘是随机 I/O，又慢又不安全。数据库先把"改了什么"追加写进顺序日志文件并 fsync，之后才慢慢刷数据页——预写日志（Write-Ahead Logging, WAL；InnoDB 称 redo log）。崩溃后重放日志即可恢复到提交点。

```text
COMMIT 时刻的写入顺序（InnoDB，innodb_flush_log_at_trx_commit = 1）：

  应用执行 UPDATE ──┬──> 缓冲池数据页变"脏页"（后台批量刷盘，随机 I/O）
                    │
                    └──> 变更日志先写入 redo log buffer
                                │
  COMMIT ───────────────────────┴──> redo log 顺序追加 + fsync
                                       │
                       fsync 成功后，才向客户端回复 COMMIT OK
                                       │
                崩溃恢复 = 重放 redo 到最后提交点 + 回滚未提交事务（06 篇）

  PostgreSQL 的等价机制：WAL + synchronous_commit = on
```

**机制细节**：可以放松这两个参数换吞吐，但要清楚买到的是什么风险：

| 参数（默认值） | 放松后 | 代价 |
|---|---|---|
| MySQL `innodb_flush_log_at_trx_commit = 1`（每次提交 fsync redo） | `2`：只写 OS 缓存，约每秒刷盘 | MySQL 进程崩溃不丢；**操作系统/主机掉电丢约 1 秒的提交** |
| PostgreSQL `synchronous_commit = on`（提交前 WAL fsync） | `off`：提交不等 fsync | 崩溃最多丢约 3×`wal_writer_delay`（默认 200ms，即 ~600ms）**已确认的提交**，数据库本身不损坏 |

**对开发者的实际影响**：支付、订单这类一行都不能丢的路径用默认值；能容忍最后几百毫秒丢失的高写入场景（埋点、计数、缓存回写）可以放松——这是可量化的权衡，不是玄学调优（06 篇展开恢复细节）。

### 隔离性 I：锁 + MVCC

并发事务同时读写同一批数据时，互相能看到什么、挡住什么，由隔离级别（Isolation Level）决定；实现靠锁（05 篇）与多版本并发控制（Multi-Version Concurrency Control, MVCC，04 篇）。先记住分工：**MySQL InnoDB 默认可重复读（REPEATABLE READ）、PostgreSQL 默认读已提交（READ COMMITTED）**——为什么不同，第四节解释。

## 三、并发异常：四种现象与时间线

示例表（两个库通用）：

```sql
-- MySQL 8.0 / PostgreSQL 16
CREATE TABLE accounts (
  id      INTEGER PRIMARY KEY,
  name    VARCHAR(50) NOT NULL,
  balance INTEGER NOT NULL
);
INSERT INTO accounts VALUES (1, 'alice', 100), (2, 'bob', 0);

CREATE TABLE orders (
  id     INTEGER PRIMARY KEY,
  amount INTEGER NOT NULL
);
INSERT INTO orders VALUES (1, 50);
```

以下时间线都在**两个独立连接**中按 t 顺序逐条执行。

### 脏读（Dirty Read）

读到其他事务**尚未提交**的数据；对方一旦回滚，你就读到了从未存在过的值。

| t | 会话 A | 会话 B |
|---|---|---|
| 1 | `BEGIN;` | |
| 2 | `UPDATE accounts SET balance = 999 WHERE id = 1;` | |
| 3 | | `BEGIN;` |
| 4 | | `SELECT balance FROM accounts WHERE id = 1;` → **999（脏数据）** |
| 5 | `ROLLBACK;` | |

出现条件：会话 B 处于读未提交（READ UNCOMMITTED）级别。InnoDB 在该级别下普通 SELECT 不再走一致性读，可能读到未提交的最新版本；PostgreSQL 把 `READ UNCOMMITTED` 当作读已提交处理，**任何级别都不会脏读**。

### 不可重复读（Non-Repeatable Read）

同一事务内两次读**同一行**，值不一样（别的事务 UPDATE 并提交了）。

| t | 会话 A | 会话 B |
|---|---|---|
| 1 | `BEGIN;` | |
| 2 | `SELECT balance FROM accounts WHERE id = 1;` → 100 | |
| 3 | | `UPDATE accounts SET balance = 50 WHERE id = 1; COMMIT;` |
| 4 | `SELECT balance FROM accounts WHERE id = 1;` → **RC：50 / RR：100** | |

### 幻读（Phantom Read）

同一事务内两次执行**同一范围查询**，结果行数变了（别的事务 INSERT / DELETE 并提交了）。

| t | 会话 A | 会话 B |
|---|---|---|
| 1 | `BEGIN;` | |
| 2 | `SELECT COUNT(*) FROM orders WHERE amount > 100;` → 0 | |
| 3 | | `INSERT INTO orders VALUES (2, 500); COMMIT;` |
| 4 | `SELECT COUNT(*) FROM orders WHERE amount > 100;` → **RC：1 / RR：0** | |

与不可重复读的区别在**对象**：一个针对"已存在的行变了值"，锁住该行即可防；一个针对"结果集冒出新行"，必须锁住一段**范围**才能防——这引出间隙锁/谓词锁（05 篇）。

### 丢失更新（Lost Update）

两个事务都"读旧值 → 应用计算 → 写回"，后写者覆盖先写者，先写者的更新无声消失。

| t | 会话 A | 会话 B |
|---|---|---|
| 1 | `BEGIN;` | `BEGIN;` |
| 2 | `SELECT balance FROM accounts WHERE id = 1;` → 100 | |
| 3 | | `SELECT balance FROM accounts WHERE id = 1;` → 100 |
| 4 | 应用算 100−10：`UPDATE accounts SET balance = 90 WHERE id = 1;` | |
| 5 | | 应用算 100−20：`UPDATE accounts SET balance = 80 WHERE id = 1;` |
| 6 | `COMMIT;` | `COMMIT;`（最终 80，**A 的 −10 丢了**，正确应为 70） |

注意：**RC 和 RR 都挡不住它**。隔离级别保证的是"读"的一致性，丢失更新坏在"写覆盖写"，解法是原子 UPDATE / 悲观锁 / 乐观锁（04 篇）。

## 四、隔离级别：标准矩阵与两库现实

标准 SQL 定义四级，逐级收紧：

| 隔离级别 | 脏读 | 不可重复读 | 幻读 |
|---|---|---|---|
| READ UNCOMMITTED 读未提交 | 可能 | 可能 | 可能 |
| READ COMMITTED 读已提交 | 不可能 | 可能 | 可能 |
| REPEATABLE READ 可重复读 | 不可能 | 不可能 | 可能（标准定义） |
| SERIALIZABLE 可串行化 | 不可能 | 不可能 | 不可能 |

现实实现的差异（以 MySQL 8.0 / PostgreSQL 16 为准）：

| 维度 | MySQL 8.0（InnoDB） | PostgreSQL 16 |
|---|---|---|
| 默认级别 | REPEATABLE READ | READ COMMITTED |
| READ UNCOMMITTED | 支持该级别，SELECT 可能脏读 | 语法接受但**实际等同 RC**：最低就是 RC |
| REPEATABLE READ | 快照读靠 MVCC 防幻读；当前读靠 Next-Key Lock 防幻读 | 实为快照隔离（Snapshot Isolation, SI）：整个事务一个快照，写-写冲突报错重试 |
| SERIALIZABLE | 普通 SELECT 隐式按 `SELECT ... FOR SHARE` 处理，读加共享锁 | 可串行化快照隔离（Serializable Snapshot Isolation, SSI）：乐观检测危险结构并中止一方（SQLSTATE 40001） |
| 查看级别 | `SELECT @@transaction_isolation;` | `SHOW transaction_isolation;` |

MySQL 默认 RR 与历史相关：早期基于语句的复制（statement-based replication）在 RC 下会产生主从不一致，RR 是安全基线（09 篇）。PostgreSQL 选 RC：写冲突与死锁更少、语义直白，需要更强保证时直接用 SI / SSI。

### InnoDB 的 RR 如何对待幻读（预告 04 / 05 篇）

- **快照读**（普通 `SELECT`）：走 MVCC 读事务快照，新插入的行不可见 → 看不到幻影；
- **当前读**（`UPDATE` / `DELETE` / `SELECT ... FOR UPDATE / FOR SHARE`）：必须读最新版本。为防"锁不住还不存在的行"，RR 下 InnoDB 对索引记录加下一键锁（Next-Key Lock）= 记录锁 + 间隙锁（Gap Lock），锁住整段范围，其他事务无法在其中插入 → 当前读也不出现幻影；
- 边界：**快照读与当前读混用**会看到不一致的视图——04 篇给出"SELECT 0 行、UPDATE 1 行"的实例。

```sql
-- MySQL 8.0：查看 / 设置隔离级别（5.7 及之前用 tx_isolation，8.0 已移除）
SELECT @@transaction_isolation;                        -- REPEATABLE-READ
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- PostgreSQL 16
SHOW transaction_isolation;                            -- read committed
SET default_transaction_isolation = 'repeatable read';
```

## 五、事务边界：两库行为差异（高频踩坑）

### PostgreSQL：事务一旦报错，整体进入 aborted 状态

```sql
-- PostgreSQL 16，单个会话按行执行
BEGIN;
UPDATE accounts SET balance = balance - 30 WHERE id = 1;
SELECT 1 / 0;
-- ERROR: division by zero
SELECT balance FROM accounts WHERE id = 1;
-- ERROR: current transaction is aborted, commands ignored
--        until end of transaction block
COMMIT;   -- 实际效果等同 ROLLBACK：第一条 UPDATE 也被撤销
```

PG 的设计：事务中任何语句报错，整个事务进入 aborted 状态，**后续所有语句都被拒绝**，唯一出路是 `ROLLBACK`（或断开连接）。想在出错后继续事务，必须提前埋 SAVEPOINT：

```sql
-- PostgreSQL 16
BEGIN;
INSERT INTO orders VALUES (10, 100);
SAVEPOINT sp;
INSERT INTO orders VALUES (1, 100);   -- 主键冲突
-- ERROR: duplicate key value violates unique constraint ...
ROLLBACK TO SAVEPOINT sp;             -- 事务回到健康状态
INSERT INTO orders VALUES (11, 100);
COMMIT;                               -- (10,100) 与 (11,100) 都成功
```

### MySQL：语句报错默认不废止事务

```sql
-- MySQL 8.0
BEGIN;
UPDATE accounts SET balance = balance - 30 WHERE id = 1;
INSERT INTO accounts VALUES (1, 'alice', 999);
-- ERROR 1062: Duplicate entry '1' for key 'accounts.PRIMARY'
SELECT balance FROM accounts WHERE id = 1;   -- 70：事务仍然有效
ROLLBACK;                                    -- balance 恢复 100
```

两个例外要知道：死锁（ERROR 1213）会**回滚整个事务**；锁等待超时（ERROR 1205，`innodb_lock_wait_timeout` 默认 50 秒）默认只回滚当前语句（`innodb_rollback_on_timeout = OFF`）。

对应用的影响：同一套"出错后继续跑"的逻辑不能通吃两库。PG 侧任何语句失败都要准备 `ROLLBACK` + 重开事务（或 SAVEPOINT），事务级重试封装在 PG 下是必需品而不是加分项。

### DDL：一个隐式提交，一个完全事务性

```sql
-- MySQL 8.0：执行 DDL 会隐式提交当前事务
BEGIN;
UPDATE accounts SET balance = 0 WHERE id = 1;
ALTER TABLE accounts ADD COLUMN note VARCHAR(100);  -- 上面 UPDATE 已被隐式提交！
ROLLBACK;   -- 撤不回 UPDATE 了
```

```sql
-- PostgreSQL 16：DDL 完全事务性，可回滚
BEGIN;
ALTER TABLE accounts ADD COLUMN note TEXT;
ROLLBACK;
SELECT note FROM accounts;
-- ERROR: column "note" does not exist
```

（MySQL 8.0 的"原子 DDL"指单条 DDL 自身要么全成功要么全回滚，不改变"DDL 隐式提交之前事务"的行为。）

## 六、长事务：生产环境第一公敌

一个事务开得越久，伤害是复利式的：

1. **undo / 死元组膨胀**：只要事务还可能读旧版本，旧版本就不能清理。MySQL 的 undo log 越积越厚（8.0 虽有 undo 表空间自动 truncate，但清理水位推不动就没用）；PG 的死元组（dead tuple）无法回收，表和索引持续膨胀（04 篇讲完整机制）。
2. **锁长期持有**：行锁 / 间隙锁直到 COMMIT 才释放，等待它的事务级联排队，连接池耗尽后雪崩。
3. **PG 事务年龄推进阻塞 VACUUM**：长事务的快照钉住全库清理水位线，事务 ID 年龄逼近约 21 亿的回卷极限时，库会拒绝新事务（04 篇给完整因果链）。
4. **复制延迟**：大事务在 binlog / WAL 里是原子单位，从库必须完整重放，单事务越大从库延迟越明显（09 篇）。

发现长事务：

```sql
-- MySQL 8.0：当前所有 InnoDB 事务
SELECT trx_mysql_thread_id AS conn_id,
       trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_sec,
       trx_rows_locked, trx_state, trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started
LIMIT 10;
-- age_sec 很大且 trx_query 为 NULL → 极可能是"开着事务没干活"的应用连接
```

```sql
-- PostgreSQL 16：重点盯 idle in transaction
SELECT pid, state, xact_start,
       now() - xact_start AS xact_age,
       backend_xid, left(query, 60) AS last_query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start;
-- state = 'idle in transaction'：事务开着、连接闲着 → 最典型的事务泄漏
```

防护：PG 设置 `idle_in_transaction_session_timeout`（如 `'5min'`，自动终止此类会话）与 `lock_timeout`；MySQL 没有等价的内置空闲事务超时，靠监控 `innodb_trx` 告警 + `KILL <conn_id>` 兜底。

## 七、应用层事务边界设计

### 直觉

事务是"一致性保护罩"，罩子越大越安全？恰恰相反——罩子越大，锁持有越久、undo 越多、并发越差。原则：**只把真正需要原子性的写段包进事务，其余全部移出去**。

```text
反模式：
  BEGIN
  SELECT 订单 FOR UPDATE
  调用风控 HTTP（超时 5s）          <- 持锁等外部系统，耗时不可控
  发 Kafka 消息
  UPDATE 订单
  COMMIT                            <- 事务耗时 = 网络 I/O 耗时

改进：
  （无事务）读订单、调风控、发消息    <- 慢 I/O 全部移出事务
  BEGIN
    UPDATE orders SET status = 'paid'
    WHERE id = ? AND status = 'pending';  -- 条件更新兼做并发防护（04 篇）
    检查 affected rows：0 说明被并发抢先 → 重查 / 走补偿
  COMMIT                            <- 事务里只剩毫秒级写操作
```

### 要点

- **事务里不做 RPC / HTTP / 发消息等慢 I/O**：等于把锁持有时间交给对方的 SLA；且事务回滚撤不回已发出的外部副作用。
- **批量任务分批提交**：百万行 UPDATE 拆成每批几千行、批间提交。单事务大小直接决定 undo 体积、锁范围、主从延迟和失败重放成本；经验目标是单事务秒级完成。
- **警惕 ORM 隐式事务**：Sequelize / TypeORM / JPA / GORM 的默认事务边界各不相同——有的把整个请求包成事务，有的每条语句一个事务。忘 COMMIT 且连接被池复用或挂起，在 PG 下就是 idle in transaction。写码前确认所用 ORM 的默认行为。
- **先计算、后开事务**：校验、查参考数据、调外部服务都在事务外完成，事务只包含"基于已校验输入的写入"。

## 开发者清单

**该做：**

- 事务只包必要写段，单事务控制秒级完成——锁、undo、主从延迟都随事务时长放大。
- "读-改-写"必须用原子 UPDATE / `FOR UPDATE` / 版本列三选一——裸写在任何隔离级别下都会丢失更新。
- PG 代码默认假设事务可能整体失败（语句错误后 aborted），ROLLBACK + 重试逻辑是标配。
- MySQL 里执行 DDL 前显式 COMMIT——DDL 会隐式提交当前事务。
- 上线前确认 ORM 的事务边界与 autocommit 行为——隐式事务是 idle in transaction 之源。
- 监控长事务（`innodb_trx` / `pg_stat_activity`）并告警——它是锁链、膨胀、复制延迟的共同上游。
- 需要特殊隔离时用 `SET TRANSACTION` 标注单个事务——把特殊语义限制在最小范围。
- CHECK / 外键 / 唯一约束能表达的规则交给数据库——比应用层校验更不可绕过。

**不该做：**

- 不要在事务内做 RPC、HTTP、发消息——外部超时直接变成锁持有时间，回滚也撤不回外部副作用。
- 不要假设连接断开未提交的事务"自己会好"——物理断开会回滚，但连接池只是逻辑归还，事务仍挂着。
- 不要该回滚时硬着头皮 COMMIT 保住部分结果——半截逻辑提交出去比白干更贵。
- 不要把 MySQL 的错误处理习惯带到 PG——PG 语句报错后事务整体 aborted，无法"跳过出错的继续"。
- 不要用"事务包住一切"来换安全感——隔离级别和约束挡不住错误的应用逻辑，只会放大并发代价。

## 常见误区

1. **"MySQL RR 完全解决了幻读。"** 不准确：快照读看不到幻影，但当前读（UPDATE / FOR UPDATE）操作的是最新数据；不主动用 FOR UPDATE 锁住范围、或混用两种读，仍会观察到幻影行（04 篇实例）。
2. **"SERIALIZABLE 最安全，默认用它。"** 安全是相对的：MySQL SERIALIZABLE 下普通 SELECT 也隐式加共享锁，读写互相阻塞、吞吐明显下降；PG SSI 会主动中止"危险"事务（40001），应用必须实现重试。正确性优先靠约束与写法，隔离级别只解决可见性。
3. **"PG 事务里某条语句失败，跳过它继续执行就行。"** PG 整个事务进入 aborted，后续语句全部被拒绝；要么 ROLLBACK 重来，要么提前 SAVEPOINT。
4. **"ROLLBACK 亏，前面的计算白干，尽量 COMMIT。"** 白干的只是计算；该回滚不回滚，锁和事务资源继续持有，还可能把半截逻辑提交出去。
5. **"C 由数据库保证。"** 数据库只保证声明式约束；"借贷总和为零"这类应用级不变量要靠事务边界正确 + 对账兜底。
6. **"autocommit 模式下没有事务。"** 每条语句就是一个完整事务：照样有原子性、持久性，照样加锁——只是边界由数据库代画。

## 自测题

1. COMMIT 返回成功后 0.1 秒主机掉电，重启后这笔提交还在吗？为什么？
   （在。默认配置下 redo/WAL 在回复客户端前已 fsync 落盘。）
2. 事务执行到一半进程被 kill -9，其中已执行的 UPDATE 会怎样？
   （未提交即不存在：InnoDB 重启后靠 undo 回滚；PG 靠 aborted 状态位使新版本不可见。）
3. 不可重复读与幻读的区别是什么？为什么后者更难防？
   （前者是已存在的行值变化，锁该行即可；后者是结果集出现新行，必须锁范围/谓词。）
4. 两库默认隔离级别分别是？MySQL 默认 RR 的历史原因？
   （MySQL RR、PG RC；早期基于语句的复制要求 RR 才能主从一致。）
5. PG 中事务内报错后想保留之前已成功的语句，有什么办法？
   （报错前设 SAVEPOINT，之后 ROLLBACK TO SAVEPOINT。）
6. 长事务同时伤害哪四件事？
   （undo/死元组膨胀、锁长期持有、PG 清理水位被钉住导致 xid 年龄增长、复制延迟。）
7. 丢失更新在 RC / RR 下会发生吗？为什么隔离级别管不住它？
   （会。级别保证"读"的一致性，丢失更新发生在"写覆盖写"。）
8. 为什么事务里不能调外部 HTTP？
   （外部调用的耗时与失败不可控：前者拉长锁持有与清理水位，后者回滚无法撤销已发出的外部副作用。）

## 关联阅读

- [./04-mvcc.md](./04-mvcc.md)——快照读 vs 当前读、undo 版本链、ReadView、PG 的 xmin/xmax 与 VACUUM。
- [./05-lock.md](./05-lock.md)——行锁、间隙锁、Next-Key Lock 与死锁排查。
- [./06-wal-recovery.md](./06-wal-recovery.md)——redo/WAL 的写入协议与崩溃恢复全过程。
- [./01-storage-engine.md](./01-storage-engine.md)——聚簇索引与行格式：就地更新与 undo 的物理基础。
- [./09-replication-ha.md](./09-replication-ha.md)——大事务与复制延迟、MySQL 默认 RR 的复制背景。
- [./11-performance-tuning.md](./11-performance-tuning.md)——长事务与 undo 膨胀的度量与治理。
