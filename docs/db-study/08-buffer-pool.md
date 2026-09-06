# 08 · 缓冲池与缓存（Buffer Pool & Caching）

> 数据库大部分时候快，不是因为它算得快，而是因为它根本没碰磁盘。缓冲池（Buffer Pool）把磁盘上的页缓存在内存里，把一次页访问从毫秒级压到百纳秒级，是两库性能的第一杠杆。本篇讲清读路径与命中率、InnoDB 的 midpoint LRU 与 PG 的 clock-sweep 如何防止热数据被冲刷、脏页与刷脏如何联动造成写入停顿，以及容量规划与"重启后变慢"的应对。

## 读完本篇你应能回答

- 内存、SSD、HDD 的随机访问延迟差多少个量级？缓冲池到底省掉了什么？
- 一次读页的路径是什么？两库各自怎么看命中率、各有什么坑？
- InnoDB 为什么把新页插在 LRU 的 5/8 处？解决什么病？PG 的 clock-sweep 如何达到同一目的？
- 脏页、redo 空间、写入停顿之间的因果链是什么？
- effective_cache_size 为什么不分配内存？shared_buffers 为什么只给 25% 起步？
- 为什么重启/切主后会变慢？如何预热？大导出为什么要错峰？

## 一、为什么需要缓冲池：延迟的量级阶梯

### 直觉

磁盘比内存慢的不是"一点"，是几个数量级。缓冲池的全部意义：把对磁盘页的重复访问变成内存访问。它换来的不是百分之几的优化，而是每个数量级的差距。

### 结构

```text
延迟量级阶梯（近似值，领会数量级即可）

  内存 DRAM 随机访问          ~100 ns
      ↓ ×1,000
  SSD 随机读（NVMe 更快些）   ~100 µs
      ↓ ×100
  HDD 随机读（寻道+旋转）     ~10 ms   ←  是内存的 100,000 倍

  一次 B+ 树点查 ≈ 3~4 次页访问：
    页全部命中缓冲池   → 亚微秒级/次，单核每秒可做几十万次
    每层都打 SSD      → ~0.3 ms/次
    每层都打 HDD      → ~30 ms/次，差 5 个数量级
```

### 机制细节

数据库的最小读写单位是页（page）：InnoDB 默认 16KB，PG 默认 8KB。任何一行的读写都要先把它所在的页取进内存——不存在"只从磁盘读一行"。缓冲池就是页的内存驻留地：读时先把页读入池再解行；写时改的是池内的页，同时记日志（呼应 [./06-wal-recovery.md](./06-wal-recovery.md)），不直接写数据文件。

页一旦常驻，B+ 树的逐层下降、索引页内的二分、同一热点行的反复更新，全部发生在内存。工作集（working set，业务实际反复触碰的数据页集合）能装进缓冲池，是 OLTP 低延迟的前提；装不进，性能就会以随机 IO 的量级崩塌。

量化感受：一张 1000 万行的订单表约 2~3GB，若每天活跃的只有最近一周写入的行、约占全表 3%，池 8GB 时全部是热的；池缩到 2GB，每天对老数据的零星访问都在打盘——同一个业务，两种命运，差别只在"工作集是否在内存"。

### 对开发者的实际影响

- 同一台机器，"热数据全在内存"和"热数据一半在内存"的 p99 可能差 10 倍以上——容量规划按工作集大小算，不是按总数据量算。
- 优化器成本模型里"随机读贵、顺序读便宜"的假设（见 [./07-query-optimizer.md](./07-query-optimizer.md)），在缓冲池命中时会系统性高估成本——这是"计划对却慢/计划慢却快"的常见来源。

## 二、读路径与命中率

### 结构：一次读页的路径

```text
查询需要一个页（如 B+ 树某层节点）
   │
   ▼
① 查缓冲池页哈希表（space_id + page_no）
   │
   ├─ 命中 ──→ 直接读内存页，命中计数 +1 ──→ 返回行
   │
   └─ 未命中 ─→ ② 从 LRU / free 链表挑牺牲页
                    │
                    ├─ 牺牲页是脏页 → 先把它刷盘（可能等待）
                    │
                    └─ ③ 从数据文件读入该页 → 挂进哈希表与 LRU ──→ 返回行
```

### 机制细节：MySQL 8.0 的观测

```sql
-- MySQL 8.0
SHOW GLOBAL STATUS LIKE 'innodb_buffer_pool_read%';
```

