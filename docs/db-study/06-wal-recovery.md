# 06 · 日志与恢复（WAL, Redo/Undo & Recovery）

> 数据库断电重启后，为什么已提交的数据一条不丢、未提交的数据像没发生过？答案是日志先行。本篇讲清预写式日志的核心思想、MySQL 三类日志（redo/undo/binlog）的分工与两阶段提交、持久性参数的丢失窗口换算、检查点为什么造成"平时写快、偶尔卡一下"，以及崩溃恢复与残页自愈的完整流程。这是理解复制、备份与 PITR 的地基。

## 读完本篇你应能回答

- 预写式日志（Write-Ahead Logging, WAL）的两条铁律是什么？它如何把随机写变成顺序写？
- redo log、undo log、binlog 各自记录什么、服务什么场景？PostgreSQL 为什么只需要一份 WAL？
- MySQL 提交时 redo 与 binlog 为什么要内部两阶段提交？崩溃后按什么规则裁决？
- `innodb_flush_log_at_trx_commit` × `sync_binlog` 的组合各丢多少数据？PG 的 `synchronous_commit` 对应什么？
- 检查点（Checkpoint）在干什么？checkpoint age 顶格时会发生什么？
- 崩溃恢复的完整流程是什么？部分写坏（torn page）为什么 redo 救不了、怎么兜底？

## 一、WAL 核心思想：记账先于搬现金

**直觉**：每笔交易先在账本上记一笔，现金可以稍后再搬——只要账本在，现金丢了也能按账重搬一遍。数据库同理：改数据页前先把"改了什么"写进日志，页本身可以晚点落盘；只要日志在，一切都能重演。

**结构**：不用 WAL 与用 WAL 的写路径对比：

```text
不用 WAL：改哪页写哪页（随机写）
  UPDATE ─► 改 87 号页 ─► 磁盘随机地址 ┐
  UPDATE ─► 改 30 号页 ─► 磁盘随机地址 ├─ 每次提交 = 多次随机 I/O + fsync
  UPDATE ─► 改 05 号页 ─► 磁盘随机地址 ┘

用 WAL：修改先顺序追加到日志尾部，页随后慢慢刷
  UPDATE ─► 日志追加 [LSN 101: 页87 改X] ┐
  UPDATE ─► 日志追加 [LSN 102: 页30 改Y] ├─ 全部落在同一小块连续区域
  UPDATE ─► 日志追加 [LSN 103: 页05 改Z] ┘
                │
                └─► 提交 = 保证"日志落盘"；数据页可以之后慢慢刷
```

**机制——WAL 两条铁律**：

1. **先记后改**：一个数据页可以被写回磁盘的前提，是描述这次修改的日志记录已经先落盘（页可以早刷也可以晚刷，但日志必须永远先于它对应的页）。
2. **提交即日志落盘**：`COMMIT` 返回成功的前提是本事务的日志已经 `fsync` 到持久设备；至于改过的数据页，可以还躺在内存里。

为什么值得：机械盘上随机 4KB 写约 100~200 IOPS（不足 1MB/s），顺序写可达 100MB/s 以上，差三个数量级；SSD 抹平了不少差距，但"攒一批日志一次 fsync"仍远优于"每页修改各自随机 fsync"。顺序、批量、追加——这是日志相对数据页的三大优势。

**机制补充——日志先到内存缓冲区**：redo/WAL 并非每条都直接碰磁盘。MySQL 事务先写内存里的 log buffer，按"提交时/每秒"策略刷到日志文件；PG 后端进程先写共享内存的 `wal_buffers`，再由 wal writer 进程异步冲刷——参数调节的都是"什么时候把缓冲区里的日志 fsync 到盘"，而非"写不写缓冲区"。

**影响**：你观察到的"数据库写很快"其实是"写日志很快"；`fsync` 的次数决定提交吞吐上限，这也是后面持久性参数与组提交全部围绕 fsync 做文章的原因。

## 二、三类日志的分工：redo / undo / binlog

