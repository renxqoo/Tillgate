# 15 · 备份与恢复（Backup & Recovery）

> 硬盘会坏，人会 `DROP TABLE`，勒索软件会加密数据目录。本篇讲如何围绕 RPO/RTO 设计备份体系：逻辑备份与物理备份的取舍、如何拿到一致性快照、如何用基础备份加归档日志恢复到任意时间点（PITR），以及为什么"没演练过的备份等于没有备份"。

## 读完本篇你应能回答

- RPO 与 RTO 是什么，为什么说它们由业务决定、备份方案只是结果？
- 逻辑备份与物理备份各自的优缺点与适用场景？
- `pg_dump` 的 custom 格式比纯 SQL 好在哪？mysqldump 的 `--single-transaction` 和 `--source-data` 各起什么作用？
- 为什么"裸"云盘快照可能不可恢复？PITR 的时间轴由哪几段组成？
- 为什么从库不能替代备份？备份演练要验证哪些项？

## 一、先立靶子：RPO 与 RTO

**直觉**：备份设计的第一步不是选工具，而是回答两个业务问题——"能容忍丢多少数据"和"能容忍停多久"。

- **RPO（Recovery Point Objective，恢复点目标）**：故障发生后，最近一个可恢复点到故障点的数据丢失量上限。每日凌晨全量备份且无日志归档，最坏丢接近 24 小时；基础备份 + 连续归档日志（PITR），RPO 可压到秒级。
- **RTO（Recovery Time Objective，恢复时间目标）**：从宣布故障到恢复服务的时长上限。物理备份拷回数据目录通常几十分钟；逻辑备份逐条重放 SQL，大库可能数小时。

| 业务分级 | 典型 RPO | 典型 RTO | 最低备份形态 |
|---|---|---|---|
| 边缘/内部系统 | ≤ 24 小时 | 数小时~1 天 | 每日逻辑全量 |
| 在线业务 | ≤ 5 分钟 | 分钟~小时 | 物理全量 + 日志归档 PITR |
| 交易/资金类 | ≈ 0（秒级） | 分钟级 | PITR + 独立异地副本 + 周期演练 |

RPO/RTO 由业务定，备份方案是结果而不是起点：先拿业务分级，再倒推备份频率、方式和保留期。

## 二、备份分类骨架

| 维度 | 类别 A | 类别 B |
|---|---|---|
| 内容 | 逻辑备份：导出 SQL/数据行（`pg_dump`、`mysqldump`） | 物理备份：拷贝数据文件（`pg_basebackup`、clone、XtraBackup、快照） |
| 粒度 | 全量：完整副本 | 增量/差异：自上次全量（或上次增量）以来的变更 |
| 服务状态 | 在线：备份期间正常读写 | 停机：冷备份，一致性最简单但服务不可用 |
| 一致性手段 | 单事务快照（`--single-transaction`）/备份锁 | 备份起止标记 + 日志重放（WAL/redo/binlog） |

逐对展开：

- **逻辑 vs 物理**：逻辑备份跨版本、跨平台、可按表恢复、人类可读；但恢复慢（重放 SQL）、大库导出耗时。物理备份恢复快（本质是文件拷贝）、适合大库与 PITR 基座；但版本/平台要求严格（PG 物理备份只能恢复到相同大版本实例，MySQL 要求相同版本系列的数据库二进制），粒度只能整库。
- **全量 vs 增量**：全量简单可靠、恢复一步到位；数据量大后窗口放不下。增量省空间省时间，但恢复要按链路依次应用，链条中任一环节损坏则后续作废。差异（自上次全量以来的累计变更）介于两者之间：恢复只需全量 + 最近一份差异。
- **在线 vs 停机**：现代数据库都能在线备份，冷备份只用于小系统或维护窗口。
- **一致性**：在线备份必须解决"拷贝期间数据在变"的问题——这是本篇后半的主线。

```text
一套完整备份体系的三层结构（每层职责不同，缺一层则 RPO 退化）：

┌────────────────────────────────────────────────────────────┐
│  日志层：WAL / binlog 连续归档（恢复到秒级的"录像带"）        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  增量/差异层：自上次全量以来的变更（缩短每日备份窗口）    │ │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │  全量层：pg_dump / pg_basebackup / XtraBackup   │  │  │
│  │  │  （一切恢复的起点，恢复 = 全量 + 逐层应用变更）   │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
  只有全量层：RPO = 备份间隔（最坏丢一个间隔的数据）
  全量 + 日志层：RPO = 日志归档延迟（分钟到秒级）
```

