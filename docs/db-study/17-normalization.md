# 17 · 范式与反范式（Normalization & Denormalization）

> "这张表要不要拆？"是每个建表的人绕不开的问题。范式（Normal Form）给了系统性的答案：把会引发数据异常的冗余消掉；而反范式（Denormalization）则承认"多一次 join 是真实成本"，在可控范围内冗余换性能。本篇用一张"坏订单表"从第一范式拆到 BCNF，再讲清反范式的正当场景、维护手段与决策框架。

## 读完本篇你应能回答

- 函数依赖（Functional Dependency, FD）是什么？如何用它推导一张表的范式等级？
- 1NF/2NF/3NF/BCNF 各消除了什么依赖？每一步对应哪些数据异常？
- 为什么 OLTP 核心交易系统偏 3NF？join 的成本直觉是什么？
- 订单存"下单时的商品名与价格"为什么不违反范式？
- 可变冗余列、计数器列、汇总表各自的维护手段与漂移风险是什么？
- EAV 模式为什么是索引灾难？JSONB 替代了什么、又付出了什么？

## 一张"坏订单表"贯穿全篇

### 直觉

范式化就是"一个事实只在一个地方说"。同一事实在多处存放，就总有说不一致的一天——异常不是概率问题，是时间问题。

### 起点：一张表打天下

```text
orders_bad
+----------+---------+------------+------------+------------+-----------------+
| order_id | cust_id | cust_name  | cust_city  | order_date | items           |
+----------+---------+------------+------------+------------+-----------------+
| 1001     | C001    | 张三       | 杭州       | 2026-01-03 | iPhone×2;iPad×1 |
| 1002     | C002    | 李四       | 深圳       | 2026-01-04 | iPhone×1        |
| 1003     | C001    | 张三       | 杭州       | 2026-01-05 | MacBook×1       |
+----------+---------+------------+------------+------------+-----------------+
问题：items 是"重复组"——按商品统计、对单商品加约束都做不了
```

### 函数依赖：分析工具

函数依赖（Functional Dependency, FD）记作 `X → Y`：属性集 X 相同的行，Y 必然相同。"订单号决定客户"即 `order_id → cust_id`。范式分析就是找出一张表里所有的 FD，再检查它们是否都"依附于键"。

## 逐级拆解：从坏表到 BCNF

### 1NF：原子性，无重复组

把 items 拆成"一订单行一商品行"，主键变为复合键 `(order_id, product_id)`：

```text
order_items_v1                    主键 = (order_id, product_id)
+----------+------------+---------------+-------------+---------------+---------+--------+
| order_id | product_id | product_name  | category    | cust_id       | qty     | price  |
+----------+------------+---------------+-------------+---------------+---------+--------+
| 1001     | P100       | iPhone 15     | 手机        | C001│…后3列略 | 2       | 5999   |
| 1001     | P101       | iPad Air      | 平板        | C001│…后3列略 | 1       | 4399   |
| 1002     | P100       | iPhone 15     | 手机        | C002│…后3列略 | 1       | 5999   |
| 1003     | P102       | MacBook Pro   | 笔记本      | C001│…后3列略 | 1       | 14999  |
+----------+------------+---------------+-------------+---------------+---------+--------+
省略说明：cust_name、cust_city、order_date 三列仍在本表同列存放（随订单每行重复），
数据行"C001│…后3列略"表示 cust_id 为 C001、其后这 3 列省略；
另有品类折扣列 category_discount（值随品类重复）同样未画出。
```

1NF 达成，但能读出这些 FD：`(order_id, product_id) → qty、price`；`order_id → cust_id、cust_name、cust_city、order_date`；`product_id → product_name、category、category_discount`。后两组的左部只是主键的一部分——部分函数依赖出现了。

### 2NF：消除部分依赖，同时暴露三类异常

