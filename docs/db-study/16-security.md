# 16 · 安全与权限（Security & Access Control）

> 数据库是数据的最终落脚点，权限一旦失守几乎没有"撤销"可言。本篇把数据库安全拆成网络、传输、认证、授权、数据保护、审计六层纵深防御（Defense in Depth），并重点讲透四件事：最小权限（Principle of Least Privilege）怎么落地、行级安全（Row-Level Security, RLS）怎么做多租户隔离、SQL 注入（SQL Injection）为什么参数化能防以及它防不了什么、加密的三个层次各挡哪类威胁。

## 读完本篇你应能回答

- 六层防线各自挡什么攻击？为什么单靠任何一层都不够？
- PostgreSQL 的"用户"和"角色"是什么关系？MySQL 8.0 的角色为什么需要 SET DEFAULT ROLE？
- 应用运行账号、迁移账号、报表账号各该给哪些权限？默认权限怎么收紧？
- RLS 的 USING 与 WITH CHECK 有什么区别？为什么表 owner 默认不受策略约束？
- 参数化查询为什么能防 SQL 注入？哪些场景参数化救不了？
- 传输加密、静态加密、字段级加密分别解决什么威胁？密码为什么绝不能用 MD5/SHA1 存？

## 纵深防御：六层防线

### 直觉

数据库安全像洋葱，不像保险箱：不存在一道"验明正身就万事大吉"的门，而是每层只挡一类攻击。攻击者在任何一层被拦下都算防御成功；反过来，任何单层被突破都不应导致全盘皆输。评估一个安全方案时先问三个问题：它属于哪一层？它挡的攻击是什么？没挡住的攻击靠哪层兜底？

### 全景图

```text
攻击者
  │
  ▼
┌──────────────────────────────────────────────────────────────────┐
│ L1 网络层    VPC / 安全组 / 私网监听      挡「谁能碰到端口」      │
├──────────────────────────────────────────────────────────────────┤
│ L2 传输层    TLS                          挡「链路窃听与中间人」 │
├──────────────────────────────────────────────────────────────────┤
│ L3 认证层    scram-sha-256 / caching_sha2 挡「你是谁」            │
├──────────────────────────────────────────────────────────────────┤
│ L4 授权层    GRANT/REVOKE + RLS           挡「你能碰哪些数据」   │
├──────────────────────────────────────────────────────────────────┤
│ L5 数据保护  静态加密 / 字段级加密        挡「盘被偷/备份泄露」  │
├──────────────────────────────────────────────────────────────────┤
│ L6 审计层    连接日志 / 审计插件          回答「发生过什么」     │
└──────────────────────────────────────────────────────────────────┘
```

### 逐层拆解：每层挡什么

#### 网络层：让攻击者碰不到端口

数据库端口只应出现在私网。公网暴露的 3306/5432 会被全网扫描器在分钟级内发现，弱口令字典+已知 CVE 打一遍，是勒索与挖矿入侵的第一来源。落法：数据库部署在 VPC（Virtual Private Cloud）内网，安全组只放行应用网段与堡垒机；运维经跳板机访问；绝不把 `0.0.0.0/0` 开给数据库端口。这一层挡的是"扫端口的外部攻击者"，挡不住已进入内网的横向移动——那是后面几层的事。

#### 传输层：TLS

不加密的连接，凭据与查询内容在内网明文可截获。TLS（Transport Layer Security）同时防被动窃听与主动中间人（Man-in-the-Middle, MITM）。

PostgreSQL 客户端用 `sslmode` 控制等级，差异要分清：

| sslmode     | 是否加密 | 校验证书链 | 校验主机名 | 挡住的攻击            |
|-------------|----------|------------|------------|-----------------------|
| disable     | 否       | -          | -          | 无，只该用于本地测试 |
| prefer（libpq 默认） | 能连就加密 | 否 | 否  | 被动窃听              |
| require     | 是       | 否         | 否         | 被动窃听              |
| verify-ca   | 是       | 是         | 否         | 主动中间人            |
| verify-full | 是       | 是         | 是         | 主动中间人 + 仿冒主机 |

注意 `prefer`/`require` 只保证"加密"，不验证服务端身份，遇到主动中间人攻击会被静默降级或劫持；跨公网或强合规场景用 `verify-full`。

