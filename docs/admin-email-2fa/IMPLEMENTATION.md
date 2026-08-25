# 管理端邮箱 2FA 开关「邮箱码自证」施工图（IMPLEMENTATION）

- 状态：**已实施**（2026-08-25；DESIGN 见 [DESIGN.md](./DESIGN.md)）
- 门禁：每步提交前四门全绿（`bun run typecheck && bun run lint && bun run test && bun run build`），
  覆盖率只补不降；提交信息英文 Conventional Commits，正文引用 DESIGN 节号。

## 阶段 1 —— identity 邮件用途参数（纯加法）

- `packages/identity/src/ports/mailer.ts`：`sendLoginCode` opts 增
  `purpose?: 'login' | 'two_factor_toggle'`（缺省 `login`）；
- `packages/identity/src/templates/login-code-email.ts`：标题/引导句按
  purpose 分支（zh/en 双语）；
- 测试：模板两用途文案断言；缺省 purpose 行为不变（回归）。

## 阶段 2 —— admin-api 契约与路由

- `apps/admin-api/src/assembly.ts`：
  - `challengeKinds` 增 `'admin_two_factor_code'`（词表单一真相处）；
  - meRoutes 注入 postAudit（成功审计）与 dynamic mailer purpose 透传；
- `apps/admin-api/src/http/contracts/auth.ts`：
  - `twoFactor` 请求体换代 `{enabled, challengeId(uuid), code(6 位)}`；
  - 新增 `twoFactorCode`（空 body）；
- `apps/admin-api/src/http/routes/me.ts`：
  - `POST /v1/me/two-factor/code`：`identity.challenges.begin`（target
    userId 寻址、delivery ip/locale、mailer purpose two_factor_toggle）；
  - `POST /v1/me/two-factor`：`challenges.verify({..., expect:{userId}})` →
    `setTwoFactorEnabled` → postAudit `settings.two_factor`；
  - 删 `requireTotpStepup` / `mailerConfigured` 前置；
- `apps/admin-api/src/http/error-face.ts`：登记 §2.3 五码翻译
  （undeliverable/delivery_failed/cooldown/code_invalid/challenge_invalid）；
- `apps/admin-api/src/adapters/dynamic-admin-mailer.ts`：sendLoginCode
  透传 purpose；
- openapi：`http/openapi/` 增/改两端点描述 → `generate:openapi` →
  api-client `generate:dto`；
- 测试（`apps/admin-api/__test__/`）：
  - 发码：成功（challengeId 形状）/ SMTP 未生效 503 / 冷却 429（retryAfterMs）/
    投递失败 503 且挑战作废；
  - 开关：验码成功落库 + 审计行（from/to）/ 错码 remainingAttempts /
    耗尽与过期 challenge_invalid / 跨主体 expect 拒 / 旧体 `totpCode` 拒（422）；
  - 回归：stepup 集成写入端点不受影响。

## 阶段 3 —— admin 前端

- `apps/admin/src/server/auth-actions.ts`：
  - 新增 `requestTwoFactorCodeAction()` → POST code 端点；
  - `setTwoFactorAction(enabled, challengeId, code)` 变形；
- `apps/admin/src/features/settings/`：
  - 2FA 卡：启停钮不再按 `totpEnabled` 置灰（D2 取消前置）；点击先发码
    （toast 提示已发送/冷却）→ 确认弹窗（邮箱码 6 位，形态复用 stepup 弹窗
    参数化）→ 提交开关；
- `apps/admin/messages/{zh,en}.json`：新增发送成功/冷却/错码文案键；
- 测试：组件（无 TOTP 可点、发码→确认链路、错误 toast）；server actions
  形状；既有 stepup 相关用例改写。

## 阶段 4 —— 收口

- e2e 核对：`e2e/admin/` 旅程是否触及 `/v1/me/two-factor`，触及则更新；
- 全量四门 + 覆盖率数字记录于提交说明；
- DESIGN §8 验收清单逐项勾销，状态推进「已核销」。