非主属性对复合键的部分依赖（partial dependency）是这一版的核心问题（术语：主属性＝出现在某个候选键里的属性，候选键指能唯一确定整行的键；其余属性为非主属性）。在拆解之前，先看它直接引发的三类数据异常（行级演示）：

- 插入异常：想登记新品类"手表"下的商品 W200（还没有任何订单）——`order_id` 是主键一部分，没有订单就没法插入这行，商品资料无处安放。
- 更新异常：张三（C001）改名"张三丰"，他在 v1 中有 3 行——UPDATE 必须命中全部 3 行；漏改 1 行，同一个 cust_id 就有两个名字。
- 删除异常：删除订单 1002（李四唯一的订单），李四的姓名与城市随行消失——客户资料被订单数据"连坐"。

2NF 的动作：把只依赖 `order_id` 的属性搬去 orders，只依赖 `product_id` 的搬去 products：

拆分结果（2NF）：

- `orders(order_id PK, cust_id, order_date, cust_name, cust_city)`
- `order_items(order_id, product_id, qty, unit_price)`（price 在此改名 unit_price——它是成交单价，语义更准确，后文统一使用），`PK = (order_id, product_id)`
- `products(product_id PK, product_name, category, category_discount)`

### 3NF：消除传递依赖

orders 里仍有 `order_id → cust_id → cust_name、cust_city`——非主属性传递依赖于主键（transitive dependency），改客户名的更新异常依然存在。products 里 `product_id → category → category_discount` 同理。继续拆：

```sql
-- PostgreSQL / MySQL 通用（3NF 目标结构）
CREATE TABLE customers (
  cust_id     char(4) PRIMARY KEY,
  cust_name   varchar(64) NOT NULL,
  cust_city   varchar(32) NOT NULL
);

CREATE TABLE categories (
  category        varchar(32) PRIMARY KEY,
  category_discount numeric(5,2) NOT NULL      -- 品类折扣只在这一处维护
);

CREATE TABLE products (
  product_id   bigint PRIMARY KEY,
  product_name varchar(128) NOT NULL,
  category     varchar(32) NOT NULL REFERENCES categories(category)
);

CREATE TABLE orders (
  order_id    bigint PRIMARY KEY,
  cust_id     char(4) NOT NULL REFERENCES customers(cust_id),
  order_date  date NOT NULL
);

CREATE TABLE order_items (
  order_id   bigint NOT NULL REFERENCES orders(order_id),
  product_id bigint NOT NULL REFERENCES products(product_id),
  qty        int NOT NULL,
  unit_price numeric(12,4) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
```

拆完后：客户改名一行 UPDATE；新品上架不依赖订单；删除最后一个订单不丢客户资料。这就是"每个事实只说一遍"的直接收益。

### BCNF：每个决定因素都是候选键

3NF 留了一个尾巴：允许决定因素不是候选键，只要被决定的属性是主属性。BCNF（Boyce-Codd Normal Form）收掉它——所有非平凡 FD（非平凡＝右边的属性不在左边集合里；平凡依赖"知道 X 自然知道 Y"，无需单独关注）的左部都必须是候选键（candidate key）。经典反例：

| 要素     | 内容                                                             |
|----------|------------------------------------------------------------------|
| 表结构   | `tutoring(student, subject, tutor)`                              |
| 函数依赖 | `(student, subject) → tutor`；`tutor → subject`                  |
| 业务约定 | 一门课同时只有一位老师；一位老师只教一门课                       |
| 候选键   | `(student, subject)`；由 tutor → subject，知道 `(student, tutor)` 即可推出 subject、唯一确定整行，故它也是候选键                       |
| 判定     | `tutor → subject` 的左部不是候选键 → 3NF 成立（subject 是主属性），BCNF 不成立 |

它的异常：想登记"新老师教物理"但还没学生选他，插不进去；老师换课要改多行。拆成 `tutors(tutor PK, subject)` 与 `enrollments(student, tutor PK)` 即达 BCNF。再往上还有 4NF/5NF（多值依赖、连接依赖），业务系统里 BCNF 基本够用。

