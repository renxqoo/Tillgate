# 18 · 字符集与排序规则（Charset & Collation）

> 字符集（charset）决定"字节怎么解释成字符"，排序规则（collation）决定"字符怎么比较"。配置错了，轻则 emoji 存不进、索引悄悄失效，重则查询结果不对而没人报错——同一句话在不同库返回不同结果。本篇讲清 MySQL 与 PostgreSQL 两套体系的差异、隐式转换的经典坑，以及编码问题的系统排查路径。

## 读完本篇你应能回答

- 字符集与排序规则各解决什么问题？UTF-8 的变长结构长什么样？
- MySQL 的 utf8 与 utf8mb4 差在哪？VARCHAR(191) 这个魔数怎么来的？
- `_ci`/`_ai` 后缀什么意思？为什么唯一索引会拒绝 'John' 和 'JOHN' 同时存在？
- `WHERE phone = 13800000000` 为什么全表扫描，还能匹配到 '138abc'？
- 两表 join 报 Illegal mix of collations 怎么定位、怎么治本？
- PostgreSQL 的 collation 来自哪里？为什么 C locale 更快？initdb 为什么要想清楚再选？

## 编码基础十分钟

### 直觉

字符集是"字典"——把编号（码点）对应到字节序列；排序规则是"裁判"——规定两个字符串怎么分出大小与是否相等。字典错了字符变成乱码，裁判错了比较结果悄悄不对。

### 字符集：码点到字节的映射

Unicode 为每个字符分配码点（code point），范围 `U+0000` 到 `U+10FFFF`；UTF-8 是 Unicode 最常用的编码方式，变长 1~4 字节：ASCII 字符 1 字节、常用中文 3 字节、emoji 4 字节。MySQL 的 utf8mb3 最多 3 字节，第四档直接缺失——这是全篇最大的坑。

```text
字符    码点（Unicode）   UTF-8 字节序列        utf8mb3 列的下场
────────────────────────────────────────────────────────────────
'A'     U+0041           41                    OK（1 字节）
'中'    U+4E2D           E4 B8 AD              OK（3 字节）
'北'    U+5317           E5 8C 97              OK（3 字节）
'😀'    U+1F600          F0 9F 98 80           存不进：需要 4 字节，mb3 上限 3 字节
                                          → 严格模式：ERROR 1366 Incorrect string value
                                          → 非严格模式：截断成 '?'
────────────────────────────────────────────────────────────────
验证：SELECT HEX('😀');  → F09F9880（8 个十六进制位 = 4 字节完整无损）
```

### 排序规则：比较与排序的规则集

给定字符集之上，collation 定义"谁等于谁、谁排在前面"，实现方式是给每个字符配比较权重（weight）。例如大小写不敏感（case-insensitive, `_ci`）规则里 'a' 与 'A' 权重相同——不只是排序像相同，等值比较也判相等，这是后面唯一索引"误伤"的根源。

```sql
-- MySQL 8.0：查看字符集及其排序规则
SHOW CHARACTER SET;
SHOW COLLATION WHERE Charset = 'utf8mb4';
```

## MySQL 的 utf8 大坑

### utf8 ≠ UTF-8

MySQL 8.0 中 `utf8` 仍是 `utf8mb3` 的别名：每字符至多 3 字节，存不了 emoji 与部分生僻字。官方计划在未来版本把 `utf8` 改指 utf8mb4，所以新代码一律显式写 `utf8mb4`。MySQL 8.0 起默认字符集已经是 utf8mb4、默认排序规则 utf8mb4_0900_ai_ci——但老库、老表、复制迁移来的列不会自动升级。

```sql
-- MySQL 8.0：盘点存量 utf8mb3 列（utf8 与 utf8mb3 都会被列出）
SELECT table_schema, table_name, column_name, character_set_name, collation_name
FROM information_schema.columns
WHERE table_schema = 'appdb'
  AND character_set_name IN ('utf8', 'utf8mb3');
```

### 四级继承：列 > 表 > 库 > 服务器

MySQL 里字符集与 collation 可以在服务器、库、表、列四级分别设置，最终以"离列最近"的显式定义为准：