```text
+----------------------------------+-----------+
| Variable_name                    |     Value |
+----------------------------------+-----------+
| Innodb_buffer_pool_read_requests | 185923410 |
| Innodb_buffer_pool_reads         |    120431 |
+----------------------------------+-----------+
```

- `Innodb_buffer_pool_read_requests`：逻辑读次数（向缓冲池要页的总数）。
- `Innodb_buffer_pool_reads`：未命中、真正去读数据文件的次数。
- 命中率 = 1 − 120431 / 185923410 ≈ **99.94%**。

两个坑：这是自实例启动的累计值，重启清零，看趋势而非单点；命中率低不一定是问题（夜间批量扫描拉低均值），未命中的**绝对速率**才是伤害——0.1% 未命中率乘上每秒百万次读，就是每秒上千次真实 IO。

`SHOW ENGINE INNODB STATUS` 的 BUFFER POOL AND MEMORY 段是全量体检（节选）：

```text
----------------------
BUFFER POOL AND MEMORY
----------------------
Total large memory allocated           137438953472
Buffer pool size                       8388604      ← 页数（×16KB 即池大小）
Free buffers                           4096
Database pages                         8372711
Old database pages                     3088610      ← old 区约 37%
Modified db pages                      184224      ← 脏页
Pending writes: LRU 0, flush list 0, single page 0
Pages made young 4281711, not young 98342
Buffer pool hit rate 1000 / 1000       ← 最近 1000 次访问的命中率
```

### 机制细节：PostgreSQL 16 的观测

```sql
-- PostgreSQL 16：shared_buffers 层命中率
SELECT datname, blks_hit, blks_read,
       round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS hit_pct
FROM pg_stat_database
WHERE datname = current_database();

-- PG 16 新增 pg_stat_io：按后端类型/IO 上下文拆分读、写、淘汰
SELECT backend_type, context, hits, reads, evictions, writes
FROM pg_stat_io
WHERE object = 'relation'
ORDER BY reads DESC
LIMIT 10;
```

注意 `blks_read` 的语义：它是"没进 shared_buffers 的读"，这次读可能仍命中操作系统页缓存（第二层缓存）——`blks_hit/(blks_hit+blks_read)` 高估了真盘命中率，真实 IO 归因要结合 pg_stat_io 与 OS 层（iostat 等）看。

### 对开发者的实际影响

- 监控面板上放三个数：命中率、未命中次数/秒、脏页比例——只放一个命中率会漏掉所有规模问题。
- `made young / not young`（MySQL）与 `evictions`（PG）突增，说明缓存压力大，通常是"大扫描进来了"。

## 三、InnoDB 的 LRU 变体：midpoint insertion

### 直觉

经典 LRU 的问题：一次全表扫描会把冷页全部"路过"一遍，而 LRU 只看"最近用过"，无法区分"会用一百次的热页"和"只用一次的扫描页"。于是热数据被整批挤出去——这叫缓存污染。InnoDB 的解法是给新页设"考察期"：先进老区，活过考察期才算真热。

### 结构

```text
无防护的经典 LRU：一次全表扫描的破坏

  扫描前: ┌────────── young（热区）──────────┐
          [热A][热B][热C][暖D][暖E] ...... [冷X][冷Y] → 淘汰端
  扫描后: [扫1][扫2][扫3]...[扫N][热A][热B] ← 扫描页霸占队头
          → 热页被挤向淘汰端大量淘汰，之后点查大面积 miss

InnoDB midpoint insertion（新页插在整个链表 5/8 处）

          ┌── young 区 63% ──────────────┐┌── old 区 37% ───────┐
   队头 → [热A][热B][热C][暖D]...        ‖[新页全插到这里]...[→ 淘汰端]
                                        ↑
          新页须在 old 区停留 ≥ innodb_old_blocks_time（默认 1000 ms）
          之后再次被访问，才晋升 young 头部
          → 一次性扫描的页大多在 old 区自生自灭，young 区热页不受冲刷；
            真正的热页（1 秒后又被访问）才晋升
```

### 机制细节

- `innodb_old_blocks_pct`：old 区占比，默认 37（约 3/8，即插入点在 5/8 处）。
- `innodb_old_blocks_time`：晋升考察期，默认 1000ms。全表扫描读一页到用下一页往往不到 1ms，因此扫描页无法晋升；而 OLTP 热点页在 1 秒内被反复访问，顺利晋升。
- young 区头部附近的页再次命中不会反复搬移到队头——省链表操作开销。
- 结构划分：池按 `innodb_buffer_pool_instances`（默认 8，池小于 1GB 时为 1）分实例减少锁竞争；每实例由 `innodb_buffer_pool_chunk_size`（默认 128MB）的 chunk 组成，实际池大小 = 实例数 × chunk 数 × chunk 大小。