```sql
-- MySQL 8.0：账号级强制 TLS + 全局收紧 TLS 版本
-- host 通配符：% 匹配任意主机，10.% 即 10.x.x.x 网段的任意主机
CREATE USER 'app'@'10.%' IDENTIFIED BY '...' REQUIRE SSL;
SET PERSIST require_secure_transport = ON;
SET PERSIST tls_version = 'TLSv1.2,TLSv1.3';
```

#### 认证层：证明"你是谁"

PostgreSQL 16 的默认口令哈希是 scram-sha-256（Salted Challenge Response Authentication Mechanism；PG 14 起为默认，旧版为 md5）。这类"挑战应答"机制的原理：服务器先发一个随机数（挑战），客户端用它加上自己的口令算出一份证明发回去——全程不传输口令本身，窃听也拿不到口令。连接方式由 `pg_hba.conf` 按条目控制：

```ini
# TYPE  DATABASE  USER  ADDRESS       METHOD
hostssl all       all   10.0.0.0/8    scram-sha-256   # 网络连接：必须 TLS + SCRAM
local   all       all                 peer            # 本机 socket：系统用户对齐
```

铁律：网络条目禁用 `trust`（免密直入）与 `password`（明文）；存量 `md5` 账号按"设 `password_encryption = 'scram-sha-256'` 后重设一次口令"完成迁移。

MySQL 8.0 默认认证插件是 caching_sha2_password（挑战应答；完整认证阶段需要 TLS 或 RSA 密钥交换做安全通道）。`mysql_native_password` 已标记弃用，别给新账号指定。安装后立刻处理：root 空口令/随机初始口令、删除匿名账号与 test 库（`mysql_secure_installation` 一条龙），并确认 validate_password 组件的策略等级。失败登录减速可启用 CONNECTION_CONTROL 插件，抬高在线爆破成本。

#### 授权层：证明"你能做什么"

认证回答"你是谁"，授权回答"你能碰哪些对象"。这是本篇的主体，见下面两节。

#### 数据保护层：即使拿到文件也读不懂