```sql
-- MySQL 8.0
CREATE DATABASE appdb CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE t (
  a VARCHAR(50),                                              -- 继承表默认
  b VARCHAR(50) CHARSET utf8mb4 COLLATE utf8mb4_bin           -- 列级覆盖：区分大小写
) CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

SHOW CREATE TABLE t;   -- 确认每列最终生效的 charset / collation
```

要点：`ALTER DATABASE ... COLLATE` 只影响之后新建的表，不会传播到存量表；服务器默认值随版本变过（5.7 → 8.0 默认 collation 从 general_ci 换成 0900_ai_ci），所以"建表语句显式写 CHARSET/COLLATE"是唯一跨实例可复现的做法——依赖默认值的 DDL 在不同环境会产出不同 collation 的表，这正是 join 冲突的常见来源。

### VARCHAR(N) 的 N 是字符数

`VARCHAR(20)` 是 20 个字符，不是 20 字节——中文用户名 20 个字、emoji 昵称 20 个表情，都放得下（受行大小总长约束）。实际存储占"真实字节数 + 长度前缀"。判断"这个字段够不够长"时按字符想，判断"索引是否超限"时按字节想（utf8mb4 最坏每字符 4 字节）。

### 索引字节上限与 VARCHAR(191) 的来历

InnoDB 索引键前缀上限取决于行格式：COMPACT/REDUNDANT 是 767 字节；DYNAMIC/COMPRESSED 是 3072 字节（MySQL 8.0 默认 DYNAMIC，5.7 需开 innodb_large_prefix）。utf8mb4 每字符最多 4 字节，767 ÷ 4 = 191.75，于是老系统里唯一索引列清一色 `VARCHAR(191)`——唯一索引必须覆盖整列（不能只索引前缀），只能把列宽缩到 191。8.0 默认配置下 3072 ÷ 4 = 768 字符，VARCHAR(255) 完全无压力：

```sql
-- MySQL 8.0（DYNAMIC 行格式）
CREATE TABLE users (
  id    bigint PRIMARY KEY,
  email VARCHAR(255) NOT NULL,        -- 255×4 = 1020 字节 < 3072
  UNIQUE KEY uk_email (email)
) CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;
```

## 排序规则细讲

### 后缀语义

| 后缀 | 含义             | 效果示例            |
|------|------------------|---------------------|
| `_ai` | 口音不敏感（accent-insensitive） | 'é' = 'e' 为真 |
| `_ci` | 大小写不敏感（case-insensitive） | 'a' = 'A' 为真 |
| `_cs` | 大小写敏感       | 'a' = 'A' 为假      |
| `_ks` | 假名敏感（日语） | 平假名/片假名区分   |
| `_bin` | 按码点二进制比较 | 一切差异都算不相等 |

### utf8mb4_general_ci vs utf8mb4_0900_ai_ci

| 对比维度   | utf8mb4_general_ci            | utf8mb4_0900_ai_ci                  |
|------------|-------------------------------|-------------------------------------|
| 默认版本   | MySQL 5.x 的默认              | MySQL 8.0 的默认                    |
| 规则依据   | 简化的单字符映射，规则老旧    | 基于 Unicode 9.0.0 排序算法（UCA） |
| 口音处理   | 部分口音错误折叠              | ai 语义准确                         |
| 典型差异   | 'ß' = 's' 为真                | 'ß' = 'ss' 为真                     |
| 混用       | 与 0900 系比较会触发 collation 冲突 | 两套默认的库 join 是事故高发区 |

"同一查询不同库结果不同"的实感：升级到 8.0 的库（0900_ai_ci）里 `WHERE name = 'Straße'` 能匹配 'Strasse'，5.7 导入的库（general_ci）里匹配不到；反过来 general_ci 里 'ß'='s' 判相等，0900 里判不等。

### 唯一索引"误伤"：大小写不同也算重复