**直觉**：redo 是"重做一遍"的施工日志，undo 是"后悔药"（反向操作），binlog 是"对外广播"的历史流水。MySQL 三个都要；PostgreSQL 用一份 WAL 通吃 redo，走的是另一条路。

**结构**（本篇骨架表）：

| 维度 | redo log（InnoDB） | undo log（InnoDB） | binlog（Server 层） |
|---|---|---|---|
| 所在层 | 引擎层，InnoDB 自有 | 引擎层，InnoDB 自有 | Server 层，所有引擎共用 |
| 记录内容 | 物理页修改（"某页某偏移改为某值"级别） | 逻辑反操作（INSERT 的反向是 DELETE，UPDATE 的反向是反向 UPDATE） | 逻辑日志，默认 ROW 格式（记录行镜像变更） |
| 主要用途 | 崩溃恢复：重做已落日志的修改 | 回滚未提交事务 + MVCC 旧版本链 | 复制 + PITR（时间点恢复） |
| 写入形态 | 循环写，固定容量，旧日志被 checkpoint 追上后覆盖 | 独立 undo 表空间，可自动收缩 | 追加写，写满切换，归档保留 |
| PG 对应物 | WAL（统一日志，同时是复制与 PITR 的源） | 无 undo 日志：旧版本行直接留在堆内，VACUUM 回收 | 逻辑复制用 pgoutput 插件从 WAL 解码 |

**机制**逐个说：

- **redo log**：崩溃恢复的主角。 redo 是"物理"（physiological）日志——记录"对哪个页的哪个位置做了什么修改"，重放快且不依赖语句语义。容量有限、循环覆盖：已经被检查点覆盖的日志才可以丢弃（见第五节）。MySQL 8.0.30 起容量统一由 `innodb_redo_log_capacity` 控制（默认 100MB），替代旧的 `innodb_log_file_size × innodb_log_files_in_group`。
- **undo log**：两大用途。一是事务回滚（应用收到 ROLLBACK 或死锁被选为牺牲者时，按 undo 反向补偿）；二是 MVCC——别的会话要读旧版本时，沿 undo 链往回找（见 [04 篇](./04-mvcc.md)）。它不参与崩溃恢复的"重做"，只在恢复的第二阶段用来回滚。
- **binlog**：Server 层日志，InnoDB 之外（如 MyISAM 表）也会记录；用途是复制与 PITR，不作崩溃恢复（备库/恢复实例本质上是在"重放历史"）。默认 `binlog_format = ROW`。
- **PG 的选择**：一份 WAL 承担 redo + 复制 + PITR；没有 undo 日志——回滚只需把事务标记为 aborted（旧版本行留在堆里，多版本与 VACUUM 见 04 篇），逻辑复制则用 pgoutput 输出插件从 WAL 解码出行级变更。

想亲眼看看日志长什么样（排障时很常用）：

```bash
# MySQL 8.0：把 binlog 解析成可读输出（ROW 格式可见行镜像的变更）
mysqlbinlog --no-defaults -vv binlog.000001 | less

# PostgreSQL 16：把 WAL 解码成人类可读记录（rmgr 列标识记录类型，Heap 为堆操作）
pg_waldump -p /path/to/pgdata -s 0/1000000 -n 20
```

**影响**：排查"主从数据不一致""恢复后少了数据"这类问题，先分清涉及的是 redo（本机恢复）、binlog/WAL（复制与 PITR）还是 undo（回滚）——三者职责不同，症状指向也不同。

## 三、组提交与内部两阶段提交（MySQL）

**直觉**：fsync 一次的代价基本固定，车上多坐几个人就人均便宜——这就是组提交（Group Commit）。而 redo 与 binlog 两本账要保持一致，就要靠内部两阶段提交（Internal Two-Phase Commit，内部 XA）。

**结构**：单事务提交时序与崩溃裁决规则：