PG 的解法是时钟扫描（clock-sweep）算法，同一目的、不同手法：每个缓冲区带使用计数（usage count，0~5），命中一次 +1，新页从 1 起步；内存不足时各后端用自己的时钟臂绕环扫，每扫过一页计数 −1，减到 0 才可淘汰。一次性扫描的页计数涨不起来，多半在第二次被扫到前就被淘汰；热页计数高，天然免疫冲刷。

| 维度 | InnoDB midpoint LRU | PostgreSQL clock-sweep |
| --- | --- | --- |
| 要解决的病 | 一次性扫描把热页冲掉 | 同左 |
| 手法 | 新页插 old 区，活过考察期才晋升 | usage count 衰减，热页高计数存活 |
| 关键参数 | `innodb_old_blocks_pct` / `innodb_old_blocks_time` | 无直接等价参数（缓冲区总量决定扫描深度） |
| 观测 | SHOW ENGINE INNODB STATUS 的 made young / not young | pg_stat_io 的 evictions / reuses |

### 对开发者的实际影响

- "跑了次报表把库拖慢"的老故事，在两库都有防护，但防护有上限：old 区 / 低计数页仍会被批量换出，池越接近满、影响越大——重查询仍要错峰（见第八节）。
- 别为了"防污染"去调小 old 区比例：`innodb_old_blocks_pct` 这类参数默认值经过大量验证，改它需要压测证据。

## 四、脏页与刷脏：写入停顿的因果链

### 直觉

写路径的契约是"只改内存页 + 记 redo（顺序写），脏页（dirty page，内存与磁盘不一致的页）晚点慢慢刷"。但 redo 空间可复用的前提是检查点（checkpoint）推进，而 checkpoint 推进的前提是"更老的脏页都已落盘"。刷脏速度一旦跟不上 redo 产生速度，系统就会用最硬的方式提醒你：让用户线程停下来帮它刷。

### 结构

```text
写入流量 ↑
  → redo 日志产生速率 ↑（顺序写盘，先落盘再改页）
  → redo 能否复用取决于 checkpoint LSN（日志序号，06 篇详解）能否推进：
        只有"最老脏页已落盘"才能推进
  → 需要的刷脏速率 ≥ redo 产生速率
       ├─ 后台刷脏跟得上（io_capacity 合理、盘够快）
       │     → 平稳：脏页比例在水位内（innodb_max_dirty_pages_pct 默认 75%）
       └─ 跟不上（io_capacity 配低 / 盘慢 / 写入洪峰）
             → redo 空间告急，强制推进 checkpoint
             → 用户线程被拉去同步刷脏（write stall）
             → 写入延迟从亚毫秒跳到几十~几百 ms
```

### 机制细节

- 脏页进入 flush list（按最老修改 LSN 排序），后台线程按 `innodb_io_capacity`（默认 200，含义是"每秒能承担的页 IO 预算"）节奏刷；`innodb_adaptive_flushing=ON`（默认）会按 redo 增速自适应加急。
- 水位：`innodb_max_dirty_pages_pct` 默认 75（脏页比例上限，接近就加急刷），`innodb_max_dirty_pages_pct_lwm` 默认 10（低水位，提前起步摊平）。
- `innodb_io_capacity` 默认 200 是机械盘时代的假设；SSD 应按实测 IOPS 调到几千，`innodb_io_capacity_max`（默认 2000）同步上调。`innodb_flush_neighbors` 默认 1（把相邻页顺带刷了，HDD 友好），SSD 上应设 0。
- 观测：`SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_wait_free'`（等待空闲页的次数，非 0 且增长 = 刷脏跟不上）、SHOW ENGINE INNODB STATUS 的 Pending writes 与 Modified db pages。
- PG 侧同构：bgwriter 平时刷脏，checkpoint 时 checkpointer 集中刷；`checkpoint_completion_target` 默认 0.9（PG 14+），把两次 checkpoint 之间的脏页尽量摊到 90% 的间隔内，避免 IO 尖刺。

呼应 [./06-wal-recovery.md](./06-wal-recovery.md)：redo/WAL 保证不丢，脏页落盘可以拖延，但受日志空间约束——"刷脏速率 ≥ 日志产生速率"是稳态写入的不变量。