```sql
-- MySQL（utf8mb4_0900_ai_ci）
INSERT INTO users (email) VALUES ('John@ex.com');   -- OK
INSERT INTO users (email) VALUES ('JOHN@ex.com');
-- ERROR 1062: Duplicate entry 'JOHN@ex.com' for key 'uk_email'
-- 原因：_ci 下 'John' = 'JOHN' 判相等，唯一索引据此拒绝
```

需要区分大小写的唯一性：列改用 `utf8mb4_0900_as_cs` 或 `utf8mb4_bin`，或写入前统一 `LOWER()` 再对结果列建唯一索引。

### 中文排序真相：ORDER BY 不是拼音序

utf8mb4 各 collation 对汉字的权重基本按码点序（Unicode 中日韩统一表意文字区块大致按部首笔画排列），不是拼音序——`ORDER BY name` 排出来的顺序对中文用户是"乱序"。常见近似方案：

```sql
-- MySQL：借 GBK 编码序（一级字库约 3755 个常用汉字按拼音排列）
SELECT name FROM customers ORDER BY CONVERT(name USING gbk);
-- 局限：二级字库的生僻字仍按部首序，非全量拼音
```

PostgreSQL 在 glibc 的 `zh_CN.UTF-8` locale 下 `ORDER BY` 可按拼音，但结果依赖操作系统的 locale 实现——同一份数据换个环境可能变序。强拼音需求要么显式冗余一列拼音（维护成本自负），要么应用层排序。

## 隐式转换两连坑

### 坑一：字符串列与数字比较

```sql
-- MySQL：phone 为 VARCHAR(20) 且有索引
SELECT * FROM users WHERE phone = 13800000000;   -- 全表扫描
```

规则：字符串列与数字比较时，MySQL 把两边都转成 DOUBLE——等于给 phone 列套了隐式类型转换（implicit type conversion），转换后的表达式不可走索引（原理见 [02 索引原理](./02-index.md)、[07 查询执行与优化器](./07-query-optimizer.md)）。更糟的是语义污染：

```sql
SELECT '138abc' = 138;   -- 返回 1：'138abc' 转 DOUBLE 取前导数字得 138
SELECT 'abc' = 0;        -- 返回 1：无数字前缀转成 0
-- 于是 WHERE phone = 13800000000 会把 '138abc'、'138'、'138.0' 全查出来
```

修复：永远同型比较——`WHERE phone = '13800000000'`。反向场景（INT 列与 '123' 比较）只是常量被转换成数字，索引仍可用，但也应养成带引号的习惯，别依赖。

### 坑二：join 列 collation 不同

```sql
-- MySQL：a 表建库时是 5.7 默认，b 表是 8.0 新建
SELECT * FROM a JOIN b ON a.name = b.name;
-- ERROR 1267 (HY000): Illegal mix of collations
--   (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_0900_ai_ci,IMPLICIT)
```

两个同字符集、不同 collation 的列做比较，两边都是"隐式优先级"，谁也不让谁，直接报错；某些组合（一侧是显式 collation）不报错但一侧索引失效。定位：

```sql
-- 查两列的 collation
SELECT table_name, column_name, collation_name
FROM information_schema.columns
WHERE table_schema = 'appdb' AND column_name = 'name';
SHOW VARIABLES LIKE 'collation_%';   -- 连接与服务端默认
```

治本是统一 DDL（迁移时把 collation 写进建表模板）；救急用显式转换，但要清楚代价——`CONVERT` 作用在列上会让该侧索引失效，只适合临时查询：

```sql
SELECT * FROM a JOIN b
  ON a.name = CONVERT(b.name USING utf8mb4) COLLATE utf8mb4_0900_ai_ci;
```

混用来源排查看三处：5.7 → 8.0 迁移（默认 collation 变了）、建表语句漏写 COLLATE、跨库/跨实例 join。

## PostgreSQL 的另一套体系

### 模型差异对比