### 拆表演进与范式对比

```text
            orders_bad（违反 1NF：items 重复组）
                        │ 拆重复组，一商品一行
                        ▼
            order_items_v1（1NF，PK=(order_id, product_id)）
                        │ 消除部分依赖
        ┌───────────────┼──────────────────┐
        ▼               ▼                  ▼
     orders       order_items          products          ← 2NF
  (order_id…)   (oid,pid,qty,unit_price)  (pid,name,category…)
        │                                    │
        ▼ 消除传递依赖                        ▼
   customers ←── orders              categories ←── products   ← 3NF
                                                          （+BCNF：决定因素皆为候选键）
```

| 范式 | 一句话定义                       | 消除的依赖       | 遗留问题                     |
|------|----------------------------------|------------------|------------------------------|
| 1NF  | 属性原子、无重复组               | 多值字段/重复组  | 部分依赖带来的冗余           |
| 2NF  | 非主属性完全依赖于键             | 部分函数依赖     | 传递依赖                     |
| 3NF  | 非主属性不传递依赖于键           | 传递函数依赖     | 主属性上的依赖               |
| BCNF | 一切决定因素皆为候选键           | 主属性上的依赖   | 多值依赖（4NF 处理）         |

## 范式的收益与代价

### 收益：一致性由结构保证

所有异常（插入/更新/删除）的根源都是冗余；范式消除冗余后，不一致在结构上不可能发生——不是靠纪律，是靠约束与外键。

### 代价：join 数量上升

"订单列表页"从坏表的一次单表扫描，变成 orders join customers join order_items join products 的四表连接。成本直觉（详见 [02 索引原理](./02-index.md)、[08 缓冲池](./08-buffer-pool.md)）：驱动表每输出一行，被 join 表要在索引上做一次 B+ 树定位——百万行的表约 3 层、千万行约 4 层；热页在缓冲池里是内存比较（微秒级），冷页则是一次随机 IO（SSD 百微秒级、机械盘毫秒级，差 2~3 个数量级）。join 本身不可怕，可怕的是"每行都要随机 IO 的嵌套循环"。

### 为什么 OLTP 核心偏 3NF

账务、库存、订单这类系统里，写路径的一致性错误直接是资金事故；而读路径的 join 在正确索引下是确定成本的。3NF 用确定的 join 成本换结构级一致性，这笔账在核心交易场景永远划算。报表与 Feed 则相反（见决策框架）。

## 反范式的正当场景与手法

### 手法一：事实快照列——不是冗余，是正确建模

```sql
-- PostgreSQL / MySQL 通用
CREATE TABLE order_items (
  order_id     bigint NOT NULL,
  product_id   bigint NOT NULL,
  product_name varchar(128) NOT NULL,     -- 下单时刻的商品名快照
  unit_price   numeric(12,4) NOT NULL,    -- 成交价快照
  qty          int NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
```

`(order_id, product_id) → unit_price` 与 `products.price` 是两个不同的事实：成交价与现价。成交价由"那笔交易"决定，不由"商品当前状态"决定——函数依赖的左部不同，因此这不是 3NF 意义上的冗余。商品改名、调价之后历史订单展示当时的名称与价格，这正是业务想要的。快照列写入后不再变化，天然一致、零维护。

### 手法二：可变冗余列——必须配维护与对账

```sql
ALTER TABLE users ADD COLUMN order_count int NOT NULL DEFAULT 0;

-- 应用层双写（同一事务内）
UPDATE orders SET ... WHERE ...;
UPDATE users SET order_count = order_count + 1 WHERE id = :uid;
```

同事务内双写是原子的（回滚一起回滚），漂移不来自事务，来自绕过这条路径的写入：后台订正脚本、手工 SQL、软删除没减计数、逻辑 bug。所以必须有对账兜底：