```text
事务提交（MySQL 内部两阶段提交，binlog 是协调者）

  T1 ─┐
  T2 ─┤  阶段 1 prepare：各写 redo（含 XID）并落盘
  T3 ─┘        │
               ▼
  阶段 2：写 binlog（T1/T2/T3 各一段），组提交：攒一批一起 fsync
               │
               ▼
  阶段 3 commit：各写 redo 的 commit 标记（可延后落盘）

  崩溃恢复时的裁决（扫描处于 prepare 的事务）：
    redo 有 prepare 且 XID 出现在 binlog ─► 提交
    redo 有 prepare 但 XID 不在 binlog   ─► 回滚
```

**机制**：

- **为什么必须两阶段**：binlog 在 Server 层、redo 在引擎层，两次落盘之间存在崩溃窗口。若先写 redo 后写 binlog：崩溃后本机已提交、binlog/备库没有 → 主备分叉；若先写 binlog 后写 redo：备库重放了本机没有的事务。两阶段把裁决点定在 binlog：prepare 状态的事务，恢复时去 binlog 里找它的 XID——有则提交、无则回滚，两边永远一致。
- **组提交摊薄 fsync**：多个并发事务同时提交时，prepare 的 redo fsync、binlog 的 fsync 都会被合并成一次——并发越高，单次提交摊到的 fsync 成本越低。这解释了为什么单连接压测出的 TPS 远低于并发压测：单连接每次提交都独享一次 fsync。
- PG 同样有 WAL 组提交（提交记录攒批后一次 fsync），原理相同。

**影响**：任何"本机恢复了、备库少了几个事务"或反之的故障，根因基本都落在"redo 与 binlog 的落盘配置不一致"（下一节的参数组合）或两阶段窗口被强行破坏（如非正常 kill 后文件系统语义异常）。

## 四、持久性参数：双 1 与它的邻居们

**直觉**：提交到底要"稳到什么程度"，是一个可用 fsync 次数换吞吐的旋钮。MySQL 有两个旋钮，PG 有一个。

**结构**（MySQL 8.0，两参数均默认 1，均可动态修改）：

| innodb_flush_log_at_trx_commit | sync_binlog | 含义 | 断电丢失面 |
|---|---|---|---|
| 1（默认） | 1（默认） | **"双 1"**：每次提交 redo fsync + binlog fsync | 已确认的提交一条不丢 |
| 2 | 1 | redo 写到 OS 页缓存，binlog 每次 fsync | mysqld 进程崩溃不丢；断电最多丢约 1 秒 redo → 本机落后于 binlog，恢复后与备库不一致 |
| 1 | 0 | redo 每次 fsync；binlog 只写 OS 缓存，每秒刷 | 本机不丢；binlog/备库最多少约 1 秒 |
| 0 | 0 | redo 与 binlog 都每秒刷 | 吞吐最高；断电最多丢约 1 秒，且主备都可能分叉 |

- `innodb_flush_log_at_trx_commit`：1 = 每次提交 fsync redo；2 = 每次提交写到 OS 缓存、每秒 fsync；0 = 每秒写+刷一次。
- `sync_binlog`：1 = 每次提交 fsync binlog；0 = 不主动 fsync，交给 OS（约每秒）；N>1 为攒 N 个事务 fsync 一次（不如 0/1 常用）。

PostgreSQL 16 对应的旋钮是 `synchronous_commit`：

| synchronous_commit | 行为 | 崩溃丢失面 |
|---|---|---|
| on（默认） | 提交等本地 WAL fsync 完成 | 不丢已确认提交 |
| off | 提交不等 fsync，WAL writer 约每 `wal_writer_delay`（默认 200ms）冲刷一次 | 最多丢最近约 3×wal_writer_delay（默认约 0.6 秒）的提交——提交记录先进内存 WAL 缓冲，WAL writer 周期性睡眠-唤醒-刷盘，最坏相位下要跨约三个周期才落盘，所以上界是 3 倍 |
| remote_write / remote_apply | 等备库确认后才返回 | 属同步复制档位，见 [09 篇](./09-replication-ha.md) |

**机制**：注意 PG 的粒度更细——`synchronous_commit` 可以按事务设置（`SET LOCAL synchronous_commit = off`），同一实例里关键交易走 on、日志埋点类写入走 off；MySQL 的两个参数是实例级全局旋钮（`SET GLOBAL` 生效，粒度更粗）。