| 维度              | PostgreSQL 16                          | MySQL 8.0                          |
|-------------------|----------------------------------------|------------------------------------|
| 字符集（encoding）| 建库时定死，之后不可 ALTER（推荐 UTF8）| server / 库 / 表 / 列 四级可设     |
| collation 来源    | 操作系统 glibc 或 ICU，建库/建列时指定 | 服务端内置规则集（数百个，随版本分发）|
| 大小写不敏感      | 非确定性 collation（ICU，PG 12+）或 lower() 索引 | 默认 _ci 即不敏感            |
| 连接字符集        | client_encoding 自动转换               | SET NAMES / character_set_*        |
| 改字符集          | 重建库（dump/restore 或逻辑复制）      | ALTER TABLE ... CONVERT TO（重建表）|
| LIKE 前缀走索引   | C locale 直接可用；其他需 text_pattern_ops / ICU | 一般可用（索引序与 collation 一致）|

```sql
-- PostgreSQL：查库的 encoding 与 collation
SHOW server_encoding;
SELECT datname, pg_encoding_to_char(encoding) AS enc, datcollate, datctype
FROM pg_database;
```

encoding 与库级 locale 在 `CREATE DATABASE` 一次定死，之后不可 ALTER。建库默认克隆 template1（它已继承 initdb 时的 locale），要指定不同 locale 必须改用 `template0`（不含这些继承的纯净模板）才能脱离该默认：

```sql
-- PostgreSQL：显式建一个 UTF8 + C locale 的库
CREATE DATABASE appdb
  ENCODING 'UTF8'
  LC_COLLATE 'C'
  LC_CTYPE 'C'
  TEMPLATE template0;
```

需要本地化排序时不必整库妥协，单列覆盖即可（前提是该 locale 在 initdb 时已被收录——指 initdb 时操作系统里可用的 locale 集合已包含它，不在其中的名字无法使用）：

```sql
-- PostgreSQL：只有客户名列按中文 locale 排序
ALTER TABLE customers
  ALTER COLUMN name TYPE varchar(64) COLLATE "zh_CN.utf8";
```

### 非确定性 collation：PG 的"大小写不敏感"

PG 默认的字符串比较是确定性的（deterministic）：'a' 与 'A' 永不相等。要做到 MySQL `_ci` 那样的语义，用 ICU 的非确定性 collation（PG 12 起）：

```sql
-- PostgreSQL 12+（需 ICU 支持）
-- locale 读法：und＝不限语言；ks-level2＝二级比较强度（忽略大小写等次级差异）
CREATE COLLATION ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
CREATE TABLE users (id bigint PRIMARY KEY, email text COLLATE ci);
CREATE UNIQUE INDEX ON users (email);
INSERT INTO users VALUES (1, 'John@ex.com');
INSERT INTO users VALUES (2, 'JOHN@ex.com');
-- ERROR: duplicate key value violates unique constraint（'a'='A' 语义下视为重复）
```

代价：非确定性 collation 需要做规范化比较，比确定性慢；且不支持 LIKE 与正则匹配（直接报错）。多数应用更常见的选择仍是"写入统一 lower() + 函数索引"：

```sql
CREATE UNIQUE INDEX ON users (lower(email));
```

### C locale 的性能真相

initdb 时选 `LC_COLLATE=C`（POSIX）：排序退化为按码点 memcmp，最快；更关键的是 B+ 树索引的序等于码点序，`LIKE 'abc%'` 能直接转化为范围扫描走普通索引。非 C locale（如 en_US.UTF-8、zh_CN.UTF-8）下 glibc 的排序序与码点序不一致，普通 B+ 树无法服务 LIKE 前缀——LIKE 前缀能走索引，靠的是把前缀条件转成 `>= 'abc' AND < 'abd'` 的范围扫描，前提是索引顺序＝逐字符码点顺序，glibc 本地化排序不满足这一前提——所以要专用 opclass（操作符类，决定索引按什么规则比较键值）：

```sql
-- PostgreSQL：非 C locale 下让 LIKE 'abc%' 走索引
CREATE INDEX ON users (email text_pattern_ops);
```

### initdb 的选择为什么深远