## 三、逻辑备份

### PostgreSQL 16：pg_dump

```bash
# PostgreSQL 16
# 纯 SQL 格式：可读、可 grep，恢复用 psql 串行重放
pg_dump -d app -f app.sql
psql -d app_new -1 -f app.sql        # -1 包在单事务里恢复

# custom 格式（-Fc）：默认压缩，支持并行恢复与按表选择性恢复
pg_dump -Fc -d app -f app.pgdump
pg_restore --jobs=4 --dbname=app_new app.pgdump    # 4 并行建索引/装数据
pg_restore --dbname=app_new --table=orders app.pgdump  # 只恢复一张表

# 目录格式（-Fd）：导出阶段即可并行，适合超大库
pg_dump -Fd --jobs=4 -f app_dir -d app
```

`pg_dump` 在单个一致快照事务中导出，得到逻辑一致的库。注意它不导出全局对象（角色、表空间），需要补 `pg_dumpall --globals-only`。

custom 格式的大库恢复提速技巧：分段恢复——先建结构、装数据，索引与约束放到最后并行建，避免"边插数据边维护索引"的双重开销：

```bash
# PostgreSQL 16：先恢复结构+数据，再并行补索引/约束
pg_restore --section=pre-data --section=data --jobs=4 --dbname=app_new app.pgdump
pg_restore --section=post-data    --jobs=4 --dbname=app_new app.pgdump
```

### MySQL 8.0：mysqldump

```bash
# MySQL 8.0：对 InnoDB 在一致性快照下导出，不断服务
mysqldump --single-transaction --source-data=2 \
  --triggers --routines --events \
  -u bak -p app > app.sql
```

- `--single-transaction`：开一个 `REPEATABLE READ` 一致性快照事务（依赖 MVCC，见 [04](./04-mvcc.md)），导出期间不锁表。**只对 InnoDB 有效**——混杂 MyISAM 表时该表不在同一快照里，需要改用 `--lock-all-tables`。
- `--source-data=2`（8.0.26+ 取代 `--master-data`）：把导出开始时的 binlog 文件名与位点写进 dump 头部（`=2` 为注释形式），这是之后衔接 binlog 做时间点恢复或搭从库的锚点。

mysqldump 也常用于对象级局部操作（导结构、导单表数据、按条件导出）：

```bash
# MySQL 8.0：局部导出的三种常用形态
mysqldump --no-data app > app_schema.sql          # 只导结构
mysqldump --no-create-info app orders > orders.sql  # 只导 orders 表数据
mysqldump --where="created_at >= '2026-09-01'" app orders > orders_recent.sql
```

### 为什么逻辑备份恢复慢

恢复不是"把文件拷回去"，而是把每条 `INSERT` 重新执行一遍：逐行写 redo 日志（见 [06](./06-wal-recovery.md)）、逐行维护二级索引、触发器逐条执行，且纯 SQL 格式单线程。经验量级：GB 级 dump 恢复以小时计，而物理备份同规模是分钟级的文件拷贝。结论：逻辑备份适合小中型库、按表恢复和跨版本迁移；大库与 PITR 用物理备份。

## 四、物理备份

### PostgreSQL 16：pg_basebackup

```bash
# PostgreSQL 16：经复制协议流式拷贝整个数据目录
pg_basebackup -D /backup/base -X stream --checkpoint=fast --progress -R
# -X stream      备份期间同步拉取 WAL，保证备份自洽可恢复
# --checkpoint=fast 立即做 checkpoint 开拷，缩短启动延迟
# 前置：wal_level=replica（PG 15+ 默认），pg_hba.conf 放行 replication 连接
```

备份的"专门起点"由 `pg_backup_start()`（PG 15+ 命名，旧版 `pg_start_backup`）一类标记确立：起点之后产生的 WAL 都要归档保留，恢复时靠它们把拷贝期间"新旧混杂"的文件页追平到一致点——这正是 [06 WAL](./06-wal-recovery.md) 的 redo 思想在备份上的应用。

### MySQL 8.0：clone 插件与 XtraBackup