**影响**：判读原则——先问"这份数据丢了 1 秒有没有后果"：资金/订单类默认双 1 / on，别动；日志、指标、缓存类负载可以降级，但要写进灾备文档并让团队知晓 RPO 从 0 变为约 1 秒。还要注意 (2,1) 与 (1,0) 这类"半降级"组合会引入主备不一致风险，比"双 0 的整体丢 1 秒"更隐蔽。(2,1) 的常见定位是"以 binlog/备库为准、可容忍本机丢约 1 秒"的场景——先用它换吞吐，出问题再收紧。

## 五、检查点：为什么"平时写快、偶尔卡一下"

**直觉**：日志无限追加，磁盘却有限——必须定期把"内存里的脏页刷到磁盘、把检查点位置往前推"，被追上的日志才能被覆盖/回收。检查点就是"账本对齐到现金"的动作。

**结构**：InnoDB 的 checkpoint age 推进模型：

```text
redo 容量（innodb_redo_log_capacity，8.0.30 起默认 100MB）
◄────────────────────────────────────────────────────────────►
│░░ checkpoint 已追上，此段日志可覆盖 ░░│▒▒▒ 活跃日志 ▒▒▒│ 空闲 │
                                        ▲               ▲
                                  checkpoint LSN    写入 LSN
                                        │◄─ checkpoint age ─►│

写入快（大批量提交）+ 刷脏慢（IO 打满 / innodb_io_capacity 太低）
  → age 持续增大 → 逼近容量上限
  → 先进入后台加速刷脏（async flush point）
  → 仍不够 → 用户线程被拉去同步刷脏（sync flush point）→ 写入停顿
表象：平时很快，每隔一阵集体卡 1~2 秒
```

**机制**：

- **InnoDB 用模糊检查点（fuzzy checkpoint）**：后台线程（page cleaner）平时就以 `innodb_io_capacity`（默认 200，单位页/秒）的速度渐进刷脏、推进 checkpoint，正常运行时几乎无感；之所以叫"模糊"，是因为刷脏不需要停下所有写入做一次性对齐，而是边服务边分批推进检查点位置——"模糊"指允许检查点期间存在进行中的修改。只有 age 逼近容量上限（或脏页占比过高等阈值）时才触发强制刷脏，把用户线程拖下水。因果链固定：**写入产生日志的速度 > 刷脏回收日志的速度 → age 增大 → 顶格 → 强制刷脏 → 停顿**。解法要么扩容量（`innodb_redo_log_capacity`）、要么提高刷脏能力（`innodb_io_capacity` / 更快的盘），让稳态 age 保持在低位。
- **PG 由独立的 checkpointer 进程负责**：两个触发条件先到为准——`checkpoint_timeout`（默认 5 分钟）或 WAL 写入量达到 `max_wal_size`（默认 1GB）。刷脏节奏由 `checkpoint_completion_target`（默认 0.9）控制：把预计的刷脏量平摊到间隔的 90% 时间里完成，避免 IO 尖刺。

**影响——观察工具**。MySQL 侧直接看 `SHOW ENGINE INNODB STATUS` 的 LOG 段：

```sql
-- MySQL 8.0 · 建表与压测数据
CREATE TABLE bench (id BIGINT PRIMARY KEY AUTO_INCREMENT, pad VARCHAR(255) NOT NULL) ENGINE = InnoDB;
```

| 时刻 | 会话 A（写入者） | 会话 B（观察者） |
|---|---|---|
| t1 | | `SHOW ENGINE INNODB STATUS\G` 记下 LOG 段的 `Log sequence number` 与 `Last checkpoint at`，两值接近 |
| t2 | 批量写入（下方 SQL，持续十几秒以上） | |
| t3 | | 再看 LOG 段：两值之差（checkpoint age）明显拉大 |
| t4 | 停止写入 | 后台刷脏推进 checkpoint，age 逐渐回落 |