### 对开发者的实际影响

- 写入延迟周期性尖刺（每隔几十秒毛刺一次），先查刷脏链路：脏页比例曲线、io_capacity 配置、盘的实际 IOPS。
- 批量导入是 redo 洪峰制造机：调大每次提交的批量、错峰、给 redo/预写空间留足容量。

## 五、InnoDB 的三个附属机制

### Change Buffer（变更缓冲）

二级索引页不在缓冲池时，对它的 DML 变更（插入/删除的索引项）先记入 change buffer（同样有 redo 保护），等该页真正被读入时再合并（merge）。收益：把"N 次读页 + N 次改"合并成"1 次读页 + N 次缓冲修改"，写多读少、二级索引多的场景收益最大。限制：唯一索引必须当场读页验证唯一性，不适用。开关 `innodb_change_buffering` 默认 all。读回时才合并意味着"写入被延迟付账"，读多写少场景反而增加合并负担。

### Adaptive Hash Index（自适应哈希索引，AHI）

InnoDB 观察到某类页被以相同模式（如 `WHERE a = ?` 的等值）高频命中时，自动为"页内定位"建哈希，跳过 B+ 树 3~4 层下降与页内查找。默认开启（`innodb_adaptive_hash_index=ON`，分 8 个分区减少争用）。它只对热点等值模式有收益，且高并发写场景的锁争用偶发反效果——是否关闭交给 DBA 用数据判断，应用层无感知。

### 预读（Read-Ahead）

- 线性预读：顺序读接近某个 extent（InnoDB 以 64 页为一组的分配单位）边界时提前异步读下一组页；阈值 `innodb_read_ahead_threshold` 默认 56（连续读满 64 页窗口中的 56 页即触发）。
- 随机预读：同一 extent 内一定数量页已在池中时预读其余，`innodb_random_read_ahead` 默认 OFF。
- 预读把全表扫描从"逐页随机要"变成"成组顺序要"，是顺扫吞吐的隐性来源——顺序读对 HDD 尤其重要。

## 六、doublewrite：页写入的最后一道保险

呼应 [./06-wal-recovery.md](./06-wal-recovery.md)。脏页是 16KB 写入，而 OS/磁盘的原子写单位通常只有 512B~4KB：断电时可能留下写了一半的页（partial write / torn page）。redo 重放的前提是"基页完好"，半页无法用 redo 修复。InnoDB 的解法：脏页先顺序写入 doublewrite 区域，成功后再写回数据文件自己的位置；崩溃恢复时发现坏页，就从 doublewrite 拿到完好副本再上 redo。`innodb_doublewrite` 默认 ON（8.0.20 起默认为独立的 dblwr 文件）。代价是每页多一次顺序写——别关它，这换来的是崩溃后可恢复。PG 的对应物是 checkpoint 后首次修改整页写入 WAL（full_page_writes，默认 ON）。

## 七、PostgreSQL 的双层缓存

### 直觉

PG 的缓存是两层的：自己管的 shared_buffers 之上，还有操作系统页缓存这层"免费"缓存。没进 shared_buffers 的页，仍可能躺在 OS cache 里——这让 PG 的容量策略与 InnoDB 明显不同。

### 机制细节

- `shared_buffers`：PG 自管缓存，默认仅 128MB，需重启生效；社区经验值从物理内存 25% 起步、按负载上调（常见 25%~40%）。
- 为什么不给到 70%：同一份数据可能同时占 OS cache 和 shared_buffers（双缓存，double buffering），shared_buffers 超过热工作集后收益递减，而 OS cache 同时服务排序临时文件、顺序读预读与其他文件；两层的组合通常优于单层独占。
- `effective_cache_size`：**只给优化器的估算参数**，告诉它"shared_buffers + OS cache 大概有多少可用"（默认 4GB），影响它认为索引随机读有多大概率命中缓存，从而影响索引 vs 顺序扫的选择。它不分配任何内存——这是最常被问到的一个误解。
- InnoDB 走的是另一条路：`innodb_flush_method` 默认 O_DIRECT（Linux，8.0 起），数据文件读写绕过 OS cache，避免双缓存，缓冲池即全部缓存。
- PG 16 的 `pg_stat_io` 按后端类型/IO 上下文（normal / vacuum / bulkwrite）拆出 hits、reads、evictions、reuses（环形缓冲复用，与大块写相关）等，是容量判断的一手数据；配合 `pg_buffercache` 扩展可看池内到底驻留了哪些表的页：

