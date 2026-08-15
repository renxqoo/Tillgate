# 第三轮攻击审查 · 测试账号与数据留档（ACCOUNTS-3）

> 按指示：**本轮所有测试数据一律不清理**，全部保留在开发库
> `postgres://postgres:postgres@localhost:5432/ai_gateway` 供人工核查。
> 管理员沿用 seed 账号（admin@ai-gateway.local / admin12345，仅用于开通/设密测试用户）。
> 全部账号由 `scripts/security-audit/22-idempotency-oauth-attacks.mts` 产生。

## 一、脚本 22 第一轮（修复前复现，2026-08-15 09:18，RED）

| 用户 id | subject | 密码 | 角色 | 结果 |
|---|---|---|---|---|
| 9493 | poison-victim-1786756701254-1-p6p6 | Victim123! | T1 受害者 | 礼金键被投毒 → **登录 500 永久锁死**（¥1 礼金从未到账，余额 0） |
| 9494 | poisoner-1786756701328-2-nja5 | Poisoner123! | T1 攻击者 | 投毒购买成功（¥50→¥49，订阅 3725）；`fund_operations['signup-gift:9493']=subscription.purchase` 为永久证据 |
| 9495 | poison-victim-1786756708464-1-me3t | Victim123! | T1 受害者（第二组） | 同上：`signup-gift:9495` 被攻击者 9496 占用，登录 500 |
| 9496 | poisoner-1786756708510-2-xwb1 | Poisoner123! | T1 攻击者（第二组） | 投毒购买成功（订阅 3726） |
| 9497 | seatsreplay-1786756708972-3-d7w1 | SeatsReplay123! | T3 席位重放 | 同幂等键重放 → **第二个 org**（255+256 两个组织）+ 409 幂等失效 |

- 投毒目标套餐：plan 2759 `e2e_tiny_mstmmmojq6`（¥1 / quota ¥0.001）——测试 fixture 再生套餐。
- T4 证据：当时 1MB client_id 返回 200 并落 Redis 键 `oauth_attempts:AAA…`（修复后不复现）。

## 二、脚本 22 第二/三轮（修复后验收，2026-08-15 09:29 前后，GREEN ×2）

| 用户 id | subject | 密码 | 角色 | 结果 |
|---|---|---|---|---|
| 9911 | poison-victim-1786757373096-1-oxam | Victim123! | T1 受害者 | 投毒购买被 400 拒绝；登录 **200**，礼金 ¥1 正常到账（`signup-gift:9911=signup.gift granted`） |
| 9912 | poisoner-1786757373155-2-nnti | Poisoner123! | T1 攻击者 | 投毒键 400 `INVALID_IDEMPOTENCY_KEY`，余额 ¥50 未动 |
| 9913 | seatsreplay-1786757373637-3-w3ta | SeatsReplay123! | T3 席位重放 | 同键重放 `replayed=true`，org 数 1→1（仅 org 283） |
| 9914 | poison-victim-1786757383621-1-0lmn | Victim123! | T1 受害者（复验） | 同 9911：登录 200 + 礼金 ¥1 到账 |
| 9915 | poisoner-1786757383669-2-kruk | Poisoner123! | T1 攻击者（复验） | 400，余额 ¥50 未动 |
| 9916 | seatsreplay-1786757384081-3-zwev | SeatsReplay123! | T3 席位重放（复验） | `replayed=true`，仅 org 284 |
| 9917/9918 | （同轮附带） | — | 礼金路径 | `signup.gift granted` 正常（9917 受害者路径复验） |

- T1b：200 字符幂等键 → 400（不再 500）；T4：1MB client_id → 400，Redis 无巨型键。

## 三、数据核对口径（与库内逐项比对过）

- 受害者礼金到账：`fund_operations` 中 `signup-gift:9911/9914/9917` 均为
  `signup.gift {granted:true, amount:"1"}`；投毒轮的 `signup-gift:9493/9495` 为
  `subscription.purchase`（攻击证据，勿删）。
- 组织数：`organizations where owner_user_id in (9497,9913,9916)` → 9497 两条（255/256，缺陷
  证据）、9913/9916 各一条（283/284，修复后语义）。
- 攻击者余额：9494/9496 = ¥49（投毒成功扣款）；9912/9915 = ¥50（投毒被拒未扣款）。

> 渠道资金消耗：本轮全部走 e2e_tiny 套餐与 4xx 拒绝路径，**未触达任何真实上游、零充值**。