```sql
-- MySQL 8.0 · 会话 A 的批量写入（注意先放开递归 CTE 深度限制）
SET SESSION cte_max_recursion_depth = 200000;

INSERT INTO bench (pad)
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000
)
SELECT repeat('x', 200) FROM seq;
```

```sql
-- PostgreSQL 16 · 对应的观测
SELECT pg_current_wal_lsn();          -- 当前 WAL 写入位置（LSN）
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/1000000');  -- 两位置差多少字节

SELECT checkpoints_timed, checkpoints_req,
       checkpoint_write_time, checkpoint_sync_time
FROM pg_stat_bgwriter;
-- checkpoints_timed：到点触发的检查点；checkpoints_req：没到点就被 max_wal_size
-- 顶出来的检查点。req 占比高 = WAL 产生快于预期或 max_wal_size 偏小。
```

MySQL 侧除 `SHOW ENGINE INNODB STATUS` 外，8.0.30 起还有一组状态变量可直接采集进监控（无需解析文本）：

```sql
-- MySQL 8.0.30+
SHOW GLOBAL STATUS LIKE 'Innodb_redo_log%';
-- Innodb_redo_log_current_lsn 与 Innodb_redo_log_checkpoint_lsn 之差即 checkpoint age，
-- 与 Innodb_redo_log_capacity 的比值就是"日志水位"，做成监控曲线最直观。
```

**影响**：写入型抖动排查的第一反应就是看 checkpoint age（MySQL）与 `checkpoints_req` 占比（PG）；突发大批量任务放低峰、分批提交，是在保护这条因果链不进"强制刷脏"分支。

## 六、崩溃恢复流程

**直觉**：重启后先"照账重演"（redo 前滚），再"销毁烂尾工程"（undo 回滚）。PG 的烂尾工程不用拆——直接贴上"作废"封条。

**结构**：

```text
                    崩溃（断电 / kill -9）
                            │
                            ▼
              ┌───────────────────────────────┐
              │ 从 checkpoint（REDO 点）起     │
              │ 顺序扫描 redo / WAL            │
              └───────────────┬───────────────┘
                              ▼
              ┌───────────────────────────────┐
              │ 逐条重放（前滚）：             │
              │ 页头 LSN 落后于日志 LSN 才重做  │
              │ —— 已提交、未提交的一律前滚     │
              └───────────────┬───────────────┘
                              ▼
           ┌──────────────────┴──────────────────┐
           ▼                                     ▼
     MySQL / InnoDB                        PostgreSQL
     重放完成后扫 undo：                     重放中遇到没有 commit
     未提交事务按 undo 逐条                  记录的事务 → 直接标记
     反向补偿回滚（大事务可                  aborted；旧版本行留在
     转后台慢慢回滚）                        堆里，等 VACUUM 回收
           └──────────────────┬──────────────────┘
                              ▼
                 数据库打开，恢复完成
```

**机制**：三个关键设计。

- **redo 全量前滚，不分提交与否**：redo 重放是把所有页修到"崩溃前一瞬间"的状态，这一步不看事务是否提交——因为重放是幂等的（页头 LSN 挡住重复应用），先全部前滚最简单；未提交的痕迹由下一阶段清理。
- **MySQL 回滚靠 undo**：没有 commit 标记的事务，用 undo 反向补偿；回滚量很大时可以先对外提供服务、后台继续回滚（崩溃恢复期间长的部分）。
- **PG 直接标记 aborted**：PG 没有 undo 日志，恢复时把无 commit 记录的事务在 `pg_xact` 中标记为 aborted 即可——那些"半截"行版本本来就躺在堆里，可见性规则会让它们被忽略，VACUUM 稍后回收空间。

**恢复时长与检查点频率的关系**：

| 检查点策略 | 平时开销 | 崩溃恢复时长 |
|---|---|---|
| 更频繁 / 容量配置更大（PG `max_wal_size` 大，MySQL 刷脏跟得上） | 后台 IO 更高；PG 每个检查点后首批写页要记整页镜像（见第七节） | 需重放的日志少，重启快（RTO 短） |
| 更稀疏 / 刷脏慢 | 平时 IO 低 | 需重放的日志多，恢复可能从秒级拉长到分钟级 |