initdb 决定 template 库的 locale 与 encoding，是集群级默认；单库可以选不同 collation，但 encoding 建库后不可改（改 = 新建库 + dump/restore）。还有个隐蔽雷区：glibc 大版本升级会改变某些 locale 的排序结果，已建索引可能与新排序不一致而悄悄损坏——PG 官方要求 OS/glibc 升级后对受影响库执行 REINDEX，这一步漏掉就是定时炸弹。实践建议：initdb 用 `--encoding=UTF8 --locale=C`（或明确选 ICU），需要本地化排序的列显式 `COLLATE`，把"快而稳定"作为默认、"本地化"作为例外。

## 迁移与治理

### 起步统一，别留两套默认

- MySQL：建表模板写死 `CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`；确认 `character_set_server`/`collation_server` 与连接层默认（8.0 连接默认已是 utf8mb4）。
- PostgreSQL：encoding 统一 UTF8；collation 策略在 initdb 时定，别默认继承再后悔。
- 应用连接建立时显式声明字符集，不依赖握手默认值：

```sql
-- MySQL：连接初始化（等价于同时设置 client / connection / results 三个变量）
SET NAMES utf8mb4;
```

统一 collation 与统一 charset 是两件事，5.7 → 8.0 迁移常见"charset 都是 utf8mb4、collation 却一边 general_ci 一边 0900_ai_ci"的半吊子状态：

```sql
-- MySQL：库默认（只影响新表）与存量表分别处理
ALTER DATABASE appdb COLLATE = utf8mb4_0900_ai_ci;
ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

### 后期 ALTER 的代价

```sql
-- MySQL：转字符集 = 重建表与全部索引（COPY 算法，锁写）
ALTER TABLE users CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
-- 大表在线改用 gh-ost / pt-online-schema-change
```

PG 没有对应 ALTER：新建库 + 逻辑导出导入（或逻辑复制滚动切换）。结论回到上一条：起步统一一个字符集，是最便宜的时机。

### 跨系统一致性

Elasticsearch 全线 UTF-8，无字符集概念；Redis 按字节透传，谁写谁负责编码；MySQL 的连接层是转换枢纽（`character_set_client` → 列字符集 → `character_set_results`）：

```text
客户端（应用）
   │  发送字节（按 character_set_client 解释）
   ▼
连接层：语句与字面量按 character_set_connection 解析
   │  写入时把字面量转换成「列的字符集」；读出时转换成 character_set_results
   ▼
列（最终权威）：utf8mb4 / utf8mb3 / latin1 …
────────────────────────────────────────────────────────────────
任何一层不是 utf8mb4，4 字节字符（emoji）都可能在转换中丢失或报错
老版本默认 latin1 的连接（未 SET NAMES）是中文变问号的经典成因
```

### emoji 丢失的分层排查路径

```text
用户输入 😀  →  应用层显示或落库后变成 ? 或 �
   │
   ▼
[1] 应用层：是否按字节截断？前端 maxlength 按 UTF-16 码元计数，
    会把 emoji 的代理对截成半个，显示为 �
   │ 排除
   ▼
[2] 连接层（MySQL）：SHOW VARIABLES LIKE 'character_set_%'
    client / connection / results 是否都是 utf8mb4？
    老驱动或连接串未指定 charset 时可能落在 latin1 / utf8mb3
   │ 排除
   ▼
[3] 存储层：目标列 character_set_name 是否 utf8mb4？
    utf8mb3 列在严格模式下直接报 ERROR 1366（非严格则截断）
   │
   ▼
验证手段：SELECT '😀', HEX('😀');
  结果 F09F9880 = 4 字节完整；变成 3F3F（??）即该层已经丢字节