```sql
-- 对账：找出计数与事实不一致的用户
SELECT u.id, u.order_count, o.cnt
FROM users u
JOIN (SELECT cust_id, COUNT(*) AS cnt FROM orders GROUP BY cust_id) o
  ON o.cust_id = u.id
WHERE u.order_count <> o.cnt;
```

### 手法三：计数器列——原子但会热

`UPDATE t SET c = c + 1` 单语句原子、行锁保护，并发正确性没问题（见 [04 并发控制与 MVCC](./04-mvcc.md)、[05 锁与阻塞](./05-lock.md)）。问题在吞吐：同一行的 UPDATE 在行锁上串行化，热点行（明星店铺的计数）每秒几千次自增就开始排队。缓解手段：

```sql
-- 拆行：把一个计数器摊成 N 片，写随机片，读时聚合
CREATE TABLE counter_shards (
  key   varchar(64) NOT NULL,
  shard tinyint NOT NULL,
  cnt   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (key, shard)
);
UPDATE counter_shards SET cnt = cnt + 1
WHERE key = 'shop:1' AND shard = :rand_0_15;      -- 写入分散
SELECT SUM(cnt) FROM counter_shards WHERE key = 'shop:1';  -- 读取聚合
```

或者用 Redis 缓冲计数、定时批量落库（牺牲崩溃窗口内的精确性）。

### 手法四：汇总表与物化视图

```sql
-- PostgreSQL：物化视图（Materialized View）
CREATE MATERIALIZED VIEW daily_sales AS
SELECT created_at::date AS day, sum(amount) AS total, count(*) AS orders
FROM orders
GROUP BY 1;

CREATE UNIQUE INDEX ON daily_sales (day);   -- CONCURRENTLY 刷新的前提

REFRESH MATERIALIZED VIEW CONCURRENTLY daily_sales;
```

`CONCURRENTLY` 不阻塞读，但有两个代价：必须有唯一索引；仍然是全量刷新一个大事务，源表越大刷新越重。MySQL 没有物化视图，等价物是汇总表+定时任务：

```sql
-- MySQL 8.0：事件定时刷新汇总表
CREATE TABLE daily_sales (day date PRIMARY KEY, total numeric(14,2), orders int);

CREATE EVENT ev_refresh_daily_sales ON SCHEDULE EVERY 5 MINUTE DO
  -- REPLACE INTO：按主键冲突则先删后插（MySQL 方言），定时任务重复刷新不会重复累计
  REPLACE INTO daily_sales
  SELECT DATE(created_at), SUM(amount), COUNT(*)
  FROM orders
  WHERE created_at >= NOW() - INTERVAL 2 DAY
  GROUP BY DATE(created_at);
```

### 一致性兜底手段对比

| 手段           | 实时性   | 谁来兜底     | 优点             | 风险                             |
|----------------|----------|--------------|------------------|----------------------------------|
| 应用双写（同事务） | 强一致 | 应用+事务    | 简单直接         | 忘写、路径被绕过                 |
| 触发器维护     | 强一致（逐行） | 数据库   | 绕不过去         | 隐式逻辑难排查、批量导入慢       |
| 定时对账修复   | 最终一致 | 后台任务     | 兜住一切偏差     | 有延迟，只治标                   |

```sql
-- PostgreSQL：触发器维护冗余列（示例）
CREATE FUNCTION bump_order_count() RETURNS trigger AS $$
BEGIN
  UPDATE users SET order_count = order_count + 1 WHERE id = NEW.cust_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bump AFTER INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION bump_order_count();
```

实践结论：实时路径选双写或触发器其中之一，再叠一层定时对账做最终兜底——前两者负责"平时对"，对账负责"坏了能发现并修"。

## 决策框架：什么时候反范式