恢复时长可以粗估：**需重放的日志量 ÷ 单线程重放吞吐**（redo/WAL 重放基本是单线程扫描）。checkpoint age 常年在几十 GB 的库，重启恢复按十分钟计并不夸张；反过来，这也是"改检查点参数前先想清楚 RTO"的量化依据。

**影响**：RTO 敏感的库要定期做恢复演练并记录时长；调大 PG `checkpoint_timeout`/`max_wal_size` 之前，先想清楚重启重放变长的代价。

## 七、Torn Page：doublewrite 与 full_page_writes

**直觉**：redo 记的是"某页某偏移从 A 改成 B"，前提是这个页本身是完整的。断电时 16KB 的页可能只写下去一半——拿着残页重放增量日志，等于在碎纸上补字，越补越错。

**结构**：问题成立的条件——InnoDB 默认页 16KB、PG 默认页 8KB，而文件系统与磁盘的原子写单位通常是 4KB 甚至更小。断电时一个页可能只写下去一半，且没有校验能发现这是"半个新页"。

**机制**：两家的兜底思路相同——先保证磁盘上有一份完整页，再谈增量重放——落点不同：

- **InnoDB doublewrite buffer**：每次刷脏页，先把整页顺序写入表空间中独立的 doublewrite 区（默认约 2MB，可容纳 128 个 16KB 页），再写回数据文件原位。恢复时若发现某页校验不一致，先从 doublewrite 副本整页还原，再重放 redo——每页多一次顺序写，换来页级自愈能力。
- **PG full_page_writes**：每个检查点后某页"第一次"被修改时，把整页镜像直接写进 WAL；恢复时先按镜像整页还原，再应用其后的增量 WAL。代价集中在检查点后的首批写页：这几笔的 WAL 量从几十字节膨胀到整页 8KB。

**机制对比**：

| 维度 | InnoDB doublewrite | PG full_page_writes |
|---|---|---|
| 副本放哪 | 表空间中独立的 doublewrite 区 | WAL 日志本身（整页镜像） |
| 触发时机 | 每次刷脏页都要先过一遍 | 每个检查点后每页首次修改时 |
| 额外代价 | 每个脏页多一次顺序写 | 检查点后首批写页的 WAL 从几十字节膨胀到整页 8KB |
| 开关（默认开） | `innodb_doublewrite` | `full_page_writes` |

**影响**：两者都默认开启且不建议关——关掉省的是几个百分点的顺序写，赌上的是"断电后数据库无法自愈"。巡检时顺手确认一下（也应纳入基线配置检查）：

```sql
-- MySQL 8.0
SHOW VARIABLES LIKE 'innodb_doublewrite';   -- 期望 ON

-- PostgreSQL 16
SHOW full_page_writes;                      -- 期望 on
```

某些文件系统/设备保证原子写整页时才可讨论关闭，需要精确的基础设施知识背书。

## 八、LSN：全局推进的修改序号

**直觉**：日志序列号（Log Sequence Number, LSN）就是全局递增的"修改流水号"——每一笔修改领一个号，页、检查点、复制进度全都用这个号对表。

**机制**：

- 每条日志记录获得一个单调递增的 LSN（按日志字节数推进）；数据页头部记录"本页已应用到的 LSN"（InnoDB 的 `FIL_PAGE_LSN`）。重放时若页头 LSN ≥ 日志 LSN，说明该修改已应用，直接跳过——这是重放幂等的实现基础。
- 检查点位置、checkpoint age、"脏页落后多少"，全部表达为 LSN 之间的差值。PG 的 `pg_lsn` 类型就是 WAL 流的字节偏移，`pg_wal_lsn_diff()` 算两个字节的差距；复制延迟的度量"备库落后主库多少字节"也源于它——主库看 `pg_stat_replication` 的 `sent_lsn`/`replay_lsn` 差值即可（见 [09 篇](./09-replication-ha.md)）。MySQL 侧对应的观测点是 `SHOW ENGINE INNODB STATUS` LOG 段的 `Log sequence number` / `Last checkpoint at`，备库延迟则看 `SHOW REPLICA STATUS` 的位点差/`Seconds_Behind_Source`（8.0.22 前叫 `Seconds_Behind_Master`）与 GTID 差集。

