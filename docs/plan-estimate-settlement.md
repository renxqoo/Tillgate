# 估算结算政策（2026-08-17 拍板留档）

## 背景与动机

- **前提**：所有上游厂商均无 usage 补录接口——「缺 usage → 冻结等厂商回执」没有回执可等。
- **旧口径（G1）**：估算值绝不进资金结算。缺可信 usage 一律转 `uncertain` 冻结，等人工复核。
- **实践证伪**：人工复核期望价值≈0（uncertain 单长期积压无人处置≈漏收）；上游真实计费、
  平台垫付成本。核心动机是**防刷**：「生成完掐线」「制造缺 usage」等薅法在旧口径下零成本。
- **实发案例**：trace `9bdf8df12c5633d6`（MiniMax 流式正常完成缺 usage，用户中途手动取消，
  终止帧后断开被 #6649 归为完成）→ uncertain 冻结 ¥0.31，上游已生成 token 未收。

## 政策矩阵（唯一真相）

| 场景 | 判定信号 | 资金行为 |
|---|---|---|
| 正常完成，有 usage | `usage.estimated=false` | 按真实结算（不变） |
| 正常完成，缺 usage（流式） | terminated=undefined + usage=null | **估算结算**：input 估算 + bytesRelayed × tokensPerByte |
| 正常完成，缺 usage（非流式） | usage=null | **估算结算**：estimateUsage(请求体, 响应体) |
| 用户取消（已识别） | terminated ∈ {client_disconnect, request_cancelled, aborted} | 估算结算（不变） |
| 上游服务端异常 | terminated ∈ {upstream_*, inactivity} | **释放不扣**（用户未获完整服务） |
| 未交付失败 / server_draining / 网关崩溃 | upstreamCharge=unknown / drain / 租约过期 | **释放不扣** |
| dead（不变量破坏/毒收据/信用触底） | failure_class=permanent | **人工复核**（唯一保留队列） |

拍板原则：宁可漏收不误收（用户侧异常不扣）；已交付内容必须收（防刷）。

## 实现落点

- `packages/ledger/src/types.ts`：`ESTIMATE_ATTRIBUTIONS`（用户取消三态 + `usage_missing_completed`
  / `usage_missing_nonstream`）；`isAttributedEstimate`/`validateReceipt` 用新枚举把关。
- `packages/ledger/src/billing-flow.ts`：signal `request.failed` 的 `upstreamCharge='unknown'`
  不再转 uncertain——统一释放（字段保留仅作观测）。
- `packages/ledger/src/billing-processor.ts`：recoverOnce 的 in_flight 租约过期（网关崩溃）
  → released（`gateway_crash_released` 留痕），同事务释放三类预扣投影。
- auto-release 通道整体删除（uncertain 不再产生；dead 永不自动处置）。
- `apps/gateway` 收尾三分岔：`recordEstimatedOutcome`（估算结算，billing.estimate span）、
  `recordReleasedFailure`（释放不扣，billing.finalize=released）、`recordSuccess`。
- `TpmReservation` 删 `retained()`（未交付失败统一释放 TPM）。
- 留痕三处可交叉核对：trace（billing.estimate + relay 终止细节 doneSentinel/terminalFrame）、
  `billing_requests`（failure_code + 收据）、`usage_logs`（estimated + **estimate_reason 新列**）。
- 展示口径：**仅管理端透出**（GET /api/admin/usage-logs + 用量明细页「估算」标与 reason 提示）；
  用户端不透出估算标记（拍板：2026-08-17）。

## 存量收敛（一次性，已执行后移除脚本）

治理脚本（git 历史可查）处置 14 张 uncertain 单：投影匹配的 9 张走当时的
`resolveUncertain` 正规命令（审计留痕 actor=system），投影已被测试清理归零的 5 张
标记 `governance_residue_released`（行置 released 后 Σ活跃账单与 users.reserved_balance
两侧归零，对账恢复平衡）。处置完成后 uncertain 状态从代码库整体删除：
signal 处理器、状态机枚举、DB CHECK 约束（迁移 0050）、复核命令与 admin 端点、
库存/健康字段、auto-release——全链路无运行时分支。

## 防刷终检

| 薅法 | 结果 |
|---|---|
| 生成完掐线（取消） | 估算扣——堵死 |
| 制造「缺 usage」拿便宜 | 估算价=校准中位数，双向误差不可系统性套利 |
| 制造上游故障拿免费内容 | 上游 5xx/截断不可主动触发；内容残缺 |
| 刷超时未交付 / drain / 崩溃 | 零所得或不可操纵 |

开放面：上游故障中断时已交付字节不收（拍板接受的例外，额度受上游故障率约束）。

## 护栏测试

- `apps/gateway/src/routes/__tests__/estimate-settlement.policy.test.ts`（政策三特征）
- `tpm-reservation.characterization.test.ts`（TPM 所有权，含 unknown→释放语义）
- ledger 侧：signal/recoverOnce 翻转后的既有套件