```sql
-- MySQL 8.0.17+ 原生 clone 插件：在目标实例执行，直接克隆远端数据目录
INSTALL PLUGIN clone SONAME 'mysql_clone.so';
CLONE INSTANCE FROM 'clone_user'@'source.example.com':3306 IDENTIFIED BY '***';
```

```bash
# Percona XtraBackup 8.0（配 MySQL 8.0）：拷文件 + 追 redo 至一致点
xtrabackup --backup --target-dir=/backup/base -u bak -p
xtrabackup --prepare --target-dir=/backup/base   # 应用 redo，达到事务一致
xtrabackup --copy-back --target-dir=/backup/base  # 恢复到数据目录
```

两者的思路相同：物理文件在拷贝时是"进行中"的状态（脏页、正在写的页），靠重放 redo log 把副本推进到某个一致的检查点。

增量的现状（按版本记准）：PostgreSQL 16 的 `pg_basebackup` **没有**增量能力，块级增量由 pgBackRest/Barman 实现（按页比较 LSN，只传变更块；LSN＝日志序列号，WAL 位置的递增编号，06 篇详解）；PG 17 起 `pg_basebackup` 才原生支持 `--incremental`。Percona XtraBackup 从早期版本就支持 `--incremental`（同样基于 LSN 变更页），恢复时按"全量 → 各增量"顺序依次 prepare。

### 云盘快照：一致性要自己协调

云厂商的磁盘快照看起来是"一键物理备份"，但**裸快照可能不可恢复**，原因有二：

1. 快照瞬间，数据文件里可能存在**断裂页（torn page）**：一个 16KB 页写到一半被定格，页头与页尾不一致（呼应 [06](./06-wal-recovery.md)）。恢复必须有日志重放来修复，而裸快照没有配套的日志衔接点；
2. 操作系统与数据库的写缓冲没有落盘边界，快照里的文件系统与数据库状态彼此不一致。

协调手段（任选其一）：

```sql
-- PostgreSQL 16：声明备份窗口，快照落在这个窗口内就是可恢复的
SELECT pg_backup_start('disk-snapshot-20260906');
-- <执行云盘快照>
SELECT pg_backup_stop();   -- 返回需保留的 WAL 范围，归档不可缺
```

```bash
# MySQL 8.0：短锁全库 + 快照 + 解锁；SYSTEM 是 mysql 客户端内执行 shell 命令的方式，不是 SQL
mysql -e "FLUSH TABLES WITH READ LOCK;  SYSTEM sudo fsfreeze -f /var/lib/mysql;  \
  sleep 600"   # 冻结期间在云侧打快照，完成后 fsfreeze -u + UNLOCK
```

`fsfreeze` 冻结文件系统刷脏页，快照期间无写入；代价是备份窗口内数据库写入暂停，须评估业务可容忍度。

## 五、PITR：恢复到任意时间点

### 直觉

基础备份像"存档点"，归档日志像"录像带"：从存档点出发重放录像，可以在任意一帧停下。这就是时间点恢复（Point-in-Time Recovery, PITR）。

### 结构：PITR 时间轴

```text
WAL / binlog 归档流
══════╤══════════════════════╤═══════════╤════════════► t
      │                      │           │
 08:00 基础备份           23:47:52     00:03       02:00 现在
 (pg_basebackup /         误执行          深夜发现
  XtraBackup 全量)        DROP TABLE orders

恢复路径：
[基础备份 08:00] ──重放归档日志──► [停到 23:47:51] ← recovery_target_time
                                      （drop 前一秒，表还在）
```

RPO 取决于日志的连续归档：日志断档的区间就是无法到达的区间。同理，恢复能到达的最早时间点是最老基础备份的起始时刻——保留期内第一份全量的位置决定了 PITR 窗口的左边界。

### PostgreSQL 16 的 PITR

```ini
# 生产端 postgresql.conf：持续归档 WAL
archive_mode = on                        # 需重启生效
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'   # %p＝待归档 WAL 文件的完整路径，%f＝文件名
archive_timeout = 300                    # 空闲时也定期切档，缩短归档延迟
```

```bash
# 恢复端：把基础备份放回数据目录后配置
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-09-06 23:47:51+08'
# 也可用 recovery_target_lsn / recovery_target_xid 精确定位
touch $PGDATA/recovery.signal            # 声明进入恢复模式后启动
```

