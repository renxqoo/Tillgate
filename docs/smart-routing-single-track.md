# 智能路由单轨化重构方案（smart-routing single-track）

状态：**实施中**（方案定稿 2026-08-31，四项用户裁决已落档）

## 1. 背景与问题

生产事故诊断（本次会话前段）确认智能路由存在「黑盒子」根因：

- **无配置 ≠ 无路由**：`routing_policies` 无行时 gateway 落到编译期
  `defaultRoutingPolicy()`（`packages/inference/src/routing/policy.ts:102`），换渠词表、
  惩罚箱、预算水位、有界等待全部以默认参数生效。策略只调参数，从不决定
  「是否启用切换」——用户不可见、不可关。
- **weight 双层断裂**：管理台渠道表单写 `channels.weight/priority`
  （`apps/admin/src/features/channels/.../channel-form.tsx`），路由实际读
  `model_channels.weight/priority`（`channel-store.ts:335-336`，无 UI 入口）→
  渠道层配置全部无效，多渠道默认 1:1 随机。
- 策略 schema 无总开关，删行也关不掉隐式默认。

## 2. 用户裁决（方向性，已确认）

| # | 裁决点 | 结论 |
| --- | --- | --- |
| D1 | 未配置智能路由时多渠道模型的行为 | **单渠道直连**：按渠道 priority/weight 确定排序取第一名，失败原样返回错误，绝不换渠道、不换候选模型 |
| D2 | 显式开/关 | **策略顶层加 `enabled` 总开关**；无行或 `enabled=false` 均为单渠道模式 |
| D3 | 关闭时保护性拒绝的表现 | **门照常拒绝，拒绝即终局**：熔断/死凭据/渠道预算闸仍拦（503），但不因此换渠道；惩罚箱/水位/sticky 等路由信号整体停用 |
| D4 | weight/priority 双层断裂 | **渠道层单轨**：路由只读 `channels.weight/priority`，`model_channels` 的 weight/priority 列迁移清退 |

## 3. DESIGN（设计基线）

### 3.1 外部契约变更

- `routingPolicySchema` 顶层新增 `enabled: boolean`（zod `default(false)`）。
  语义：`routing_policies` 无行、或行内 `enabled` 缺省/false → 单渠道直连模式。
  旧存量策略行 parse 后 `enabled=false`——按 D1/D2，这正是「删除隐式默认」的
  预期后果：存量部署需在管理页显式打开开关才恢复智能路由。
- `GET /v1/routing-policy` 未配置响应 `{unconfigured: true, policy}` 中的
  policy 恒带 `enabled` 字段；`PUT` 接受并持久化。
- `model_channels` 的 `weight`/`priority` 从 schema、admin-api 契约
  （`http/contracts/models.ts` 绑定级 weight/priority 入参）中移除，
  配套 migration DROP COLUMN。零兼容层，不做双轨读取。

### 3.2 内部问题域（处理 / 不处理）

处理：
- 单渠道模式的渠道选定与终局语义；
- 路由信号（惩罚箱、预算水位 scorer、sticky、模型死记忆、有界等待、
  换渠词表、候选模型链）统一挂接在 `enabled` 总开关之下；
- weight/priority 收口到渠道层。

不处理（归属不变）：
- 保护机制本身（熔断、死凭据、`billing.reserveChannel` 预算硬闸、
  gateway `admitChannel` RPM/TPM）：不可策略关闭，仅按 D3 终局化；
- 上游价目专项、429 Retry-After 细分：既有挂账，不属本次范围。

### 3.3 行为规格（enabled=false，单渠道直连）

1. 候选模型链截断为主模型（fallback 模型链不生效）。
2. 渠道选择：`priority` 降序 → `weight` 降序 → `channelId` 升序，取第一名。
   确定性选择，不随机。
3. 首选渠道过门（RPM/TPM、熔断/死凭据、预算硬闸）：任一拒绝 → 终局
   503 `no_available_channel`（`isChannelExhausted` 既有词表），不尝试其他渠道。
4. 惩罚门停用（penaltyEnforced=false）、不写惩罚箱；水位/sticky scorer
   不挂载；不咨询模型死记忆；有界等待不触发。