| 信号         | 偏范式                       | 偏反范式                          |
|--------------|------------------------------|-----------------------------------|
| 读写模式     | 写多读少、更新频繁           | 读极多（一次写入被成千次读复用）  |
| 一致性容忍   | 账务/库存/订单：错一分钱是事故 | 计数、摘要、Feed：秒级偏差可接受 |
| 字段变更性质 | 维度字段频繁变化             | 事实一旦写下不再改（快照）        |
| 团队维护能力 | 有能力维护对账/刷新任务      | 团队更适应简单直接的 CRUD         |

典型结论：订单与账务偏 3NF——一致性压倒一切，冗余字段也必须是快照而非可变冗余；Feed、报表、搜索结果偏反范式——读性能优先，接受最终一致并配对账。

## EAV 警告与 JSONB 替代

实体-属性-值（Entity-Attribute-Value, EAV）模式：属性名也变成数据。看似"无限灵活"，实为四重灾难：

```text
eav_rows
+-----------+-----------+--------+
| entity_id | attribute | value  |
+-----------+-----------+--------+
| 1001      | 颜色      | 红     |
| 1001      | 尺寸      | XL     |
| 1002      | 颜色      | 蓝     |
+-----------+-----------+--------+
```

- 类型系统全丢：value 列只能 text，数值/日期比较要显式转换；
- 查询退化：取实体的 3 个属性要自 join 三次或行转列；
- 索引只能建 `(attribute, value)`，选择性差，范围查询基本全扫；
- 无法加外键与列级约束，写入脏数据没有拦截。

现代替代是 JSONB（PostgreSQL）+ GIN 索引（GIN＝倒排类索引，支持"包含/存在"类查询，是 JSONB/数组/全文检索的标配，见 [02 索引原理](./02-index.md)）：

```sql
-- PostgreSQL
CREATE TABLE products (
  id    bigint PRIMARY KEY,
  attrs jsonb NOT NULL
);

CREATE INDEX idx_attrs ON products USING gin (attrs jsonb_path_ops);

SELECT * FROM products WHERE attrs @> '{"颜色": "红"}';   -- 等值查找走 GIN
```

但要说清 schemaless 的代价：键没有类型约束、不能被外键引用、键名拼错不报错、更新任意键会重写整个 JSON 值、范围/排序能力弱于原生列。JSONB 解决的是"EAV 的索引灾难"，不是"约束的责任"——后者只是从数据库搬回了应用层。

## 建表清单：键、时间戳与状态

- 代理键（surrogate key，自增/UUID）做主键，业务唯一性用唯一约束表达：业务键（手机号、证件号）会被业务改写，还往往是 PII；主键一旦被引用就不该变。自然键（natural key）适合做查询与约束，不适合做主键。
- PostgreSQL 用 `timestamptz` 而非 `timestamp`：`timestamptz` 存 UTC 时刻、按会话时区显示；无时区的 `timestamp` 在数据跨时区后无法解释"那到底是哪个时刻"。MySQL 的 `TIMESTAMP` 随会话时区换算但上限是 2038-01-19（32 位秒数），`DATETIME` 是无时区的墙上时间——无论选哪个，约定统一存 UTC。
- 魔法字符串（`'Y'`/`'N'`/`'03'`）用 CHECK 约束或枚举替代：注意 MySQL 8.0.16 起 CHECK 约束才真正生效（之前只解析不执行）；PostgreSQL 的 enum 类型改值集较繁琐，多数场景查表+CHECK 更灵活。
- 复合主键合理就用（如 order_items），不必强造代理键；但外键引用端会变宽，量级大的表常见做法仍是代理键+唯一约束。

## 开发者清单

