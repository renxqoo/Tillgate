# U0 基座（money + fingerprint）迁移文档

> 状态：已核销（验收全过：四门 + 覆盖率 97.7/92.45/100/98.68 + B4 回归×5）
> 迁移单元：金额值对象与命令指纹——billing 全部后续单元的地基
> 旧实现：`/Users/wrr/work/ai-getway/packages/domain/src/wallet/{money,fingerprint}.ts`（62+41 行）、
> `/Users/wrr/work/ai-getway/packages/ledger-core/src/fingerprint.ts`（111 行）、
> `/Users/wrr/work/ai-getway/packages/wallet/src/{money,idempotency}.ts`（29+39 行，死码对照）
> 目标位置：`packages/billing/src/domain/{money,fingerprint}.ts`
> 关联：DESIGN §2.2/§2.3、IMPLEMENTATION §1.2 B4 / §1.4 D1/D2、ADR-0003 决策 3/4

## 1. 行为规格基线

旧测试清单（行为等价的判定标准）：

| 旧测试                                          | 用例数 | 覆盖                                                                                                                                                                                    |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/src/wallet/__tests__/money.test.ts`     | 12     | 正金额全精度、零/负/NaN/Infinity/非数值拒绝、科学计数法与超尺度拒绝、非负金额、isValidAmountString 形态、normalizeAmount 幂等去尾零、precision 40 不丢位、toStorage 科学计数法边界      |
| `ledger-core/src/__tests__/fingerprint.test.ts` | 14     | 键序无关（扁平/嵌套）、数组保序、值类型区分（7 种互异）、-0 归一、空形状、非 JSON 安全值 12 种拒绝、循环引用拒绝/共享引用可用、深度 64 界、1MB 上限、SHA-256 确定性、金额字符串携带契约 |

删除的用例及理由：

- `domain/wallet/__tests__/fingerprint.test.ts`（宽松版行为规格：undefined 丢弃、null 容忍）
  ——**删除 + 反转**：宽松语义本身是 B4 缺陷（undefined/NaN 静默吞值 = 重放顶替温床），
  新实现按严格版拒绝；原「null 容忍」保留（null 是合法 JSON 值）。
- `domain/wallet/money.test.ts` 中对 `InvalidAmountError` 类的 instanceof 断言——
  换为目录码断言（D5 收敛：`billing.invalid_amount` + reason 上下文），语义等价。

## 2. 审计结论引用

- D1/D2（IMPLEMENTATION §1.4）：两模块各存在多份拷贝，本单元完成收敛。
- B4（IMPLEMENTATION §1.2）：宽松 canonical 的 NaN→null 碰撞与 localeCompare 不稳定
  由「统一为严格版」结构性消灭，回归用例见 §5。
- B7 无关（引擎侧文案）；B5 的金额规范化依赖在本单元提供 `normalizeAmount`，
  行为锁死在 U1。

## 3. 逐模块裁决表

| 文件                                | 裁决             | 审计状态                                            | 动作                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/src/wallet/money.ts`        | 复制+微修        | 无可挑剔（审计二 §2.2：与 wallet 版核心算法逐字同） | Decimal 配置/模式/toStorage/normalizeAmount/isValidAmount/parse* 原语义保留；`InvalidAmountError` 类删除，改 `billing` 目录 `invalid_amount`（context 携 raw/reason）；垃圾串构造异常归类 malformed（B3 同型修复：Decimal 构造异常不逃逸出分类）                                                                                              |
| `ledger-core/src/fingerprint.ts`    | 复制+微修        | 严格版全测通过（审计二 §1.4）                       | canonicalJson/fingerprintOf 原算法保留（`.toSorted()` 码点序）；`InvalidInputError` 换 `DefectError`（码 `billing.fingerprint_input`——载荷构造缺陷分类，DESIGN §2.3）；新增 `commandFingerprint(kind, payload)`（语义同旧 domain 版，但底层换严格 canonical：undefined 不再丢弃而是拒绝；payload 键 `kind` 为保留轴——展开覆盖会使域隔离失效） |
| `domain/src/wallet/fingerprint.ts`  | 重写（并入上者） | B4 双缺陷                                           | `assertCommandFingerprint` 推迟 U1（随 `idempotency_conflict` 目录键与首个消费方一起落地，铁律 4）                                                                                                                                                                                                                                            |
| `wallet/src/{money,idempotency}.ts` | 不移植           | 死码（D9）                                          | —                                                                                                                                                                                                                                                                                                                                             |

## 4. API 对照

| 旧签名                                                     | 新签名                                                      | 变化理由                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| `InvalidAmountError`（自造类，raw+reason）                 | `BillingErrors.business('invalid_amount', { raw, reason })` | D5/AGENTS.md §11：业务拒绝进目录，捕获按码/分类不按类 |
| `canonicalJson` 抛 `InvalidInputError`（ledger-core 自有） | 抛 `DefectError`（`billing.fingerprint_input`）             | §11：不变量/契约破坏用根契约 Defect；细节只进日志     |
| `commandFingerprint`：undefined 静默丢弃                   | undefined 显式拒绝（Defect）                                | B4 修复：静默吞值 = 顶替重放温床                      |
| `commandFingerprint` 键序 localeCompare                    | 码点序（`.toSorted()` 默认比较）                            | B4 修复：跨环境指纹稳定                               |

## 5. 测试迁移矩阵

| 旧测试                                        | 新去处                         | 动作                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/wallet/__tests__/money.test.ts`       | `__test__/money.test.ts`       | 改写：12 用例全保留，instanceof 断言换目录码断言；新增 `raw` 为 Decimal 实例的入参分支                                                                                                                                                                                                                     |
| `ledger-core/__tests__/fingerprint.test.ts`   | `__test__/fingerprint.test.ts` | 改写：14 用例全保留，`InvalidInputError` 断言换 `DefectError`/code 断言；新增 B4 回归 ×3（见下）                                                                                                                                                                                                           |
| `domain/wallet/__tests__/fingerprint.test.ts` | —                              | 删除：宽松版规格被反转（理由见 §1）                                                                                                                                                                                                                                                                        |
| （新增）                                      | `__test__/fingerprint.test.ts` | B4 回归：① `{a:NaN}` 拒绝而 `{a:null}` 合法（宽松版两者同指纹）；② 键序码点稳定 `{a,B}` → `{"B":…,"a":…}`（localeCompare 环境下顺序相反）；③ payload 含 undefined 拒绝；④ `commandFingerprint` kind 隔离（credit/refund 同参不同 kind 不同指纹）与保留轴 `kind` 拒绝；⑤ 金额字符串携带契约（'1.00'≠'1.0'） |
| （新增）                                      | `__test__/money.test.ts`       | Decimal 实例入参；垃圾串构造异常归类 `billing.invalid_amount`（不再裸抛 decimal.js 异常）；parseNonNegativeAmount 的 malformed/out_of_scale 独立回归                                                                                                                                                       |

## 6. 回滚方案

单提交可 revert；本单元零 DDL、零调用方（新仓尚无 apps），revert 即整体还原。

## 7. 验收

- 四门全绿（typecheck/lint/test/build）+ 覆盖率 90/90/90/85。
- 行为对照清单核销：§1 两个旧测试文件的全部用例在新实现下语义等价通过；
  B4 三条回归用例通过。