到达目标时间点后，PG 16 默认 `recovery_target_action = 'pause'` 暂停等待确认，检查无误后 `pg_wal_replay_resume()` 放行（或配置 `promote`/`shutdown`）。这是防止"一恢复过头又跑过了 drop 点"的保险。

另一个关键概念是**时间线（timeline）**：恢复出的实例提升为主后会分叉出新时间线（如从 00000001 分叉出 00000002），此后它产生的 WAL 与原时间线不再兼容。`recovery_target_timeline` 控制沿哪条时间线重放（PG 16 默认 `latest`，自动选最新分叉）。这解释了 [09](./09-replication-ha.md) 里"从库反复失败重搭"的一类根因：PITR 出的实例想接管旧集群时，必须显式规划时间线。

### MySQL 8.0 的 PITR

MySQL 侧的"录像带"是二进制日志（binary log, binlog），前提是开启 binlog 并可靠保留：保留期由 `binlog_expire_logs_seconds` 控制（MySQL 8.0 默认 2592000 秒即 30 天，取代 8.0 之前的 `expire_logs_days`）。空间紧张时常见的误操作是临时调短保留期，PITR 可达窗口随之收缩——调参之前先核对全量备份 + 日志链是否仍然完整衔接。

```bash
# 1) 恢复基础备份到临时实例；位点来自备份时记录（如 --source-data=2 的头注释）：
-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='binlog.000123',
--    SOURCE_LOG_POS=157;

# 2) 找到事故事件的位点
mysqlbinlog binlog.000124 | grep -n -i -B2 'DROP TABLE'

# 3) 从备份位点重放到事故之前
mysqlbinlog --start-position=157 --stop-position=<事故事件起点> \
  binlog.000123 binlog.000124 | mysql -u root -p app_tmp
# GTID 模式下可改用 GTID 集合截断，效果等价（GTID＝全局事务标识，09 篇）
```

### 典型场景走查：误 DROP TABLE 的完整恢复

1. **止血**：立刻冻结生产写入（限流或切只读），并保留全量 binlog/WAL——删掉日志就永远回不来了。具体动作：MySQL 立即 `FLUSH BINARY LOGS` 切新档，把事发前后的 binlog 文件复制到安全位置；PG 端确认归档目录已收到最新 WAL，必要时 `SELECT pg_switch_wal();` 强制切档推进归档；
2. **恢复到临时实例**：用最近基础备份恢复出隔离环境，绝不直接在生产上重放；
3. **PITR 到事故前一秒**：按上节方法停到 drop 之前，`pause` 确认表完好；
4. **导出该表**：`pg_dump -t orders` / `mysqldump app orders`；
5. **回生产**：导入表数据，校验行数与抽样，恢复写入。

注意第 4 步的局限：drop 之后到止血之前写入的其他表数据，若也需要精确合并，要在临时实例上继续重放到止血点后做更细的对账——这正是"止血越快，找回越多"的原因。

## 六、3-2-1 原则与备份安全

**3-2-1 原则**：至少 **3** 份副本（生产 + 2 份备份），存于 **2** 种不同介质（如磁盘 + 对象存储），其中 **1** 份异地（跨机房/跨区域）。勒索与误删都能波及同机房的全部副本，异地是最后防线。

备份本身的安全常被忽视：

- **备份文件是全量数据的明文集合**，泄露面比生产库还大（一个文件拿走所有表）：存储与传输加密（传输走 TLS，落盘用 KMS 托管密钥或 gpg 加密文件）、备份账号最小权限、文件权限收紧；
- **不可变存储（immutability）**：对象存储的对象锁（object lock，如 S3 Object Lock 的合规模式）让备份在保留期内写后不可删改，即使备份服务器凭据泄露，勒索软件也无法加密历史备份。

异地副本同样要纳入演练：从未启用过的异地链路（网络、权限、工具）在真实故障时才第一次打通，失败率远高于本地链路。

## 七、复制不是备份

主从复制（见 [09](./09-replication-ha.md)）解决可用性，不解决备份：

