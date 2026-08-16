# 第六轮架构清偿 · 修复记录（FINDINGS-6）—— 挂账架构项 5/6 完成

> 日期：2026-08-15（第六轮）。范围：第五轮末集中提问的 6 项架构决策中可自主实施的 5 项
> （用户未逐项选择，按各问题中标注「推荐」的方向实施）；maker-checker（产品角色设计）
> 仍挂账。验收：`pnpm test --force` 14/14 包、typecheck/lint 17/17、实弹脚本
> 18/19/22/23/24/25 全部 exit 0、worker /health 令牌门实测生效。
> **本轮改动未提交**（等待用户允许）。

## 6.1 XFF 信任模型（TRUSTED_PROXY_HOPS）

- **单一实现**：`packages/http/src/network.ts trustedClientIp`——hops=0（默认）完全不信任
  XFF/X-Real-IP（直连防伪造）；hops=N 取 XFF **右数第 N 跳**（信任的第一层代理看到的
  客户端 IP）。客户端伪造首段被结构性丢弃（`fake, real` → 取 real）。
- **接线**：identity `clientIp`（client/admin 登录限流+审计）、gateway `sourceIp`
  （authfail 计数、request_logs、oauth-token）全部改走共享实现；三面 env 新增
  `TRUSTED_PROXY_HOPS`（0-10，默认 0）。
- **部署语义**：nginx 单层部署设 1；直连/dev 保持 0。`.env.example` 有说明。
- **测试**：trusted-client-ip.test 7 用例（伪造单段/多段、双层代理、条目不足回退 socket、
  进程级唯一兜底）；既有 auth-throttle-xff 用例在测试配置 hops=1 下语义保持全绿。

## 6.2 CSRF fail-closed（INTERNAL_API_TOKEN，增量收口）

- `csrfProtection` 新增 `internalToken` 选项：Origin/Referer **双缺失**时，
  - 配置了令牌 → 必须携带 `x-internal-token` 且恒定时间匹配，否则 403 `CSRF_TOKEN_REQUIRED`
    （浏览器攻击者无法获得该令牌——只存在于服务端 env，永不下发）；
  - 未配置 → 保持旧行为放行（部署兼容期，`.env.example` 标注生产必配）。
- **BFF 注入**：api-client `doFetch`（admin/client 两前端全部服务端调用）自动附加令牌；
  审计脚本 helpers 同步注入（live 服务配置令牌后脚本不失效）。
- **测试**：csrf.test 新增 4 用例（未配置放行/缺令牌 403/正确令牌放行/错误令牌 403 +
  正确 Origin 不受影响）。

## 6.3 免费模型独立日限额

- 0 元授权不计每日花费上限（amount=0）的滥用缺口：`FREE_MODEL_DAILY_LIMIT`
  （默认 500/天/用户，0=不限制）——RPM 判定前对 isFree 模型 Redis 原子 INCR+EXPIRE
  （UTC 自然日），超限 429 `free_model_daily_limit_exceeded` + retry-after 到次日 0 点；
  Redis 故障 fail-open（花费上限/授权仍兜底）。

## 6.4 加密密钥轮换重设计（双 key 窗，信封版本化）

- **信封升级**：密文格式 `enc:v1:` → `enc:v{1|2}:`。`encrypt(plain, key, version)`；
  `decrypt(packed, currentKey, oldKey?)`——v1 用 `ENCRYPTION_KEY_OLD`（未设则 v1 即当前
  key 的单 key 常态），v2 用当前 key。GCM 认证标签保证用错 key 必失败（不静默解出垃圾）。
- **接线**：gateway model-router 与 admin 渠道/模型测试路径全部双 key 解密；admin 四处
  encrypt 在 OLD 设置期间写 v2。
- **轮换脚本重写**（`scripts/rotate-encryption-key.ts`）：env 驱动（绝不打印密钥/明文）、
  事务化分批 `FOR UPDATE SKIP LOCKED`（可与业务并发）、幂等可重跑、单行失败跳过并计数；
  头部文档化四步流程（改 env → 重启开窗 → 跑脚本 → 移除 OLD 收窗）。
- **测试**：crypto.test 5 用例（单 key 往返/窗口期 v1 用 OLD、新写 v2/收窗后 v2/错误 OLD
  与篡改密文必抛）。

## 6.5 request_logs 月分区（30 天滚动，迁移 0040）

- 换表 `PARTITION BY RANGE (created_at)`：主键 (id, created_at)（分区键必须入主键）；
  FK 不保留（日志表高频写，去每行两次 FK 检查为收益）；预建 [前月, 当月, 次月] + DEFAULT
  兜底；存量 12189 行事务内拷贝换名（序列所有权交接：OWNED BY NONE → 删旧表 → OWNED BY
  新表 → setval 对齐，此坑已写入迁移文件注释）。
- **worker 维护任务**：advisory lock 防多实例并发；每小时幂等执行「确保当月/次月分区存在 +
  DETACH+DROP 结束日早于 `now() - REQUEST_LOG_RETENTION_DAYS`（默认 30）的分区」。
  stale 判定 SQL 已在库上验证（retention=13 时正确识别 2026_07，30 时不误删）。

## 完成后总账

| 第五轮挂账项 | 状态 |
|---|---|
| XFF 信任模型 | ✅ 本轮 6.1 |
| CSRF/BFF token | ✅ 本轮 6.2 |
| 免费模型滥用策略 | ✅ 本轮 6.3（目录价漂移自动处置仍属产品策略，导入侧已有 paid 化+告警） |
| 加密轮换重设计 | ✅ 本轮 6.4 |
| request_logs 分区 | ✅ 本轮 6.5 |
| maker-checker 职责分离 | ⏸ 挂账（需要角色模型与审批流的产品设计，非工程自决） |

新增运维须知（.env.example 均有注释）：nginx 部署设 `TRUSTED_PROXY_HOPS=1`；生产配
`INTERNAL_API_TOKEN`；轮换按脚本四步流程；`REQUEST_LOG_RETENTION_DAYS` 可调保留窗。