授权挡不住"整块盘被偷、备份文件外流"。静态加密（Encryption at Rest）与字段级加密（Field-Level Encryption）补这个缺口，见[加密的三个层次](#加密的三个层次)一节。

#### 审计层：事后能回答"发生过什么"

前五层都是事前防御，审计是事中记录与事后取证。见[审计与敏感数据治理](#审计与敏感数据治理)一节。

## 授权模型：两套不同的世界观

### PostgreSQL：一切皆角色

PG 没有独立的"用户"对象——带 `LOGIN` 属性的角色就是用户，不带 `LOGIN` 的角色用来打包权限。角色可以嵌套，成员默认继承（INHERIT）所加入角色的权限（PG 16 行为）。

```sql
-- PostgreSQL 16
CREATE ROLE app_rw LOGIN PASSWORD '...';   -- 可登录角色 = "用户"
CREATE ROLE dev_team NOLOGIN;              -- 纯权限打包角色
GRANT dev_team TO alice WITH ADMIN OPTION; -- alice 还能把 dev_team 再授予他人
SET ROLE dev_team;                         -- 切换当前生效身份（需相应权限）
```

对象权限的再转授用 `WITH GRANT OPTION`，角色成员关系的再转授用 `WITH ADMIN OPTION`，两者是不同的东西。

### MySQL 8.0：用户、角色与权限粒度

MySQL 的用户是 `user@host` 二元组，角色只是"可授给用户的权限容器"，且授予后默认不激活：

```sql
-- MySQL 8.0
CREATE ROLE 'rpt_read', 'app_rw';
GRANT SELECT ON appdb.* TO 'rpt_read';
GRANT SELECT, INSERT, UPDATE, DELETE ON appdb.* TO 'app_rw';

CREATE USER 'reporter'@'10.%' IDENTIFIED BY '...' REQUIRE SSL;
GRANT 'rpt_read' TO 'reporter'@'10.%';
-- 角色默认不激活，登录后要 SET ROLE；配默认角色免去这一步：
SET DEFAULT ROLE 'rpt_read' TO 'reporter'@'10.%';
-- 或让所有已授予角色登录即激活：
SET PERSIST activate_all_roles_on_login = ON;
```

权限粒度五级：全局 `*.*` → 库 `appdb.*` → 表 `appdb.orders` → 列 `SELECT(col1)` → 存储例程。粒度越窄越好定位"谁能干这件事"，回收时也干净。

### schema 默认权限：PG 15 为什么收回 public 的 CREATE

PG 14 及以前，任何角色（PUBLIC）对 `public` schema 默认有 `CREATE`——意味着随便一个只读应用账号都能在里面建对象。配合默认 `search_path` 含 public——search_path 是 PG 解析裸对象名时的 schema 查找顺序（类似 shell 的 PATH），谁能在排在前面的 schema 里建同名对象，谁的函数就会被别人的查询优先解析到——攻击者可以抢注与目标查询同名的函数/表实施劫持，从而提权。PG 15 起新建库默认收回该权限。存量旧库要自查补刀：

```sql
-- PostgreSQL：查看默认权限
SELECT nspname, nspacl FROM pg_namespace WHERE nspname = 'public';
-- PG 15 之前创建的库手动收紧（新库已默认收回）
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

### 授权模型对比

| 维度       | PostgreSQL 16                     | MySQL 8.0                                  |
|------------|-----------------------------------|--------------------------------------------|
| 用户与角色 | 用户=带 LOGIN 的角色；可嵌套继承  | 用户独立（user@host）；角色需显式激活      |
| 权限粒度   | 库 / schema / 表 / 列 / 序列 / 函数 | 全局 / 库 / 表 / 列 / 存储例程           |
| 默认公共区 | public schema 曾默认可 CREATE（PG 14 及以前） | 无对应概念                          |
| 权限再转授 | WITH GRANT OPTION / WITH ADMIN OPTION | WITH GRANT OPTION / WITH ADMIN OPTION |
| 收权语法   | REVOKE ... CASCADE / RESTRICT     | REVOKE                                     |

## 最小权限落地：三类账号

一个典型 Web 应用只需要三种数据库身份：运行、迁移、报表。

### 应用运行账号：只给 DML

```sql
-- PostgreSQL 16
CREATE ROLE app_rw LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA app TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO app_rw;
-- 迁移账号今后建的表也要自动授权给运行账号
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
```

```sql
-- MySQL 8.0
CREATE USER 'app'@'10.%' IDENTIFIED BY '...' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON appdb.* TO 'app'@'10.%';
```

要点：

- 显式列举不含 DDL、不含 `TRUNCATE`（PG 中 TRUNCATE 是独立权限；MySQL 中 TRUNCATE 需要 DROP 权限）。运行账号没有 DROP，注入或代码 bug 也删不了表。
- `DELETE` 也可以按需收紧：软删除设计下（`UPDATE ... SET deleted_at = now()`），运行账号不授 DELETE，物理删除走单独的运维账号定时执行：

```sql
-- PostgreSQL
REVOKE DELETE ON ALL TABLES IN SCHEMA app FROM app_rw;
```

### 迁移账号：DDL 专用

```sql
-- PostgreSQL：ALTER/DROP 表需要 owner 身份，迁移账号通常就是对象 owner
CREATE ROLE migrator LOGIN PASSWORD '...';
GRANT CREATE, USAGE ON SCHEMA app TO migrator;
```

```sql
-- MySQL 8.0
CREATE USER 'migrator'@'10.%' IDENTIFIED BY '...' REQUIRE SSL;
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES, LOCK TABLES ON appdb.* TO 'migrator'@'10.%';
```

迁移账号只在发布窗口使用，不常驻任何常驻进程。运行/迁移分离还有个连带收益：RLS 才能真正约束运行账号（见下节 owner 问题）。

### 报表只读账号

```sql
-- PostgreSQL 14+：内置只读角色（整个集群范围，图省事时用）
GRANT pg_read_all_data TO rpt_ro;
-- 更精细：只开放单个 schema
GRANT USAGE ON SCHEMA app TO rpt_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO rpt_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app GRANT SELECT ON TABLES TO rpt_ro;
```

报表流量还应分流到只读副本，避免一张大宽表查询打挂主库（见 [09 复制与高可用](./09-replication-ha.md)）。

## 行级安全（RLS）：多租户隔离的正规军

### 直觉

RLS 把"这行数据放不放行"从"每个查询自觉加 WHERE"升级成"表级强制策略"——策略忘了写在代码里是漏一查，忘了写在表上是漏一张表。

### 机制：USING 与 WITH CHECK

- `USING`：对已存在的行求值，决定它对 SELECT/UPDATE/DELETE 是否可见；
- `WITH CHECK`：对将要写入的行（INSERT 的新行、UPDATE 后的行）求值，不满足即拒绝。

优化器会把策略当作过滤条件纳入计划，所以策略表达式遵循与 WHERE 相同的可走索引原则。

```text
SELECT * FROM orders
        │
        ▼
  优化器照常选计划（策略可吃 tenant_id 索引）
        │
        ▼
  逐行求值策略表达式：
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint
        │                          │
     为真 → 行可见            假/NULL → 行被丢弃
```

### 完整示例：用自定义 GUC 做多租户隔离

GUC（Grand Unified Config）是 PG 的会话配置变量机制，任意 `app.` 前缀都可以自定义，这里用它携带当前租户 ID：

```sql
-- PostgreSQL 16
CREATE TABLE orders (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL,
  memo      text,
  amount    numeric(12,2)
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON orders
  FOR ALL
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::bigint
  );
```

```sql
SET app.tenant_id = '42';            -- 任意 "app." 前缀的自定义 GUC
INSERT INTO orders (tenant_id, memo, amount) VALUES (42, 'ok', 9.9);
-- 通过：WITH CHECK 满足
INSERT INTO orders (tenant_id, memo, amount) VALUES (43, 'cross', 1.0);
-- ERROR: new row violates row-level security policy
SELECT count(*) FROM orders;          -- 只看到 tenant_id = 42 的行
-- 忘了 SET：current_setting(..., true) 返回 NULL → 所有行被过滤（fail-closed）
```

两个工程细节：

- `current_setting(name, true)` 的第二参让它"未设置时返回 NULL 而不是报错"，NULL 比较结果为假，天然 fail-closed；`NULLIF(..., '')` 再兜住被设成空串的情况。
- 连接池事务级复用（如 PgBouncer transaction pooling）下，`SET` 的值会残留在服务端连接上串到下一个用户。必须用 `SET LOCAL`，事务结束自动还原：

```sql
BEGIN;
SET LOCAL app.tenant_id = '42';
SELECT * FROM orders;
COMMIT;
```

### FORCE 与绕过者名单

默认绕过 RLS 的只有三类：超级用户、带 `BYPASSRLS` 属性的角色、以及表 owner。想让 owner 也受策略约束：

```sql
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
```

这也解释了运行/迁移账号分离的又一理由：迁移账号是 owner，本来就不该拿去跑应用；应用账号非 owner，策略对它无条件生效。

### 性能注意

- 策略要可走索引：`tenant_id = <会话值>` 可以用 `btree(tenant_id)`，与普通 WHERE 等价。
- 别把列包进函数：`lower(email) = ...` 这类写法会使普通索引失效（sargable 原则，见 [02 索引原理](./02-index.md)）。
- 策略里别嵌子查询查"当前用户是谁"：可能在部分计划下退化为逐行执行。把会话事实（租户 ID、用户 ID）放进 GUC，策略只做纯比较。
- 用 `EXPLAIN` 验证策略没有吃掉索引——策略条件会出现在执行计划的过滤条件里。

### MySQL 没有原生 RLS 的替代

MySQL 没有内置 RLS。常见两条路：

```sql
-- MySQL 8.0：按登录账号过滤的视图（利用 USER() + DEFINER 权限）
CREATE TABLE staff_tenant (mysql_user varchar(128) PRIMARY KEY, tenant_id bigint NOT NULL);
CREATE VIEW orders_v AS
SELECT o.* FROM orders o
WHERE o.tenant_id = (
  SELECT t.tenant_id FROM staff_tenant t
  WHERE t.mysql_user = SUBSTRING_INDEX(USER(), '@', 1)
);
```

这套方案能生效，靠的是 SQL SECURITY DEFINER（CREATE VIEW 的默认行为）：视图以定义者身份访问基表，调用者只需对视图有 SELECT、可不持有基表权限，基表对调用者不可见。死穴的前提也在这里：它只挡得住"只能碰视图"的账号——有基表直查权限的账号（如运维账号、或被误授权的账号）可以完全绕过这层过滤，直查基表没有任何过滤；写路径同样管不住，只能算半措施。更主流的是应用层方案：数据访问层统一强制注入租户条件（ORM hook / 查询封装），再用代码审查与集成测试兜底——本质是把 RLS 的职责搬回应用。

## SQL 注入：头号漏洞的机理与边界

### 成因时间线

```text
────────────────────────────────────────────────────────────────────
1. 开发者写模板：
   SELECT * FROM users WHERE name = '$name' AND pass = '$pass'
2. 攻击者提交：name = admin'--        （-- 是 SQL 行注释）
3. 字符串拼接后：
   SELECT * FROM users WHERE name = 'admin'--' AND pass = 'x'
4. 数据库解析：注释吞掉后半句
   ≡ SELECT * FROM users WHERE name = 'admin'
5. 结果：绕过密码校验，以 admin 身份拿到会话
────────────────────────────────────────────────────────────────────
参数化对照：
   SELECT * FROM users WHERE name = $1 AND pass = $2
   语句结构先完成解析；$1 = "admin'--" 永远只是一个字符串值
────────────────────────────────────────────────────────────────────
```

注入的本质：用户数据被送进 SQL 解析器，被当成了代码的一部分。

### 经典载荷

```sql
-- 假设应用拼接 "... WHERE name = '" + name + "'"
' OR '1'='1                    -- 恒真条件，返回全表
x' UNION SELECT table_name, 1 FROM information_schema.tables --  -- 拖库侦察
x'; DROP TABLE audit_log --     -- 多语句执行（取决于驱动是否允许多语句）
```

注意多语句是否生效由驱动/连接配置决定（如 PHP 的 multi_query、部分驱动默认单语句），不能指望它做防线。

### 参数化为什么有效

```sql
-- PostgreSQL
PREPARE get_user(text, text) AS
  SELECT id FROM users WHERE name = $1 AND pass = $2;
EXECUTE get_user('admin''--', 'whatever');
```

数据库先解析语句结构、生成执行计划，之后参数才作为纯数据进入——参数在语法树里只能落在"值"的位置，永远不会被重新解析成标识符、运算符或注释。这是结构性防御，不是转义技巧的竞赛。

### 参数化救不了的场景

占位符只能出现在"值"的位置，以下四类必须另行处理：

1. 动态表名/列名——标识符不能参数化，必须白名单映射：

```python
ALLOWED_TABLES = {"orders": "orders", "refunds": "refunds"}
table = ALLOWED_TABLES.get(user_input)
if table is None:
    raise ValueError("unknown table")
sql = f"SELECT * FROM {table} WHERE id = $1"
```

2. ORDER BY 字段与排序方向——同理白名单枚举，方向只有 ASC/DESC 两个合法值。
3. IN 列表——占位符一对一，禁止把 `",".join(ids)` 塞进一个占位符：

```python
placeholders = ",".join(["?"] * len(ids))          # 每个元素一个 ?
sql = f"SELECT * FROM orders WHERE id IN ({placeholders})"
```

4. LIKE 通配符——用户输入里的 `%`、`_`、`\` 要先转义再作为参数传入，否则用户能拿通配符做侦察：

```sql
-- PostgreSQL：应用层把 \ % _ 分别转义为 \\ \% \_ 后传入
SELECT * FROM users WHERE name LIKE $1 ESCAPE '\';
```

### ORM 的 raw 接口仍是高发区

几乎所有 ORM 都留了逃生门：Knex 的 `knex.raw`、Sequelize 的 `query/replacements`、TypeORM 的 `query()`、Prisma 的 `$queryRaw`（模板字面量形式安全，字符串拼接形式同样完蛋）。规则一条：任何拼进 SQL 的字符串片段，要么来自代码常量/白名单，要么就是漏洞预备役。代码审查时直接搜 `raw`、`query(`、字符串模板里出现 `WHERE` 的位置。

### 两个进阶概念

- 二次注入（Second-Order Injection）：写入时参数化没问题，payload 完整存在表里；之后某段"可信"代码把它读出来又拼进另一条 SQL。防线是所有出口都参数化，与入口无关。
- 宽字节注入（Wide-Byte Injection）：连接字符集为 GBK 时，转义产生的 `0x5c`（反斜杠）会与前导字节 `0xbf` 组合成合法 GBK 字符，引号提前闭合。参数化同样免疫；根因是连接字符集与转义约定不一致（见 [18 字符集与排序规则](./18-charset-collation.md)）。

## 加密的三个层次

| 层次            | 防的威胁                       | 典型实现                                   | 对查询的影响                |
|-----------------|--------------------------------|--------------------------------------------|-----------------------------|
| 传输加密        | 链路窃听、中间人篡改           | TLS（sslmode / REQUIRE SSL）               | 无                          |
| 静态加密（TDE） | 磁盘被拔、备份文件与快照外流   | MySQL keyring+表空间加密；PG 用盘加密或 pg_tde | 无（增加加解密 CPU 与密钥管理） |
| 字段级加密      | 拖库后直接可读、内部 DBA 直查  | 应用层信封加密+KMS；pgcrypto               | 等值/范围查询与排序基本失效 |

透明数据加密（Transparent Data Encryption, TDE）保护的是"离线拿到盘或备份的人"，不防通过合法连接的拖库——后者是授权层与审计层的职责，两层别混。

### 静态加密怎么做

```sql
-- MySQL 8.0：keyring 插件供密钥（生产用 keyring_hashicorp/keyring_aws；keyring_file 仅测试）
ALTER TABLE orders ENCRYPTION = 'Y';
```

PG 内核（截至 16）没有内置 TDE，常规做法是文件系统/云盘层加密（LUKS、云盘加密），或社区扩展 pg_tde（尚未进内核）。备份文件同样要加密——见 [15 备份与恢复](./15-backup-recovery.md)。

### 字段级加密：信封加密

信封加密（Envelope Encryption）：密钥管理服务（Key Management Service, KMS）里的根密钥（KEK）永不出 KMS，只负责加解"数据密钥"（DEK）；DEK 在应用内存中做真正的数据加解密。换密钥只需重包 DEK，不用重加密全量数据。

```text
            ┌────────────────┐
            │   KMS / HSM    │  根密钥 KEK 永不出 KMS
            └────────┬───────┘
          解包 / 封装 │ （只进出 DEK 的加解密请求）
            ┌────────▼───────┐
            │  DEK 数据密钥   │  明文只存在于应用内存
            └────────┬───────┘
          AES-256-GCM│
     ┌───────────────┼────────────────┐
     ▼               ▼                ▼
users.phone_ct   users.idcard_ct   orders.note_ct
（库里只存：密文 + 密钥版本号 + 查找用 HMAC 列）
```

```sql
-- PostgreSQL（pgcrypto）
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- 应用侧：KMS 解包出 DEK 后做 AES 加密
UPDATE users SET
  phone_ct  = pgp_sym_encrypt('13800000000', :dek, 'cipher-algo=aes256'),
  phone_mac = hmac('13800000000', :mac_key, 'sha256');
-- 等值查找：应用侧算同样的 HMAC，再定位密文行
SELECT id, pgp_sym_decrypt(phone_ct, :dek) FROM users
WHERE phone_mac = hmac('13800000000', :mac_key, 'sha256');
```

代价要说清：密文列做不了范围查询、排序、LIKE 前缀；HMAC 列只救回等值查找这一种。凡是"按手机号模糊搜"的需求，要么放弃加密，要么改设计（验证码流程而不是搜索）。

### 密码存储

密码必须用加盐的慢哈希：bcrypt（cost ≥ 10）或 argon2id（计算时需要大量内存，GPU 并行爆破不划算）。量级感受：快哈希 MD5/SHA1 在单张消费级 GPU 上每秒可算 10 亿次以上；bcrypt（cost=12）每秒 10 的 4 次方上下——离线爆破成本差 5 个以上数量级，这就是"绝不能存 MD5/SHA1"的全部理由。MD5/SHA1 是为快速摘要设计的，不是为密码存储设计的。PG 的 md5 认证方式同属历史遗留，换 scram-sha-256。

## 审计与敏感数据治理

```sql
-- PostgreSQL：连接审计
ALTER SYSTEM SET log_connections = on;
ALTER SYSTEM SET log_disconnections = on;
SELECT pg_reload_conf();
-- pgAudit（需在 shared_preload_libraries 预加载后重启）
ALTER ROLE auditor SET pgaudit.log = 'write, ddl, role';
```

MySQL 社区版内核没有内置审计插件：企业版有 MySQL Enterprise Audit（策略化规则、日志轮转），云 RDS 普遍提供审计日志开关（注意计费与写入开销），Percona Server 提供审计插件。`general_log` 全量记录开销大，只做临时采样排障。

敏感数据治理三步：

1. 分类：手机号、身份证、邮箱、地址、支付信息标记为 PII（Personally Identifiable Information），列出所在表与列。
2. 最小化：不收集没用途的字段；手机号能做验证就不要身份证。
3. 脱敏与保留期：给分析师的视图里打码；到期删除策略写成需求而不是口头约定。

```sql
-- PostgreSQL：脱敏视图示例
CREATE VIEW v_users_masked AS
SELECT id, regexp_replace(phone, '(\d{3})\d{4}(\d{4})', '\1****\2') AS phone
FROM users;
GRANT SELECT ON v_users_masked TO analyst_ro;
```

## 开发者清单

- 每个环境（开发/预发/生产）独立凭据，绝不复用：一处泄露等于全线失守。
- 凭据走 KMS/密管系统/环境变量注入，不进代码库与镜像：git 历史里的密钥删不干净。
- 应用只用运行账号，DDL 走迁移账号，发布窗口之外不碰：最小权限让误操作与注入的影响半径最小。
- 运行账号不给 DDL、不给 TRUNCATE、按需不给 DELETE：注入拿到也只是数据面读写。
- 所有查询参数化，包括 ORM 的 raw 接口：注入是字符串拼接的必然产物。
- 动态表名/列名/排序字段走白名单枚举：占位符不能出现在标识符位置。
- 新库上线先检查并收紧默认权限（REVOKE PUBLIC）：默认权限往往比你以为的大。
- 多租户隔离用 RLS 或等价的强制层，别依赖每处手写 WHERE：漏一处查询就是数据越权。
- 密码用 bcrypt/argon2id 加盐慢哈希：MD5/SHA1 是快哈希，存了约等于明文。
- 第三方 BI/工具的账号单独建、最小权限、定期轮换：它们凭证长期有效且常被忽略。
- 连接池事务复用下会话变量必须 SET LOCAL：SET 的残留会把租户身份串给下一个请求。

## 常见误区

- "有防火墙就不用 TLS"——内网同样存在横向移动与抓包；`sslmode=require` 不验证服务端证书，防不了主动中间人，公网至少 `verify-full`。
- "参数化了就绝对安全"——动态表名/列名、ORDER BY 方向、IN 列表、LIKE 通配符四类场景占位符无能为力，要白名单与转义。
- "ORM 天然防注入"——raw/query/whereRaw 逃生门全是拼接入口，安全与否取决于你往里塞什么。
- "开了 RLS 就万事大吉"——表 owner 默认绕过策略（要 FORCE）、超级用户永远绕过、连接池 SET 残留会串租户，三个坑各能击穿隔离。
- "MD5 加盐就安全了"——盐只防彩虹表，防不了 GPU 暴力枚举；快哈希+盐的爆破成本仍然低到可忽略。
- "做了加密就不用管权限"——TDE 不防合法连接拖库；字段加密后权限与审计照样要做，威胁模型不同。

## 自测题

1. `sslmode=require` 与 `sslmode=verify-full` 的本质差别？（答：都加密；verify-full 额外校验证书链与主机名，能防主动中间人。）
2. PG 15 为什么收回 PUBLIC 对 public schema 的 CREATE？（答：防低权限角色抢注同名对象、借 search_path 劫持他人查询实现提权。）
3. 应用运行账号为什么不给 TRUNCATE 和 DDL？（答：TRUNCATE 无法恢复、DDL 可改结构；注入或 bug 的影响半径被压到数据面。）
4. RLS 的 USING 与 WITH CHECK 各管什么？（答：USING 过滤已存在行的可见性；WITH CHECK 校验写入的新行，不满足即拒绝。）
5. 参数化为什么防注入？为什么防不了 ORDER BY？（答：结构先解析、参数只作为值；占位符不能出现在标识符位置，排序字段须白名单。）
6. IN 列表的任意长度怎么处理？（答：按元素个数生成等量占位符，超长分批，禁止拼成字符串塞一个占位符。）
7. TDE 防什么、不防什么？（答：防离线获得磁盘/备份的人；不防通过合法连接与凭据的拖库。）
8. MySQL 无原生 RLS，替代方案及其弱点？（答：视图+SUBSTRING_INDEX(USER(), '@', 1) 过滤（绕过视图直查基表即失效）；应用层强制注入租户条件（依赖代码纪律）。）

## 关联阅读

- [02 · 索引原理](./02-index.md)：策略表达式与隐式转换的"可走索引"原则。
- [12 · 连接管理与线程进程模型](./12-connection-model.md)：连接池复用与 SET LOCAL、认证握手成本。
- [15 · 备份与恢复](./15-backup-recovery.md)：备份加密与恢复演练。
- [01 · 存储引擎与数据组织](./01-storage-engine.md)：静态加密作用的数据文件层。
- [18 · 字符集与排序规则](./18-charset-collation.md)：连接字符集与宽字节注入。
