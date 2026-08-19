# @ai-gateway/domain —— 领域规则层

四层契约（service → **domain** → repository → db）的纯逻辑层。铁律由
`src/__tests__/architecture.test.ts` 机器强制：

- **零外部世界**：不 import drizzle-orm / `@ai-gateway/*` / pg / 任何 app；
  运行时依赖只有 `decimal.js` 与 `node:` 内建
- **域内只许向下引用**：`shared ← wallet ← rating ← billing / channel-budget`
  （wallet 是记账内核，rating 引它的金额值对象，用例域在上层）
- 金额一律 string 落库、Decimal 运算、账本永不 round（`wallet/money.ts` 是全系统唯一金额构造器）

## 子域

| 域 | 职责 | 关键模块 |
|---|---|---|
| `shared/` | 跨域公共语义 | 错误家谱、operationId 契约 |
| `wallet/` | 复式记账内核 | money 值对象、posting 结构校验、account 可用口径守卫、authorization 两阶段、命令指纹、白名单 |
| `rating/` | 计价工具 | pricing 双口径公式、quote 预扣推导/收据验收、coefficient 解析、amounts 结算双口径 |
| `billing/` | 计费状态机 | 8 态定义、预扣三路投影、每日限额窗口 |
| `channel-budget/` | 渠道运营资金 | 错误家谱（与用户资金永不混账） |

## 设计约定

- 全部纯函数/值对象，无状态、无 IO——可单测（`vitest`，零 DB）
- 错误全类型化分层（输入/拒绝/幂等冲突/不变量），消费方 `instanceof` 判定，不靠 message 文本
- 领域语义（复式两端平衡、两阶段冻结、守卫单语句、CAS 防双扣）是本包的物理定律；
  旧实现（packages/ledger、packages/wallet）只是参照，不是依赖