```sql
-- PostgreSQL 16：池内驻留页数最多的表（contrib 扩展）
CREATE EXTENSION pg_buffercache;
SELECT c.relname, count(*) AS pages,
       sum((b.isdirty)::int) AS dirty_pages
FROM pg_buffercache b
JOIN pg_class c ON b.relfilenode = c.relfilenode
GROUP BY c.relname
ORDER BY pages DESC
LIMIT 10;
```

| 维度 | MySQL 8.0 (InnoDB) | PostgreSQL 16 |
| --- | --- | --- |
| 自管缓存 | buffer pool，常配到物理内存 50%~70% | shared_buffers，25% 起步 |
| OS cache 角色 | 数据文件绕过（O_DIRECT），redo 走 OS | 第二层缓存，参与读路径 |
| 防扫描污染 | midpoint LRU | clock-sweep usage count |
| 页大小 | 16KB | 8KB |
| 命中率观测 | SHOW GLOBAL STATUS / SHOW ENGINE INNODB STATUS | pg_stat_database / pg_stat_io |
| 优化器的缓存感知 | 无直接等价 | effective_cache_size（仅估算） |

### 对开发者的实际影响

- PG 的"命中率"天然分层：shared_buffers 命中率与真盘命中率是两个数，排查 IO 问题必须落到 pg_stat_io 与 OS 层。
- InnoDB 池就是全部家当，给足比什么都重要；PG 则要在两层之间找平衡，盲目调大 shared_buffers 常常收益甚微。

## 八、容量规划与生产实践

- MySQL：专机部署建议 `innodb_buffer_pool_size` 为物理内存的 50%~70%，剩余留给连接内存、临时表、OS 与备份工具；混部（应用同机）要相应缩减。8.0 支持在线调整（自动取整到 chunk × instances 的整数倍）：

```sql
-- MySQL 8.0：在线调到 64GB（观察 resize 期间的性能波动，避开高峰）
SET GLOBAL innodb_buffer_pool_size = 68719476736;
```

- 监控：命中率 + 未命中速率 + free buffers + 脏页比例 + `Innodb_buffer_pool_wait_free`。池持续满载且未命中速率上升，说明工作集长大了。结构化采集走 `SELECT * FROM information_schema.INNODB_BUFFER_POOL_STATS\G`（与 SHOW ENGINE INNODB STATUS 同源），比解析文本输出可靠。
- 冷缓存（cold cache）："重启后变慢"多数不是坏了，是缓冲池空了，所有访问都要打盘。两个缓解：
  - MySQL 8.0 默认开启缓冲池导出/加载（`innodb_buffer_pool_dump_at_shutdown` / `innodb_buffer_pool_load_at_startup`，默认导出最近使用的 25%，`innodb_buffer_pool_dump_pct`），重启后自动回灌。
  - PG 用 pg_prewarm 扩展预热（含 autoprewarm，定期保存页清单、重启后自动回放）：

```sql
-- PostgreSQL 16
CREATE EXTENSION pg_prewarm;
SELECT pg_prewarm('orders');   -- 把表页读入 shared_buffers
```

- 主从切换是新形式的冷缓存：新主的缓存是读流量预热出来的，与写热点分布不同，切换后预留观察窗口再放量（见 [./09-replication-ha.md](./09-replication-ha.md)）。
- 大扫描/大导出：midpoint 与 clock-sweep 有防护，但 IO 带宽和缓冲区仍会被占。实践：报表和导出走从库；必须在本库跑就错峰；导出工具限制并发与速率。

## 九、全局内存与会话内存：别把账算错

缓冲池是全局共享的，一次性分配；而排序、哈希、临时表这类是会话私有（session-private）内存，按需分配、有上限。OOM 事故的经典公式是"每个连接的私有内存上限 × 峰值连接数 > 剩余物理内存"（详见 [./13-memory-sort-hash.md](./13-memory-sort-hash.md)）。

| 维度 | 全局共享（buffer pool / shared_buffers） | 会话私有（MySQL sort/join buffer；PG work_mem） |
| --- | --- | --- |
| 生命周期 | 实例启动即分配，常驻 | 查询/操作期间按需分配，用完释放 |
| 与并发的关系 | 越共享越划算 | 消耗随并发线性放大 |
| 调大的风险 | 挤占 OS/其他进程，重启恢复慢 | 峰值并发下乘 N，OOM |
| 规划依据 | 热工作集大小 | 单查询算子数 × 峰值并发 |

