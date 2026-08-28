# 钱包透支地板管理面（debit_floor 配置能力）方案

> 状态：已核销
> 级别：中（模板 B）
> 前置事实：结算期透支语义（debit_floor 列 + 触发器 + 钳制 + wallet.setDebitFloor 动词）已随 0095 落地并有测试；本方案补**管理配置面**。

## 契约

1. **全局默认**（`system_configs` KV，键 `debit_floor_default`，值 `{"floor":"<非负金额串>"}`，缺省 `{"floor":"0"}`）：
   - `GET /v1/settings/debit-floor-default` → `{ floor: "0.5" }`
   - `PUT /v1/settings/debit-floor-default` `{ floor: "0.5" }` → `200 { floor }`（写审计）
2. **单用户手工设置**（资金面专用端点）：
   - `PUT /v1/users/:id/debit-floor` `{ floor: "5" }` → `200 { ok: true, floorAfter: "5", source: "manual" }`
   - 同事务审计 `wallet.set_debit_floor`（detail: before/after/floor）
   - 读取不新增端点：`GET /v1/users` 列表富化与用户详情携带 `debitFloor`、`debitFloorSource`
3. **存量批量刷默认**：
   - `POST /v1/wallets/debit-floor/apply-default` → `200 { applied: N, skipped: M, floor: "<当前默认>" }`
   - 语义：单条集合 `UPDATE ... SET debit_floor = 默认 WHERE kind='user' AND debit_floor_source='default' AND 贴线可满足`——手工覆盖（source='manual'）永不被批量动；贴线冲突行（余额已低于新地板+授信）跳过并计数
4. **新钱包自动套用**：`ensureUserAccount` 创建行时同事务读 KV，命中即写入 `debit_floor`（source='default'）
5. **错误形态**：floor 非法（负数/垃圾形状）→ `invalid_input`；用户不存在 → 用户域 404；降低地板致 `可用 < −(授信+新地板)` → billing 目录新码 `debit_floor_conflict`（conflict 类）
6. **副作用时序**：设置即时生效（下一请求/结算即读新值）；无事件；批量单事务。

## 问题域

- 处理：全局默认读写（审计）、新钱包套用、单用户手工覆盖（审计 + source 标记）、存量批量刷默认、管理面读取展示（列表/详情/设置页）。
- 不处理：
  - 充值分档自动授信 → 未来任务（**用户裁决**：本期全局默认值形态）
  - 用户分组维度配置 → 后续大需求（**用户裁决**明确预留）；本期以 `debit_floor_source` 词表（'default' | 'manual'，未来加 'group'）与解析顺序 manual > group(预留) > default 留位，不预建分组表
  - 结算期钳制/触发器/负余额锁死语义 → 已存在（0095），不碰
  - C 端用户自查地板 → 不暴露（运营面口径）

## 并发/一致性预算

- 新钱包套默认：每用户终身一次的额外单行 SELECT（同事务）；KV 未配置时零开销跳过
- 批量 apply：一条集合 UPDATE，行锁窗口 = 语句时长；贴线冲突行 WHERE 条件排除（不重试不阻塞）
- 手工 set 与并发结算：单行 UPDATE + deferred 触发器复检；冲突即 `debit_floor_conflict`，由管理员择机重试
- 不新增定时器/后台任务

## 拆分

- `packages/db`：迁移 **0096**——`wallet_accounts.debit_floor_source varchar(16) NOT NULL DEFAULT 'default'` + CHECK 词表；权限 `funds:floor`（透支地板管理）+ 三端点绑定（PUT /v1/users/:id/debit-floor、GET/PUT /v1/settings/debit-floor-default、POST /v1/wallets/debit-floor/apply-default）；drizzle schema 同步
- `packages/billing`：
  - 键常量 `DEBIT_FLOOR_DEFAULT_KEY` + 值解析 export（单一真相，管理面共用）
  - wallet store 工厂 opts 增 `defaultFloor?: (conn) => Promise<string | null>`；postgres 实现内置缺省（同库查 KV），内存实现测试注入
  - `setDebitFloor` 动词写 source='manual' + 贴线冲突错误目录项
  - store 增 `applyDefaultFloor(conn, {floor})`（集合 UPDATE 带 skipped 计数）；wallet api 增对应用例
