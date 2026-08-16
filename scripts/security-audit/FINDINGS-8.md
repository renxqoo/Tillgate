# 第八轮功能交付 · 管理员邮箱验证码二次登录（FINDINGS-8）

> 日期：2026-08-15（第八轮）。需求演进：2FA → 国内习惯 → **邮箱验证码**（个人邮箱 SMTP 即可用）。
> 验收：`pnpm test --force` 14/14 包、typecheck/lint 17/17、`pnpm audit --prod` 零漏洞
> （nodemailer 钉 9.0.5 修全部 advisory）、实弹脚本 19/24 抽检绿。
> **未提交**（等待用户允许）。

## 设计（对国内习惯的取舍）

- **TOTP 不做**（国内无使用习惯）；二次因子 = 邮箱验证码（体验与短信同款，零成本）。
- **默认关闭**，管理员在「安全设置」页自助开——不强推，符合「国内少用 2FA」的现实。
- **fail-closed**：开启 2FA 后若服务端 SMTP 未配置，登录返回 503（绝不静默降级单密码）；
  开关开启动作本身也要求 SMTP 已配置。
- 发件通道任意：个人邮箱（QQ/163 开 SMTP 用**授权码**）或企业邮箱/邮件推送，纯 env 驱动。

## 实现

| 层 | 内容 |
|---|---|
| DB | 迁移 0041：`admins.two_factor_enabled`（boolean 默认 false） |
| env | `SMTP_HOST/PORT/USER/PASS/FROM`（admin-api schema；未配置 → mailer=null） |
| 服务 | `services/email.ts`：nodemailer 9.0.5 发信（6 位码 + IP 提示），`mailerFromEnv` 装配 |
| 登录 | 密码正确且 2FA 开 → 不签会话，发码返回 `challengeId`（Redis HSET：adminId + SHA-256(code) + tries，TTL 300s）；限发每管理员 60s 一条（429）；发信失败 502 并清 challenge |
| 验证 | `POST /auth/login/verify`：错 5 次作废（作废后正确码也 400）；通过才签发 admin 会话；不复核密码（challenge 已绑定密码正确这一事实） |
| 开关 | `POST /auth/two-factor {enabled}`（受保护组 + 审计）；`/api/admin/me` 回传状态 |
| 前端 | 登录页两步（密码 → 6 位码，one-time-code 自动填充语义、返回重登）；新增「安全设置」页与侧边栏入口 |
| 审计 | `auth.login.2fa_challenge / 2fa_unavailable / 2fa_send_failed / auth.two_factor.toggle`，成功登录 detail 带 `twoFactor: true` |

## 安全要点

- 验证码只存 SHA-256（明文只进邮件）；6 位 × 5 次尝试 = 爆破面 1/100000^ 次序受限且作废；
- challengeId 为 UUID 只绑定「已通过密码校验的管理员」，不可伪造身份；
- 全程复用登录限流/锁定 + 公开组 CSRF（第七轮收口）；
- SMTP 凭据只在服务端 env，出站邮件不含会话信息。

## 测试

`admin-auth.two-factor.test.ts` 3 用例：全链路（错密码 401 → challenge 无会话 → 错码×5 作废
（正确码也 400）→ 新 challenge 验码通过发会话 → 幽灵 challenge 400）；60s 限发 429；
SMTP 未配置 503 fail-closed。

## 途中事故与修复（记档）

- `__drizzle_migrations` 表残留 0040 两次失败尝试的行（表 40 行 > journal 41 条时按计数判等，
  0041 被跳过、列未落库）——修剪后从 journal 精确回填行哈希，migrate 正常执行 0041；
  **根因**：drizzle-kit 失败尝试也会留下记录行，手工补录迁移时须保证「表行数 == journal 条数」。
- nodemailer 初装 7.x 带 4 条 advisory（含 SMTP 命令注入）→ 钉 9.0.5（全修复版本），audit 回到零。
- pnpm overrides 教训同 FINDINGS-7：依赖钉精确版本。

## 使用说明（运维）

1. `.env` 配 SMTP（QQ 邮箱示例：`SMTP_HOST=smtp.qq.com`、`SMTP_PORT=465`、`SMTP_USER=xx@qq.com`、
   `SMTP_PASS=授权码`），重启 admin-api；
2. 管理员登录 → 侧边栏「安全设置」→ 开启「邮箱验证码二次登录」；
3. 下次登录：密码 → 邮箱收 6 位码（5 分钟有效）→ 验证进入。
