# FINDINGS-12：邮箱登录 + 强制邮箱验证码 + 防刷（C 端/管理端统一）

日期：2026-08-16　分支：feat/gateway-production-hardening

## 需求（用户原话归纳）
1. C 端和管理端必须使用邮箱登录，不能使用名称登录
2. C 端必须验证邮箱是否正常，正确后才能登录（管理端维持既有可选 2FA，先不改）
3. 需要防刷

## 变更清单（破坏性变更一次做完整）

### DB（0042_omniscient_anthem.sql）
- `users_local_email_uq` 部分唯一索引：`(email) WHERE issuer='local' AND email IS NOT NULL`
- 存量审计先行：495 个本地账号邮箱 0 重复、全小写 → 无数据治理需求
- 0042 裁掉了 journal 漂移回声（admins.two_factor_enabled / request_logs.candidates_tried 已由 0041/0039 覆盖）

### packages/identity（组件化下沉，第 2 处出现即抽取）
- `login-code.ts`：登录验证码挑战单一实现——签发（含 60s/主体发送冷却）/验证（一次性消费防重放、第 5 次错误即作废）/投递失败回滚；namespace 隔离 admin/user
- `mailer.ts`：从 admin-api/services/email.ts 下沉；品牌参数化（ADMIN_MAIL_BRAND / USER_MAIL_BRAND）；SMTP 未配置 = null = fail-closed
- 语义统一（破坏性）：旧 admin 实现第 6 次尝试才作废 → 统一为第 5 次错误即作废（与文案「错 5 次作废」一致）
- 新依赖 nodemailer；dist 重建

### apps/admin-api
- admin-auth.ts 改用 identity login-code（删内联 Redis 挑战逻辑）；services/email.ts 删除（单一真相）
- 2FA 测试适配新作废语义（4/4 绿）

### apps/client-api（核心）
- 登录标识 username → email（schema 收紧，旧字段 400）；email 小写归一后查库
- 强制两步：密码正确 → 60s 冷却 + 发码 → `/api/auth/login/verify` 验码 → 才签 ag_session
- 首登赠额 / lastLogin / JWT 全部移到验码通过后（密码正确≠登录成功）
- fail-closed：mailer=null → 503 TWO_FACTOR_UNAVAILABLE，绝不降级单密码
- services/auth.ts 新增 verifyLoginCode 组件；ClientServices 增 mailer
- core env：SMTP_* 抽为共享 schema（admin/client 两端同一套）

### apps/client（前端）
- 登录页两步流（复用管理端交互范式）：邮箱+密码 → 验证码步（6 位、错 5 次作废提示、返回重登）
- server actions：loginAction（返回 challengeId）/ verifyLoginCodeAction（落 cookie + redirect）

## 防刷层次（复用既有 + 新增）
| 攻击面 | 防护 |
|---|---|
| 密码爆破（单源） | (email, ip) 5 次/10min 硬锁（既有 login-throttle） |
| 密码爆破（分布式） | identifier-only 观测计数 + 正确密码豁免（既有） |
| 邮件轰炸 | 60s/账号发码冷却（identity login-code） |
| 验证码爆破 | 6 位 × 5 次机会 = 5/1e6，第 5 次错误即作废 |
| 验证码重放 | 验证成功一次性消费（删 challenge） |
| 账号枚举 | 恒定时间 scrypt + 统一 401 文案（既有，随 email 键迁移） |
| CSRF | 登录/验码/登出过 csrfProtection（既有） |

## 测试（TDD 红→绿）
- 新增：identity login-code 4 例 / identity mailer 3 例 / client-api auth-email-login 4 例（红→绿）
- 适配：admin 2FA（新作废语义）、client throttle/xff/csrf 三套（email + stub mailer）
- 全量：18 包测试全绿（identity 34、client-api 33、admin-api 54、gateway 128…）；typecheck 0 错；lint 17 包 0 警告

## 实测（dev 环境）
- API：email+密码 → 200 challenge；旧 username 字段 → 400
- UI（无头 Chromium）：两步流转场 ✓ 错码 toast「验证码错误」✓ 60s 冷却在真实 UI 触发「发送过于频繁」✓
- 真实 SMTP 投递：管理端同套 mailer 已由管理员实际收码验证；C 端同一实现

## 附带安全修复
- `.env.example` 注释里泄露的真实 SMTP 授权码（fgqq…）已替换为占位符——该文件会进仓库，建议用户在 QQ 邮箱后台重置该授权码（旧码视为已泄露）

## 遗留
- 管理端创建用户接口的 email 必填校验（当前可选；无邮箱账号无法登录，属账号开通流程问题，未在本轮扩大面）
- 真实邮箱端到端收码（C 端）建议用户自测一次