**影响**：看懂 LSN，监控面板上的"WAL 生成速率""复制延迟字节数""checkpoint age"三个指标就串成了一条线：全都源于同一个流水号。

## 九、从 WAL 到 PITR、复制与写放大

- **日志是复制与备份的地基**：备库回放 binlog/WAL 才能追平主库（[09 篇](./09-replication-ha.md)）；"基础备份 + 连续归档日志"才能恢复到任意时间点（PITR，[15 篇](./15-backup-recovery.md)）。PG 开 `archive_mode` + `archive_command` 把 WAL 段（默认 16MB 一段）持续归档；MySQL 依赖 binlog 的完整保留，`binlog_expire_logs_seconds`（8.0 默认 2592000 秒即 30 天）决定了 PITR 能回溯多远。日志断了档，恢复链条就断。
- **注意"容量"与"保留"是两回事**：PG 的 `max_wal_size` 只是影响检查点节奏的软目标，不是 WAL 保留量；不归档的 WAL 段被检查点追上后即被复用。MySQL 的 redo 容量（`innodb_redo_log_capacity`）与 binlog 保留期同样是两个独立旋钮。
- **写放大再看一遍**：一次 UPDATE 的物理写远不止"改一页"：undo（记反操作）+ redo（记正向修改）+ binlog（记行镜像）+ 数据页本身 + doublewrite（整页先写副本区）。一次逻辑修改摊出四五处物理写，这就是"写放大"的日志侧真相；也因此"攒批提交"永远比"逐条自动提交"划算——日志条数省不下来多少，但 fsync 次数可以合并。

## 开发者清单

**该做：**

- 新库默认保持双 1 / `synchronous_commit = on`——降级前先回答"丢 1 秒有没有后果"，并把结论写进灾备文档。
- PG 给非关键写入用 `SET LOCAL synchronous_commit = off` 按事务降级——关键交易 on、日志埋点 off，一个库两种策略并存。
- 大批量导入分批提交（每批几千行）——单事务日志过大会推高 checkpoint age、拉长恢复重放，也放大主从延迟。
- 监控检查点健康度：MySQL 看 checkpoint age 与 redo 容量的比例，PG 看 `checkpoints_req` 占比——req 高说明 `max_wal_size` 偏小或写入超预期。
- 迁移、批量刷数、回填历史数据放低峰执行——保护刷脏链路不进"强制刷脏"分支。
- 压测提交吞吐用真实并发——单连接测不出组提交摊薄后的 fsync 成本，结论会严重失真。
- 写入负载增长先算日志水位，再决定买更快的盘还是扩日志容量——有时调大 `innodb_redo_log_capacity` / `max_wal_size` 比加 IOPS 更划算。
- 恢复演练时记录恢复时长——它是 RTO 的核心组成部分，检查点参数改动的直接反馈。

**不该做：**

- 不要压测时顺手改 0、上线忘了改回——故障时刻才发现丢 1 秒，且可能主备分叉。
- 不要用自动提交模式逐条 INSERT 大批量数据——每条一个事务，等于每条独享一次（组）fsync。
- 不要假设"COMMIT 返回 = 数据已在 .ibd/堆文件里"——提交只保证日志落盘，页可能还在缓冲池里。
- 不要在有备库或 PITR 依赖的库上把 `sync_binlog` 设 0——binlog 是复制与恢复的共同基座。
- 不要关闭 doublewrite / full_page_writes 换几个百分点性能——换来断电后无法自愈的页损坏。
- 不要在长事务里堆积海量修改——undo 无限增长会拖垮 MVCC 与回滚（见 04 篇），恢复重放也更久。

## 常见误区