- `apps/admin-api`：settings 路由两端点（本地 adapter 直读写 KV + 审计，不经 control-plane——键常量 import 自 billing，避免 control-plane↔billing 依赖问题）；users-funds 增 PUT 端点；users 读取富化 debitFloor/source；openapi registry 三处
- `packages/api-client`：regen DTO
- `apps/admin`：settings 新卡片（默认地板读写，`funds:floor` 门控）；用户详情 Funds 区显示+编辑地板；列表加列；i18n zh/en
- 依赖方向：全部既有方向内（admin-api → billing/db；billing 不依赖 control-plane）

## 实施顺序

1. 迁移 0096 + drizzle schema（验收：迁移测试计数更新、journal 登记）
2. billing 域（端口/动词/apply 用例/错误码 + 单测：默认套用、manual 标记、批量跳过 manual、贴线冲突、内存实现同步）——**先测后实现口径见测试节**
3. admin-api 三端点 + 富化 + openapi + 契约测试（权限码生效、step-up 无、审计落）
4. api-client regen + admin UI（卡片/列/编辑/i18n）
5. admin e2e 旅程（真 PG：默认→新用户套用→手工覆盖→批量不动 manual→越权 403→贴线冲突）
6. 四门 + 部署到本地栈实测
- 过渡态：无双轨（新列带缺省，旧行为 = source'default' + floor 沿用现值）

## 裁决

- **用户裁决**：作用面=单用户+全局默认+存量批量（分组为后续大需求，先留位）；自动策略=全局默认值；UI 本期含；权限=新独立权限（funds:floor）
- 默认裁决（否决窗口内可推翻）：全局默认读写**不加** TOTP step-up（比照 billing-timezone 口径，权限码即门）；批量为同步集合 UPDATE（不做异步任务）；ensureUserAccount 套默认在 billing 内置（KV 直读，键真相在 billing）

## 测试口径

- 契约：键/值形状封闭（floor 恒非负金额串）；三端点响应形状；权限绑定 = funds:floor（越权 403）；审计行存在且 detail 含 before/after
- 边界：floor "0"/"0.5"/负数/垃圾串/超大精度；用户不存在；KV 缺失（=0 不透支）；降低地板贴线冲突；批量 applied/skipped 计数
- 并发：手工 set 与结算交错 → conflict 或成功，无中间态；批量与手工并发 → manual 行不被覆盖
- 表驱动：floor 参数矩阵（合法/非法串）× 动词（set/PUT 默认）
- e2e（admin 旅程，真 PG）：设置默认→建新用户（钱包带默认）→手工覆盖→批量（manual 不动、default 刷）→无 funds:floor 角色 403
- 回归：现有 wallet/settlement 全绿不降

## 验收清单

- [x] 契约逐条（3 端点 + 富化 + KV 形状）—— GET/PUT 默认、PUT 单用户、POST 批量、列表/详情带 debitFloor/source
- [x] 边界/异常清单逐条（含贴线冲突、越权）—— 非法 floor 400、贴线冲突 409、越权经 ACL fail-closed
- [x] 并发预算逐条（套默认一次 SELECT、批量单 UPDATE、无定时器）
- [x] 四门 + admin e2e 旅程绿—— typecheck 34/34、lint 0 错、test 34 包、build 20 包；admin e2e 24/24（含 E 段地板旅程）
- [x] 部署栈实测：设默认 0.5 → 批量（负余额用户正确 skip）→ 新用户自动带 0.5
- [x] 单用户覆盖 UI（补遗）—— 详情页操作组按钮 + 列表行菜单「设置地板」弹窗（受控开合复用既有 *-user-dialog 模式）；server action 前置校验与 nonNegativeMoneyString 对齐；i18n zh/en；部署栈实测 PUT→审计→列表/详情回显 manual 来源
- [x] 分层修正（补遗）—— 全局默认 KV 下沉 control-plane settings 面（SettingsStore port + postgres 适配器 + read/update 用例 + emitAudit，与 billing_timezone 同构）；admin-api assembly 不再内联 SQL/审计，路由消费 `controlPlane.settings.debitFloorDefault`；键与值域校验单一真相仍在 billing（control-plane → billing 依赖方向）
