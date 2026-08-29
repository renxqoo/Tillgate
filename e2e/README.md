# e2e/ —— 跨进程系统测试（非 workspace 包）

> 重构方案 §933：跨进程旅程统一在根 `e2e/`；「搬迁只搬文件与启动装置，不得借机改
> 断言语义」。gateway 波归组（MIGRATION §8）：attack/params-floor/slow/cost-drain/
> auth-audit 五件（断言语义与 v1 逐条等价）+ rxm3 真上游单列 `*.real`（§5 裁决）。
> P7 收口：v1 五个 e2e 旅程全数迁入（admin/client-journey/cross-app/billing-recovery）。

## 目录

- `gateway/kit.ts` + `gateway/upstream.ts` —— 共享装置：隔离 schema（全迁移链回放 +
  42P01 容错）+ 脚本化 mock 上游（openai-compatible 协议族，upstream.ts）+ 全真装配
  网关（真 PG/Redis/billing/inference）+ 平台 key 台账/结算驱动/对账。种子事实沿用
  v1 dev 库口径（RX-M3 → MiniMax-M3、2.1/8.4/0.42）——断言值零漂移。
- `gateway/process-smoke.test.ts` —— 双形态进程冒烟（bun 源码 / node dist 子进程：
  探针、鉴权、真请求、SIGTERM 优雅退出、对账自清）；已入默认 e2e 门。
- `gateway/attack.test.ts` —— 对抗套件 ⑤⑥⑦⑧⑨⑩（非法请求零扣费/幂等/断连/取消风暴/混合并发/n 倍数）
- `gateway/params-floor.test.ts` —— ⑬ 参数异常值全家族 + ⑭ fixed 预扣并发击穿
- `gateway/slow.test.ts` —— ⑮ 慢上游三形态（deadline 旋钮两分支 + 慢流透传计费）
- `gateway/rxm3-upstream.real.test.ts` —— 真上游 MiniMax 四场景（①流中取消 ②未返取消 ③低余额并发 ④多用户并发）
- `security/auth-audit.test.ts` —— ⑪ 认证绕过全家族 + 密钥零泄露扫描；⑫ 七表数据审计
- `security/cost-drain.test.ts` —— 刷费用专项 ①–⑦（钳制/估算/402/负余额补扣/幂等键）
- `admin/`（`journey.test.ts` + `kit.ts`）—— admin 管理面旅程（v1 四个 admin e2e 合并；
  in-process 全真装配 + 真 admin 令牌；`cd apps/admin-api && bun run test:e2e`）。
- `client-journey/`（`harness.ts` + `*.e2e.ts`）—— 用户控制台旅程（注册→资金→订阅→
  会话安全 / OAuth / 组织团队；client-api 真进程 + capture mailer；本目录 `bun x vitest run`）。
- `cross-app/`（`journey.test.ts` + `kit.ts`，P7 = v1 e2e-cross-app）—— 跨 app 生效链：
  client-api 真进程（client-journey harness）+ admin-api in-process 全真装配共库；
  重置密码全网下线 / 封禁即刻 401（两步注册经 captureMailer 抓码,真 admin 令牌）。
  本目录 `bun x vitest run`（PG/Redis 不可达整组 skip）。
- `billing-recovery/`（`journey.test.ts` + `kit.ts`，P7 = v1 e2e-worker ⑯）—— worker
  全链三环：结算环（chat → settle runner → usage_logs/钱包腿/渠道预算三处落账）、
  生成环（本地 mock MiniMax 视频上游 → 提交 201 → generation runner 轮询终态 → 结算实扣）、
  停机语义（scheduler 先证「定时器活着会消费」再 stop 证「不再消费」）。装置 = gateway
  kit 隔离 schema 世界 + `assembleWorker`（runners 直驱——认领/结算/轮询是生产函数,
  只是不经定时器）。本目录 `bun x vitest run`（PG 不可达整组 skip）。

## 运行

```bash
# 默认 e2e 门（mock 上游，全真 PG/Redis + 双形态进程冒烟）——根脚本
bun run test:e2e

# 真上游 real 门（花真钱；E2E_REAL_UPSTREAM=1 显式 opt-in，否则 skipIf 跳过）
E2E_REAL_UPSTREAM=1 bun run test:e2e:real

# 冒烟单独入口（已含在默认门）
bun run test:e2e:smoke

# admin 管理面旅程（admin-api 依赖闭包执行）
cd apps/admin-api && bun run test:e2e

# 用户/跨 app/worker 旅程（各自目录独立装置;环境不可达整组 skip）
cd e2e/client-journey && bun x vitest run
cd e2e/cross-app && bun x vitest run
cd e2e/billing-recovery && bun x vitest run
```

环境要求：`DATABASE_URL`（或 `DB_TEST_URL`）+ `REDIS_URL`。每个测试文件独占一个
隔离 schema（`tillgate_e2e_*`，结束 drop cascade）——不写共享库状态、冒烟数据自清。

### 依赖解析（e2e 非 workspace 包）

`e2e/node_modules` 是指向 `apps/gateway/node_modules` 的符号链接（git 跟踪）——
gateway 的依赖闭包覆盖 e2e 所需全部模块；vitest 从 `apps/gateway` 目录执行
（用其 vitest 版本），配置经 `-c ../../e2e/vitest.config.ts` 指向本目录。

## 本波抓出的真缺陷（e2e 价值记录）

1. **流式结构性死锁**（ai/inference 接缝）：`TransformStream` 需求耦合——relay 的
   `transform()`（first_chunk 事件源）只在客户端读响应流时执行，而 inference 的
   decisive 锚等 first_chunk 才把响应交还路由 → 两侧互等，v2 网关流式从未真正
   通过（单测都有读侧需求，只有 e2e 暴露）。修复：ai 包 chatStream 在 relay 挂好后
   合成 first_chunk（peek 已锁定上游首字节）+ 事件总线一次性事件幂等缓冲重放。
2. **tee 分支 cancel 语义**（ai 包 peek）：`tee()` 后单分支 `cancel()` 在现代运行时
   （bun 1.4 / node 22/24）不 resolve（要等两分支齐 cancel），且挂起时另一分支的
   `pipeTo` 停摆。修复：peekFirstChunk 改为原始 reader 直读 + 回放式 rest 包装
   （契约不变，零 tee）。

## 类型检查入口（`bun run typecheck:e2e`）

`tsconfig.json` 目前只覆盖 `gateway/` 套件与三个 vitest 配置——e2e 不在任何 workspace
的 typecheck 门禁内，历史积压的存量类型错误（drizzle execute 返回类型收紧、API 契约
漂移、kit 替身缺字段）需逐套件清理后才能扩围。存量待修（按错误数排序，共 ~95 个）：
`security/`(27)、`live-fire/`(~45)、`admin/`(9)、`client-journey/`(4)、
`billing-recovery/`(1)。扩围方式：把目录加进 `tsconfig.json#include` 并清零该目录错误。