- 误操作会**实时复制**到每个从库——`DROP TABLE` 在从库上执行得一样快；
- 延迟复制（MySQL `SOURCE_DELAY`、PG `recovery_min_apply_delay`）只是把事故传播推迟 N 小时，窗口内的脏事务依旧会落地，真正的"回退"仍要靠 PITR；
- 备份链路必须**独立于复制拓扑**：独立账号、独立存储、独立权限，不因主从切换而中断。

"复制不是备份"不等于"不能在从库上备份"：把备份任务放在从库上执行以转移主库 IO 压力是常见实践，但要先确认从库状态——MySQL 用 `SHOW REPLICA STATUS`（8.0.22+，旧名 `SHOW SLAVE STATUS`）核对复制线程存活与 `Last_Error`，PG 对比 `pg_stat_replication` 的重放位置。此时备份的是"从库认为的数据"，从库损坏或落后时备份也随之失真，从库备份前必须校验复制完好。

## 八、备份验证：未经演练的备份等于没有备份

备份体系的价值只能在恢复时兑现，而恢复是条脆弱链路：备份文件损坏、权限缺失、日志断档、版本不匹配、恢复步骤与真实环境不符——任何一环都会让"看起来有备份"在事故当口归零。

```text
一次真实恢复要打通的链条（任一环断裂即失败，演练就是逐环加压）：

 备份存储 ──► 完整性校验 ──► 恢复到隔离实例 ──► 全局对象补齐 ──► 应用连通 ──► 冒烟查询
 （异地可达）  （校验和/verify）  （物理拷贝或重放）  （角色/扩展/账号）  （连接串/网络）  （业务只读验证）
      │            │                │                 │              │            │
   副本被误删    文件静默损坏      版本/参数不匹配      忘了 globals    防火墙/密码   数据语义不对
```

演练清单：

- **定期恢复到隔离环境**（频率对齐 RTO 要求：在线业务至少每月，至少每季度）；
- **数据抽检**：关键表行数 `SELECT count(*)`、抽样行内容比对、`CHECKSUM TABLE`（MySQL）逐表核对；
- **计时对照 RTO**：从"开始恢复"到"应用可连"全程计时，超出 RTO 就回头改方案（换物理备份/提高并行度/预置热备机）；
- **应用连通验证**：恢复出的实例用应用真实的连接串与账号试连、跑冒烟查询——权限缺失、缺少角色、扩展未装这类问题只有应用能暴露；
- **日志链完整性**：验证从最老基础备份到当前的 WAL/binlog 无断档（PITR 的可达范围）。

每次演练留档：恢复时间线、各环节耗时、发现的问题与修复动作。它既是下次演练的对照基线，也是监管场景下证明 RPO/RTO 承诺的证据。

工具生态一句话：pgBackRest 与 Barman 内建备份校验与保留策略，可托管全量/增量与 WAL 归档；云托管数据库普遍提供自动备份 + 跨区域复制 + PITR，恢复演练仍需自证。

## 九、备份策略设计示例

下表是三类典型场景的起点模板，落地时按第一节的 RPO/RTO 数字与存储成本校准：

| 场景 | RPO 目标 | RTO 目标 | 参考方案 |
|---|---|---|---|
| 小型业务 | ≤ 24h | 数小时 | 每日 `pg_dump`/`mysqldump` 逻辑全量，保留 7 天，每周一份异地 |
| 中大型在线业务 | ≤ 5min | ≤ 1h | 每周物理全量 + 每日增量 + WAL/binlog 归档 30 天（PITR）+ 异地副本 |
| 监管严格（金融/医疗） | 秒级 | 分钟级 | 上述 + 对象存储不可变保留（1~7 年）+ 季度恢复演练留痕 |

保留期不是越长越好：存储成本、恢复链长度、合规下限三者取交集，并明确"过期备份的销毁流程"。

策略也不是一次定稿：新表忘记纳入备份范围、流量增长导致备份窗口超时、异地副本权限随组织变动失效，都会让既定策略悄悄失效。把"备份范围、保留期、最近一次演练结果"纳入季度复核，并在新表上线清单里加一项"是否已纳入备份"——备份体系最常见的故障不是工具坏了，而是有人不知道它没覆盖自己。

## 开发者清单

该做：

