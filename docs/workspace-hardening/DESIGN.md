# 凭证前缀、契约与可读性门禁收口设计

> 状态：已实施并通过本地全量门禁（2026-08-24）
> 范围：默认 API Key 前缀与 BFF Cookie 名、费率卡 wire 契约、嵌套三元表达式门禁。

## 1. 背景与问题

当前工作区同时存在三组跨包改动，若按文件机械收口，容易把配置迁移、契约修复与
纯可读性重构混成一笔，导致门禁变绿但行为漂移。本设计先固定每组改动的唯一语义：

1. 新部署默认虚拟 API Key 前缀从 `ag_` 改为 `sk_`；用户面与管理面 BFF Cookie
   分别从 `ag_session` / `ag_admin_session` 改为 `sk_session` /
   `sk_admin_session`。
2. `rate_cards` 已有 `updated_at`，管理端列表应返回真实更新时间，不再伪造恒 `null`。
3. 启用 `eslint/no-nested-ternary`；改写只改变表达形态，不改变求值优先级、短路、
   `null`/`undefined` 区分或 JSX 渲染结果。

## 2. 关键裁决

### 2.1 前缀与会话 Cookie

- `KEY_PREFIX` 仍是装配期单一配置；client-api 生成端与 gateway 识别端必须取同一值。
- 默认值改为 `sk_`，不接受 `ag_ | sk_` 双轨识别。存量部署若暂不切换，必须继续显式
  配置 `KEY_PREFIX=ag_`；决定切换时需重新签发 Key，并原子切换生成端与识别端。
- Cookie 常量直接改名，不读取旧 Cookie；升级后已有控制台会话失效并要求重新登录。
  这是一次显式迁移，不保留兼容层。
- 前缀校验规则不变：`^[a-z][a-z0-9_-]{1,15}$`，因此 `Sk_` 仍必须判为非法。

### 2.2 费率卡更新时间

- DB schema 的 `rate_cards.updated_at` 是事实源。
- postgres 与 memory store 均返回 `updatedAt: Date`；更新动作恒刷新该值。
- admin-api wire 字段改为非空 ISO 字符串，OpenAPI 与生成 DTO 同步。

### 2.3 金额与数值边界

- numeric/decimal 金额在 API、DTO、测试输入中保持十进制字符串，禁止为消除类型错误改成
  JS `number`。
- Drizzle 动态分组列若类型不同，使用分支内完整查询或显式公共 SQL 表达式，禁止把
  不同列强塞进由首个赋值推断出的单列类型。

### 2.4 嵌套三元门禁

- 简单二元三元表达式允许保留；只有三元内部再次出现三元时改写。
- 优先抽取命名纯函数或局部变量；JSX 多态展示优先抽取 render/helper，避免 IIFE 堆叠。
- 必须保留 `undefined`、显式 `null` 与假值的差异。例如显式
  `bearerToken: null` 表示禁用自动会话，不能用 `??` 合并回 `getToken()`。

## 3. 不在范围

- 不批量重命名历史协议、迁移文件或与凭证无关的 `tag` 标识符。
- 不调整覆盖率阈值。
- 不引入旧前缀兼容读取、双 Cookie 或自动迁移存量 API Key。

## 4. 验证策略

- 静态词表：仓库正式代码、测试、文档中不再残留旧默认前缀/Cookie 名；同时保留大小写
  非法前缀测试。
- 契约：费率卡 store/presenter/OpenAPI/DTO 对 `updatedAt` 的非空性逐层一致。
- 行为回归：会话显式 token、显式 `null`、自动 token 三态；排序/状态/错误映射等被改写
  三元表达式保持矩阵覆盖。
- 门禁：format、typecheck、lint、test、build、逐包 coverage；最后执行 CI 等价命令。
