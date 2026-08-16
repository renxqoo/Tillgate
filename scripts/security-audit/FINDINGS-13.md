# FINDINGS-13：C 端邮箱自助注册

日期：2026-08-16　分支：feat/gateway-production-hardening　前置：FINDINGS-12（邮箱登录+验证码）

## 需求
C 端支持邮箱注册（此前登录页文案「请联系管理员创建」——无自助入口）。

## 设计（复用 R12 的验证码挑战，一套实现两种场景）

两步注册，邮箱真实性在建号**之前**保证：

```
POST /api/auth/register {email, password}
  → IP 限流(5/小时) → 邮箱占用检查(409) → SMTP fail-closed(503)
  → 密码 scrypt 哈希算好，连同验证码哈希存入挑战（Redis 不落明文）
  → 发码（60s 冷却/邮箱）→ {challengeId}

POST /api/auth/register/verify {challengeId, code}
  → 验码（错 5 次作废、一次性消费）
  → 建号（subject=email, displayName=邮箱本地部分）
  → 并发撞邮箱：users_local_email_uq 唯一索引兜底 → 23505 → 409
  → 自动登录：赠额（幂等）+ lastLogin + ag_session
```

### 关键取舍
- **不在 Redis 存密码明文**：注册第一步就算好 scrypt 哈希存挑战，验证通过直接用于建号。
- **不加「待验证」用户状态**：账号只在验码通过后才存在，users.status 语义不变（删除优于兼容——不引入半激活状态和它的全部分支）。
- **identity login-code 扩展 extra 字段**：挑战可携带附加键值（验证成功原样返回），登录场景不带、注册场景带 passwordHash——仍是单一挑战实现。

## 防刷层次
| 攻击面 | 防护 |
|---|---|
| 批量刷号（单 IP） | register:req:{ip} 计数，5 次/小时 → 429 REGISTER_RATE_LIMITED |
| 邮件轰炸 | 60s 冷却/邮箱（identity login-code 既有） |
| 验证码爆破/重放 | 6 位 × 5 次 + 一次性消费（既有） |
| 并发注册同一邮箱 | DB 部分唯一索引 users_local_email_uq → 409（结构上不可能重复建号） |
| 弱口令 | schema 层 min 8 / max 128 |
| CSRF | 公开组既有 csrfProtection 覆盖新端点 |

## 变更清单
- packages/identity：login-code `extra` 参数 + 验证返回 `data`（测试 +1，5/5）；dist 重建
- apps/client-api：services/auth.ts 新增 register/verifyRegistration + issueSession 共享助手（登录/注册共用赠额+lastLogin+JWT 段）；routes/auth.ts 挂 /register + /register/verify
- apps/client：/register 页面（两步表单，与登录页同范式）+ 登录页「立即注册」入口 + registerAction/registerVerifyAction
- 文档：api-contract §4.1、requirements 功能表、TEST-COVERAGE

## 验证（四关）
- 测试：identity 35、client-api 35（新增 auth-register 2 例红→绿）、admin-api 54、gateway 128…18 包全绿
- typecheck / lint：0 错 0 警告
- dev 实测：API（占用 409 语义由 vitest 覆盖；200 challenge、弱密码 400 实测）+ 无头 UI（注册两步转场、密码不一致校验、登录页入口）
- 真实收码建号建议用户自测一次（邮箱收到码 → 输入 → 直接进 dashboard，余额含 ¥1 赠额）