## 开发者清单

- 容量规划按"热工作集"而不是总数据量算——缓存的是热点，不是全库。
- 告警盯未命中次数/秒与脏页比例，不要只盯命中率——比例会掩盖规模。
- 重启/切主后设预热窗口再放量——冷缓存的 p99 可能高一个数量级。
- 报表、大导出、全表扫描放低峰或走从库——防护机制挡不住 IO 带宽被吃光。
- SSD 上让 DBA 核对 io_capacity 与 flush_neighbors——默认值是机械盘假设。
- 大批量写入分批提交并错峰——redo 洪峰会触发强制刷脏与写入停顿。
- work_mem / sort_buffer_size 调大前先算并发乘数——会话内存在峰值并发下 × N。
- PG 调 shared_buffers 前先看 pg_stat_io——有数据再动容量。
- effective_cache_size 只影响计划，调整它不解决内存问题——别拿它当容量参数。

## 常见误区

1. "effective_cache_size 会分配内存。" 它只是给优化器的估算输入，改它不动任何内存，改的是计划选择。
2. "命中率 99.9% 就没有 IO 问题。" 未命中的绝对次数才是伤害：千万级读量下 0.1% 就是每秒上千次真实 IO；且命中率是历史累计，不代表当前。
3. "缓冲池越大越好。" 超过热工作集后收益递减；挤占 OS（PG 的第二层缓存）与连接内存、拉长重启预热，都是隐性代价。
4. "重启后变慢是版本退化/故障。" 大概率是冷缓存，预热后恢复；归因前先看缓存指标。
5. "MySQL 还有查询缓存（Query Cache），开它更快。" Query Cache 在 8.0 已整体移除；缓冲池缓存的是页，不是查询结果，两者不是一回事。
6. "PG 的 blks_read 就是磁盘物理读。" 它只是没命中 shared_buffers，很可能仍命中 OS cache；真盘 IO 要看 pg_stat_io 与 OS 层。

## 自测题

1. `innodb_old_blocks_time`（默认 1000ms）如何区分"扫描页"与"热页"？
   （全表扫描从读到再访问间隔通常远小于 1s，考察期内不晋升、留在 old 区被淘汰；热点页 1s 内被再次访问，晋升 young。）
2. MySQL 缓冲池命中率的两个变量名？PG 对应的视图与字段？
   （Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests；pg_stat_database 的 blks_hit / blks_read。）
3. redo 空间不足时会发生什么完整链条？
   （强制推进 checkpoint → 用户线程同步刷脏 → 写入停顿，延迟尖刺。）
4. PG 为什么建议 shared_buffers 从 25% 起步而不是 70%？
   （OS cache 是第二层缓存，单层独占造成双缓存浪费；超过热集后收益递减。）
5. change buffer 为什么对唯一索引无效？
   （唯一性必须当场读页校验，不能延迟合并，否则可能放进重复值。）
6. doublewrite 解决什么问题？为什么 redo 自己解决不了？
   （崩溃时的半页写入；redo 重放要求基页完好，半页上无法重放。）
7. 为什么主从切换后新主也可能"变慢"？如何缓解？
   （新主缓存由读流量预热，与写热点分布不同；预留预热窗口/预热工具，再放量。）
8. 一次性全表扫描为什么没把两库的热数据全冲掉？
   （InnoDB midpoint：新页进 old 区不晋升；PG clock-sweep：扫描页 usage count 低，先被淘汰。）

## 关联阅读

- [./01-storage-engine.md](./01-storage-engine.md)——页、文件组织与聚集索引，缓冲池管理的对象。
- [./02-index.md](./02-index.md)——B+ 树逐层下降的读路径，命中与未命中的差异所在。
- [./06-wal-recovery.md](./06-wal-recovery.md)——redo/WAL/checkpoint/full_page_writes，刷脏与 doublewrite 的来龙去脉。
- [./07-query-optimizer.md](./07-query-optimizer.md)——成本模型中的 IO 代价假设与缓存的关系。
- [./09-replication-ha.md](./09-replication-ha.md)——主从切换后的冷缓存与备库分担重查询。
- [./11-performance-tuning.md](./11-performance-tuning.md)——把本篇容量与刷脏观测落成调优流程。
- [./13-memory-sort-hash.md](./13-memory-sort-hash.md)——会话私有内存（排序/哈希）与全局缓存的预算分配。