- 每个事实只在一个表里保有权威版本，其余出现处要么是快照要么是缓存：明确权威源才谈得上一致性。
- 历史语义字段（成交价、当时的名称）直接快照存储：这不是反范式，是建模正确，删掉它反而丢信息。
- 可变冗余列上线时就要写明维护手段（谁写、何时写、怎么对账）：没有对账的冗余必然漂移。
- 计数器写入超过单行每秒几百次就预拆分或加缓冲：行锁串行化会成为吞吐上限。
- 物化视图/汇总表写明刷新频率与失效语义：读数据的人需要知道它"旧"到什么程度。
- OLTP 核心表保持 3NF：一致性收益大于多几个索引 join 的确定成本。
- 触发器只做兜底性维护、别堆业务规则：隐式副作用是排查地狱，批量导入时逐行触发也慢。
- EAV 想清楚再上，优先 JSONB+GIN：EAV 的灵活以索引与约束为代价。
- 主键用代理键，业务唯一性交给唯一约束：业务键会变，主键不该变。
- 时间戳统一 `timestamptz`（PG）或统一 UTC 约定（MySQL）：无时区的时间在跨区团队手里就是 bug 温床。

## 常见误区

- "范式越高越好"——范式是手段不是目的；Feed/报表场景强上 3NF 只会得到 join 风暴，OLTP 与 OLAP 的取舍方向本就相反。
- "冗余一定有害"——事实快照（成交价、下单时商品名）是正确建模，删掉它历史信息就丢了；范式要消除的是"可变事实的重复存放"。
- "count(*) 慢就加计数列"——先量写入 QPS 与对账成本；低频计数直接算更便宜，热点计数拆行或缓冲才是正解。
- "触发器保证一致，用它维护一切"——逐行触发的隐式逻辑在批量导入时可慢一个量级，且对应用层完全不可见，排查时没人会先想到它。
- "JSONB 可以替代关系表"——无外键、无列级约束、整值重写更新；JSONB 适合真正开放的扩展属性，不适合核心结构。
- "3NF 的表就没有任何冗余"——3NF 只消除非主属性对键的传递依赖；候选键决定的属性（如成交价快照）仍然保留，也不该消。

## 自测题

1. 什么是函数依赖 X → Y？在坏表 v1 里举出两个例子。（答：X 相同则 Y 必相同；如 `order_id → cust_name`、`product_id → product_name`。）
2. 2NF 阶段的三类异常在坏表上分别是什么表现？（答：无订单时新品插不进；客户改名要改多行易漏；删唯一订单连坐删除客户资料。）
3. 3NF 与 BCNF 的差别？给一个满足 3NF 但违反 BCNF 的例子。（答：3NF 允许决定因素非候选键、只要被决定属性是主属性；`(student,subject)→tutor` 且 `tutor→subject`。）
4. 订单表存 unit_price 为什么不违反 3NF？（答：成交价函数依赖于订单行而非商品，与 products.price 是两个事实。）
5. order_count 冗余列的漂移来源有哪些？（答：绕过双写路径的脚本/手工 SQL、软删未减、逻辑 bug；同事务双写本身不漂。）
6. `REFRESH MATERIALIZED VIEW CONCURRENTLY` 的前提与代价？（答：需唯一索引；不阻塞读但仍全量刷新一个大事务。）
7. EAV 的四个问题？JSONB 解决了哪些、留下哪些？（答：丢类型、自 join、索引选择性差、无约束；JSONB+GIN 解决查询与索引，留下无外键/无键级约束/整值重写。）
8. 什么时候选代理键而不是自然键？（答：业务键会变更、含 PII、或被多方引用时；业务唯一性改用唯一约束表达。）

## 关联阅读

- [02 · 索引原理](./02-index.md)：join 的 B+ 树成本、GIN 与 JSONB 查询。
- [04 · 并发控制与 MVCC](./04-mvcc.md)：计数器自增的并发正确性。
- [05 · 锁与阻塞](./05-lock.md)：热点行自增的行锁串行化与拆行缓解。
- [08 · 缓冲池与缓存](./08-buffer-pool.md)：join 随机 IO 与缓存命中的量级差。
- [11 · 性能调优基础](./11-performance-tuning.md)：读多写少场景的系统化优化路径。
- [14 · 分区与分表](./14-partition-shard.md)：分表后跨分片 join 受限时的冗余取舍。