```

排查思想：从应用向后逐层验证字节是否完整，先证明"哪一层丢的"，再改配置——避免同时改多处后不知道哪招生效。

## 开发者清单

- 新项目 MySQL 一律 utf8mb4 + utf8mb4_0900_ai_ci 并写进建表模板：杜绝 utf8mb3 混入与默认漂移。
- 接手老库先扫描 information_schema 里 utf8/utf8mb3 的列与两套默认 collation 并存：存量坑先盘点再排期改。
- 字符串与数字比较永远同型（常量带引号）：隐式转换让索引失效且把 '138abc' 当匹配。
- join 列两端 charset 与 collation 必须一致：混用轻则索引失效重则报 1267。
- 要区分大小写的唯一性，列用 `_cs`/`_bin` 或统一 lower 后建索引：`_ci` 会拦下大小写不同的"重复值"。
- PG 新集群 initdb 想清楚 locale（推荐 C+按列 COLLATE，或直接 ICU）：事后改要重建库。
- OS/glibc 大版本升级后按官方要求 REINDEX 受影响的库：collation 变化会悄悄损坏 text 索引。
- 中文按拼音排序列表时显式用 `CONVERT(... USING gbk)`（MySQL）或应用层排序：默认 ORDER BY 不是拼音序。
- 跨系统（ES/缓存/DB）链路约定全线 UTF-8：Redis 的字节透传把编码责任留给写入方。

## 常见误区

- "MySQL 的 utf8 就是 UTF-8"——utf8 是 utf8mb3 的别名，每字符至多 3 字节，emoji 直接存不进；真 UTF-8 是 utf8mb4。
- "VARCHAR(255) 太长会爆索引"——那是 COMPACT 行格式 767 字节上限的时代（utf8mb4 下 191 字符）；8.0 默认 DYNAMIC 上限 3072 字节，255 无压力。
- "`_ci` 只影响排序不影响查询"——它同样作用于等值比较：'a'='A' 为真，唯一索引会把大小写不同的值判为重复。
- "两个库都是 utf8mb4，join 就没问题"——collation 不同照样报 Illegal mix of collations 或一侧索引失效。
- "PostgreSQL 的 ORDER BY 会按拼音排中文"——取决于 collation：C/多数 ICU 下按权重（码点）序，只有 glibc 的 zh_CN locale 才近似拼音。
- "emoji 丢了就是数据库的锅"——应用截断、连接字符集、列字符集三层都可能丢，逐层用 HEX() 验证再下结论。

## 自测题

1. utf8mb3 列插入 emoji 会发生什么？（答：严格模式报 ERROR 1366 Incorrect string value；非严格模式截断为 '?'。）
2. VARCHAR(191) 这个魔数怎么来的？8.0 还需要吗？（答：COMPACT 行格式 767 字节索引上限 ÷ utf8mb4 每字符 4 字节；8.0 默认 DYNAMIC 上限 3072 字节，最长可整列索引 768 字符。）
3. utf8mb4_general_ci 与 utf8mb4_0900_ai_ci 的两个可感知差异？（答：规则依据（简化映射 vs Unicode 9.0 UCA）；'ß' 的折叠（general: ='s'，0900: ='ss'）。）
4. `WHERE phone = 13800000000` 为什么全表扫描且能匹配 '138abc'？（答：字符串列与数字比较两边转 DOUBLE，列被隐式转换不可走索引；'138abc' 转数字取前导 138 也相等。）
5. Illegal mix of collations 如何定位与治本？（答：查 information_schema.columns 两列 collation；治本统一 DDL，救急 CONVERT 但会废掉该侧索引。）
6. PG 非确定性 collation 能做什么、代价是什么？（答：'a'='A' 判等、唯一索引不区分大小写；更慢且不支持 LIKE/正则。）
7. 为什么 glibc 升级后要 REINDEX？（答：locale 排序结果变化会使既有 text 索引与新比较不一致，索引可能漏行。）
8. emoji 丢失的排查顺序与验证手段？（答：应用层截断 → 连接字符集 → 列字符集，逐层 `SELECT '😀', HEX('😀')` 验证字节是否完整。）

## 关联阅读

- [02 · 索引原理](./02-index.md)：索引字节上限、text_pattern_ops 与隐式转换导致的索引失效。
- [07 · 查询执行与优化器](./07-query-optimizer.md)：隐式转换如何改写执行计划。
- [11 · 性能调优基础](./11-performance-tuning.md)：C locale 与排序成本在调优中的位置。
- [14 · 分区与分表](./14-partition-shard.md)：异构同步链路中的编码一致性。
- [16 · 安全与权限](./16-security.md)：连接字符集与宽字节注入的关系。
