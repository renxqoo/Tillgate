# FINDINGS-11：uncertain 时效自动放行（R11-B）

> 背景（预扣问题三轮讨论的落点）：预扣金额维持最坏估算不动（credit_limit 默认 0，估少=dead 单运维负担；
> fallback 定价已覆盖最贵候选）；唯一真实缺陷是 uncertain 预占**无时间上界**——大额单可无限期压着用户可用额度等人工。
> A（在途透明化）经用户决策不做：本系统全程可追溯（billing_requests + 审计 + 复核页），口径分裂的代价可接受。
> C（信任旁路）否决：资金主路径不出现 reserved/unreserved 双分支（单一真相）；对照系 new-api（可信零预扣、
> 崩溃蒸发）与 Kortix/suna（1¢ 准入 hold、漏收自担）——两者商业模式均能覆盖漏收，本系统按量真收钱不能。

## 变更

- `packages/ledger auto-release`：小额通道之外新增**时效通道**——`uncertain 且滞留 > hours 且预扣 ≤ timeout.maxAmount`
  → 系统自动 `confirmed_no_charge`（仍走 resolveUncertain 正规命令：幂等 operationId + revision 乐观锁 + 审计）。
  两通道命中同一单只放一次（Map 去重，小额 reason 优先）；dead 永不自动处置；超过金额上限的滞留单显式留人工。
- env（无默认值，不配即关；只配其一启动即拒）：
  - `WORKER_UNCERTAIN_TIMEOUT_HOURS`（≥1 整数）
  - `WORKER_UNCERTAIN_TIMEOUT_MAX_AMOUNT`（正小数，元）
- worker 接线：双参齐备才装配通道。

## 政策语义

时效放行 = 把「无限期拖延」变成「明确的放弃时点」：超时后若上游其实服务过，损失与此前无人处理等价
（平台自担），但用户可用额度不再被无限期占压。大额（> 上限）不下放给定时器——漏收决策必须人工。

## 测试（TDD 红→绿）

- 红灯：`ledger/__tests__/billing-review-automation.test.ts` 新增时效通道用例（超时≤上限放 / 超时>上限不放 /
  未超时不放 / dead 不碰 / 不配置关闭 / 幂等 / 双命中去重）；fixture 增加 `ageHours` 回拨 updated_at。
- `core/__tests__/env-uncertain-timeout.test.ts`（3 用例）：都不配→undefined；缺一即拒；金额 0 拒 / 齐备解析正确。
- 既有小额通道用例原样通过（回归即验收）。