- 上线任何数据库前先写下该业务的 RPO/RTO 数字——所有备份决策由它推导。
- mysqldump 固定带 `--single-transaction --source-data=2`（纯 InnoDB）——一致性快照且保留 PITR 锚点。
- 开启并监控 WAL/binlog 归档，磁盘告警阈值给归档目录留余量——日志断档直接扩大 RPO。
- 恢复演练纳入周期性运维日历，演练计时对照 RTO——没演练过的备份不算备份。
- 误操作后第一时间冻结写入并保护日志——止血越快，可找回的数据越多。
- 备份文件加密存储、最小权限、保留 1 份异地副本——按 3-2-1 对账。

不该做：

- 拿从库当备份——误删和勒索会实时同步过去。
- 对混杂存储引擎的库只信 `--single-transaction`——MyISAM 表不在快照内。
- 在生产实例上直接做 PITR 重放——永远先恢复到隔离的临时实例。
- 对云盘做"裸快照"而不做一致性协调——torn page 与缺失日志衔接点会让快照不可恢复。
- 把恢复脚本只存在出事的同一台机器/同一账号下——备份链路要与生产故障域隔离。
- 只备份不备份"全局对象"——角色、权限、扩展（`pg_dumpall --globals-only`）漏掉会导致应用连不上恢复出的实例。

## 常见误区

1. **"有主从复制就够了，不用备份。"** 复制防机器故障，不防误删与勒索：破坏性操作会被忠实地复制到每个从库。
2. **"备份成功 = 恢复有保障。"** 备份作业绿了只说明拷贝完成；恢复链路上的损坏、版本、权限问题只有演练能暴露。
3. **"逻辑备份导出快，恢复也快。"** 恰恰相反：导出读一遍数据，恢复要把每条 SQL 重新执行一遍（索引、redo、单线程），大库上比物理恢复慢一个数量级。
4. **"每日全量备份能恢复到任意时间点。"** 全量只覆盖备份时刻；两个全量之间的数据要靠 WAL/binlog 归档重放，没有归档就没有 PITR。
5. **"云盘快照是一键一致的。"** 快照瞬间的页可能写了一半，且缺少日志衔接点；必须配合 `pg_backup_start/stop` 或 FTWRL（FLUSH TABLES WITH READ LOCK）/fsfreeze 做一致性协调。
6. **"备份文件存在 DBA 本机目录里安全。"** 备份是全量数据的副本，权限与加密要求应等同于生产；3-2-1 中那份异地副本是勒索场景的最后防线。

## 自测题

1. RPO 和 RTO 分别衡量什么？由谁决定？（数据丢失量上限 / 服务中断时长上限；由业务分级决定，备份方案是推导结果。）
2. `mysqldump --single-transaction` 的一致性原理是什么？对 MyISAM 表为什么失效？（InnoDB 的 MVCC 一致性快照事务；MyISAM 不支持 MVCC，不在同一快照内。）
3. 为什么逻辑备份的恢复远慢于物理备份？（恢复=逐条重放 SQL、重建索引、生成 redo，通常单线程；物理恢复是文件拷贝。）
4. PITR 的两个必备组件是什么？（基础备份 + 从备份点起连续归档的 WAL/binlog。）
5. PostgreSQL 恢复到 `recovery_target_time` 后默认发生什么？为什么这样设计？（默认 pause 暂停等待确认；防止恢复越过头，给人工检查留窗口。）
6. 误 DROP TABLE 后，为什么第一动作是冻结写入而不是马上恢复？（止血越早，需精细对账的数据窗口越小；且要保护现场日志不被覆盖。）
7. 延迟复制能替代 PITR 吗？（不能，只是推迟事故传播；真正回退仍需基础备份+日志重放。）
8. 3-2-1 原则的三个数字分别指什么？（3 份副本、2 种介质、1 份异地。）

## 关联阅读

- [06 · 日志与恢复](./06-wal-recovery.md)——WAL/redo/binlog 机制，PITR 的物理基础
- [04 · 并发控制与 MVCC](./04-mvcc.md)——一致性快照导出的原理
- [09 · 复制与高可用](./09-replication-ha.md)——复制与备份的职责边界、延迟复制
- [01 · 存储引擎与数据组织](./01-storage-engine.md)——数据文件与页结构，物理备份的对象
- [14 · 分区与分表](./14-partition-shard.md)——按分区归档与 DETACH，备份之外的瘦身手段
- [16 · 安全与权限](./16-security.md)——备份账号最小权限与数据加密