1. **"COMMIT 返回成功，数据就写进数据文件了。"** 提交保证的是日志落盘；被改的数据页可能还要在缓冲池里待很久才刷盘。数据文件"落后"是常态，崩溃后靠重放日志补齐。
2. **"redo 和 binlog 功能重复，留一个就行。"** 层级（引擎层 vs Server 层）、内容（物理页修改 vs 逻辑行变更）、用途（本机恢复 vs 复制/PITR）都不同；缺 redo 引擎无法恢复，缺 binlog 复制与 PITR 无从谈起。
3. **"崩溃恢复时只重放已提交事务。"** redo 阶段对已提交与未提交的页修改一律前滚（重放幂等，先恢复到崩溃瞬间的物理状态），第二步才由 undo 回滚未提交事务；PG 则直接把未提交事务标记为 aborted。
4. **"undo 参与崩溃恢复的重做。"** undo 服务于回滚与 MVCC 版本链，不做重做；PG 更是干脆没有 undo——旧版本行留在堆内等 VACUUM。
5. **"把双 1 改成 0 只影响性能，不影响正确性。"** 断电最多丢约 1 秒事务；`innodb_flush_log_at_trx_commit` 与 `sync_binlog` 半降级组合还会造成本机与 binlog/备库不一致，比整体丢 1 秒更隐蔽。
6. **"checkpoint 是一次全量刷脏的停顿动作。"** InnoDB 的 fuzzy checkpoint 由后台渐进推进，PG 靠 `checkpoint_completion_target` 把刷脏平摊到间隔的 90%；真正造成停顿的是 checkpoint age 顶格后的强制刷脏——那是"平时欠的账"，不是 checkpoint 本身的属性。

## 自测题

1. WAL 的两条铁律是什么？（页落盘前其日志必须先落盘；提交的持久性由日志 fsync 保证，与页无关。）
2. redo / undo / binlog 各一句话说清职责。（redo：物理页修改，崩溃恢复重做；undo：逻辑反操作，回滚 + MVCC；binlog：逻辑变更流，复制 + PITR。）
3. 描述 MySQL 内部两阶段提交的三步，以及崩溃后对 prepare 事务的裁决规则。（redo prepare 落盘 → 写 binlog 并 fsync → 写 commit 标记；恢复时 XID 在 binlog 则提交，否则回滚。）
4. "双 1"与"双 0"分别最多丢多少？（双 1 不丢已确认提交；双 0 断电最多丢约 1 秒，且可能主备不一致。）
5. checkpoint age 持续增大到顶格，用户会感受到什么？因果链是什么？（周期性写入停顿；写入产生日志快于刷脏回收，age 逼近 redo 容量上限后用户线程被拉去强制刷脏。）
6. 部分写坏（torn page）为什么 redo 救不了？两库各自怎么兜底？（redo 是页内增量，应用到残页会损坏数据；InnoDB doublewrite 先整页落副本，PG full_page_writes 在检查点后首次改页时整页镜像入 WAL。）
7. PG `synchronous_commit = off` 最多丢多少提交？（约 3 × `wal_writer_delay`，默认 200ms，即最多约 0.6 秒。）
8. 页头 LSN 在恢复中起什么作用？（页已应用到的日志位置；重放时页头 LSN ≥ 记录 LSN 则跳过，保证幂等。）

## 关联阅读

- [01 · 存储引擎与数据组织](./01-storage-engine.md)——页结构与页头，redo 与 doublewrite 操作的对象
- [03 · 事务与ACID](./03-transaction-acid.md)——持久性（D）的承诺正是由日志落盘兑现
- [04 · 并发控制与MVCC](./04-mvcc.md)——undo 链与 PG 堆内多版本的可见性
- [05 · 锁与阻塞](./05-lock.md)——锁保护内存中的修改，日志负责崩溃后找回
- [08 · 缓冲池与缓存](./08-buffer-pool.md)——脏页、刷脏与 LRU，检查点的另一半
- [09 · 复制与高可用](./09-replication-ha.md)——binlog/WAL 流复制与延迟度量
- [15 · 备份与恢复](./15-backup-recovery.md)——基础备份 + 归档日志的 PITR 实操