5. 上游失败按 `routeFailure` 出站（4xx 透传等既有语义），`switch_channel`
   分派在单渠道模式下落为终局：可换类错误 → `upstream_failed`（502）。

### 3.4 行为规格（enabled=true）

与现行 failover 机制一致，唯一变更：排序读取 `channels.weight/priority`。
`buildScorers`/惩罚/死记忆/等待/候选链按各自子开关继续工作。

### 3.5 性能预算

单渠道模式路径不得新增远程调用：策略为内存同步读，渠道选定纯计算，
与现路径同级。

## 4. IMPLEMENTATION（施工图）

### 4.1 逐文件改动

| 文件 | 改动 | 裁决 |
| --- | --- | --- |
| `packages/inference/src/routing/policy.ts` | 顶层 `enabled: z.boolean().default(false)`，注释更新（总开关语义） | 重构 |
| `packages/inference/src/routing/ranker.ts` | 新增 `pickPrimaryChannel`（确定性首选）；`buildScorers` 仅在 enabled 时挂载 | 重构 |
| `packages/inference/src/application/failover.ts` | runPass 入口按 `policy.enabled` 分派：候选截断、渠道首选、惩罚快照 `penaltyEnforced &&= enabled`、死记忆咨询与失败记账按 enabled、switch_channel 终局化 | 重构 |
| `packages/inference/src/application/dispatch.ts` | `recordPenalty`/`recordDeadCredential` 记账按 enabled（死凭据记账为保护面，保留——见 4.3 注） | 复制+微修 |
| `packages/db/src/schema/model-mappings.ts` + migration | DROP `model_channels.weight/priority` | 不移植（清退） |
| `packages/control-plane/src/adapters/postgres/channel-store.ts` | `findRouteCandidates` 读 `channels.weight/priority`（含 orderBy） | 重构 |
| `apps/admin-api/src/http/contracts/models.ts` + openapi | 移除绑定级 weight/priority | 复制+微修 |
| `apps/admin` routing 页 | 总开关表单项 + 关闭态禁用 scorer/resilience 卡 | 重构 |
| `apps/admin` 渠道页 | weight/priority 文案注明「智能路由排序用」 | 微修 |

### 4.2 测试计划（先红后绿）

- inference 单测：单渠道确定性选择；disabled 下熔断拒绝→503 终局；
  disabled 下上游 5xx→502 终局；disabled 下不写惩罚箱；enabled 下惩罚恢复。
- control-plane：findRouteCandidates 渠道层排序断言。
- e2e（隔离 schema 全新生效）：
  - 新增 `red-single-track.test.ts`：无策略行 + 双渠道 + 首选渠道持续 500 →
    请求失败且次渠道零流量；写入 `enabled:true` 策略后 → 换渠成功；
  - `red-channel-weight.test.ts` 转绿（channels.weight 驱动排序）；
  - `smart-routing.test.ts` 种子迁移到 channels.weight；
  - 既有 fault-matrix / stream-failover 套件在 enabled 策略种子下回归。
- 管理端：routing 页开关保存生效（本地 dev 数据验证）。

### 4.3 裁决注记

- 死凭据记账（`recordDeadCredential`）属保护面：disabled 下仍记账
  （下次请求过门直接拒绝），但拒绝后不换渠道。与 D3 一致。
- `defaultRoutingPolicy()` 保留为「未配置基线」，其语义从「隐式启用全部机制」
  变为「单渠道基线」——同一对象，含义由 `enabled=false` 承载，不再有第二套
  默认路径。

### 4.4 回滚

单 commit 语义收口；回滚 = revert 该提交 + 反向 migration
（DROP 前列值已在 channels 层有真相源，无数据迁移）。

## 5. 数据与验证

- 本地 dev 库 `tillgate_dev` 按「清空数据重新测试」授权 TRUNCATE 演示数据，
  重建种子后全链重测（管理页配置 enabled → 网关 15s 内拾取 → 换渠生效）。
- 门禁：根四门 + e2e 默认门全绿；`*.real.test.ts` 不在默认门。
