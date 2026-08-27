# Tillgate(TokenLens-v2)全链路红队测试与双运行时 A/B 报告

- **周期**:2026-08-26 ~ 2026-08-27
- **对象**:gateway / worker / client-api / admin-api / trace-receiver 全栈(含 Redis、SMTP、mock 多厂商上游)
- **分支**:`feat/live-fire-hardening`(node 形态)⇄ `feat/bun-native`(bun 原生形态),同机对等 A/B
- **结论一句话**:80 用例红队全绿;万级负载(10000 请求)下 **bun-native + DB 并发预算门 10000/10000 零 5xx、吞吐 189 req/s,全面优于 node 形态(9720/10000、83 req/s)**;预算门(入口排队)是两种运行时通用的正确生产架构。

---

## 1. 执行摘要

| 维度                            | 结果                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 红队用例(live-fire)             | **80/80 全绿**(双形态各自达成)                                                                                 |
| 四门(typecheck/lint/test/build) | 全绿(34 任务测试 / 20 任务构建)                                                                                |
| 真实 PG 资金套件                | **76/76**(db 6、billing 24、worker 3、observability 11、accounts 11、control-plane 9、identity 7、inference 5) |
| 双进程形态冒烟                  | bun 源码 / bun dist 双形态通过(探针+鉴权+真实计费+SIGTERM+对账)                                                |
| 200 同瞬并发                    | 池≥并发时双形态打平(735ms vs 779ms);池不足时双形态皆崩(死法不同)                                               |
| 10000 请求大规模                | **bun-native:10000/10000、189 rps、p95 8.4s、资金精确**;node:9720/10000、83 rps、p95 27s                       |
| 发现并修复缺陷                  | F-1/F-2/F-3 修复,F-6 根因定位+架构化解,F-4/F-5 定性归档                                                        |

---

## 2. 测试范围与方法

### 2.1 红队用例(live-fire,80 条)

| 组           | 数量 | 覆盖                                                                                                       |
| ------------ | ---- | ---------------------------------------------------------------------------------------------------------- |
| 冒烟         | 5    | 全栈健康、探针、鉴权链                                                                                     |
| 计费·薅羊毛  | 15   | 重复 x-request-id、低余额击穿、取消风暴、费率篡改、重放                                                    |
| 上游故障     | 14   | 429/5xx/超时/慢流/故障转移/渠道熔断/死凭据                                                                 |
| 网关鉴权     | 16   | 无效 Key、伪造前缀、哈希碰撞、限流、IP 封禁                                                                |
| 注册登录攻击 | 20   | 验证码穷举、并发消费竞态、重复注册、限流冷却                                                               |
| 超级并发     | 9    | 200 同瞬并发、50 混合并发、低余额 50 并发、取消风暴、RPM 钳制、故障转移、worker SIGKILL/停摆恢复、全库对账 |
| 毒账单回归   | 1    | F-1 闭环:FK 持续失败 → worker 存活 + 死信 + 告警入箱                                                       |

装置:真实起栈(gateway/worker/admin/client 四 app + Redis + SMTP sink + 四厂商 mock LLM),隔离端口(889x/881x),`rt-` 前缀数据每轮全清,结束后逐用户精确对账 + 全库三不变量核验。

### 2.2 大规模负载(load.ts)

- 10000 请求 = 2000 用户 × 5;curl 波次风暴(5 波 × ~2000 并发在途,macOS ulimit≈2666 为客户端天花板)
- 直接 SQL 造用户/Key(2.4s)+ 真实 admin adjust 注资;风暴后等待结算排空,然后:usage 计数、抽样 20 用户精确金额、余额=末腿 / 在途=授权和 全库核验

---

## 3. 缺陷发现与处置(F 系列)

### F-1 毒账单打崩 worker ✅ 已修

settle-failure 策略对非有限 attempt 算出 NaN 退避,`NaN × interval` 触发 PG 错误并逃逸为进程级故障。修复:非有限输入直接死信人工复核(`_invalid_attempt`/`_invalid_delay`)+ **BullMQ 结算调度重构**(jobId=requestId 去重、LISTEN/扫尾/自重试三触发源、PG 为资金与死信唯一真相、Redis 只承担触发/隔离/退避计时)。P1 用例闭环验证。

### F-2 同用户钱包串行化瓶颈 ✅ 资金层已修

单用户并发授权被 `FOR UPDATE` 串行化(每请求 ~128ms 全事务锁窗)→ 池排队 → 跨用户 500。修复(C2):单语句条件 UPDATE 原子门(credit/cash/超额三守卫域收敛于 domain),授权先插后闸保证幂等输家整体回滚,advisory lock 仅在日限额场景启用。**同用户 50 并发授权 117ms(串行基线 ~6.4s,55×)**;338 单元 + 20 real 不变量零漂移。池容量层(准入/pgbouncer)以预算门形式在本次 10k 工程中落地(见 §6)。

### F-3 request-log clone 吞请求体 ✅ 已修

中间件 `raw.clone().json()` 嗅探在 @hono/node-server 上破坏原始 body(未实现 WHATWG tee;undici 客户端 100% 触发 400)。修复:数据流反转——路由唯一解析请求体,摘要经 hono context 传递,中间件只消费;适配器无关。

### F-4 bun 兼容层高并发不可用 ✅ 定性归档

bun 运行时 + @hono/node-server + node-pg(全兼容层)200 并发 0/200:PG 连接全体 idle-in-transaction、CPU 空闲。结论:bun 作为 node 运行时不可用于高并发;后被 bun-native 形态(§5)整体取代。

### F-5 undici × node 网关窗口性池死锁 🟡 归档(相关家族)

node 网关在特定客户端窗口下 pg-pool 95 个 acquire 永不 settle。已排除平凡解释(DNS/fd/线程池/mock/泄漏/中间件二分)。10k 无门负载下 node 同族塌陷(520/10000、22 rps)进一步佐证:pg-pool 检出队列本身扛不住突发。缓解:入口预算门(已落地)/pgbouncer。

### F-6 Bun SQL 检出排队楔死 ✅ 根因定位 + 架构化解

- **症状**:并发 > 池 max 触发检出排队后,在途事务全体停在「下一条语句发出前」(PG 侧 idle-in-transaction,网关 CPU 0%),30s idleTimeout 收割转 500。
- **实证**(阈值扫描):20 并发全过 / 40 并发(池40)全灭 / 60 并发恰好灭 40 过 20 —— **失败数精确 = 池连接数**。
- **归因**:Bun SQL 池「检出排队」路径丢失在途查询响应唤醒,[bun#38163](https://github.com/oven-sh/bun/issues/38163) / [bun#38231](https://github.com/oven-sh/bun/issues/38231) 家族(上游 open)。
- **排除矩阵**:bun fetch 客户端(curl 同结果)、prepare true/false、池 8/20/40/64、fire-and-forget 日志、ioredis 内联、bun 1.4.0/canary 1.4.1、src/dist 形态、单进程迷你网关(含真实 wallet.authorize 链 60 并发)全部排除/通过。
- **化解**:池 ≥ 并发可避(200 并发@池210:200/200@779ms);万级正确解为预算门(§6)。

### 观察项(挂账)

- O-1:空 completion 结算口径不一致(记账语义裁决待定)
- O-2:`responseModelRewrite` 缺省关闭(策略裁决待定)

---

## 4. 修复的连带工程问题

- **admin-api 500 审计写入**:live-fire 环境重建后暴露的链路问题已随 schema 修复闭环
- **Bun SQL 语义适配**(bun-native 分支):SQLSTATE 在 `errno`(pg 在 `code`)——db 包错误分类双字段探测,收敛订阅单活索引等三处本地副本;**jsonb 双重编码**(drizzle#5139/bun#28219)——schema 25 列换 customType 对象透传;numeric 零吐裸 `'0'`(数值等价,断言 Decimal 化);`prepare:false` 会把对象参数 String 化(已回滚,不用该开关)
- **测试基建**:vitest 全仓切 bun 运行时(`bun x --bun vitest`);zod v4 命名空间再导出在 vite-node 转换下丢失——200 文件 `import { z }` → `import * as z`;JSC Intl(¥、日期 `at` 分隔符)成为单形态真相

---

## 5. bun-native 全栈迁移(feat/bun-native 分支)

| 层          | node 形态            | bun-native 形态                                                       |
| ----------- | -------------------- | --------------------------------------------------------------------- |
| DB 驱动     | node-pg + drizzle    | **Bun SQL + drizzle-orm/bun-sql**                                     |
| HTTP        | @hono/node-server    | **Bun.serve**(serveApp 单一来源 ×4 app,env.server 注入取 socket 对端) |
| worker 唤醒 | pg Client 事件机     | **sql.listen/unlisten**(Bun 内建断线重连+重订阅)                      |
| 会话锁      | 池客户端 advisory    | **withSessionTryLock**(reserve 专用连接,db 包助手)                    |
| 构建/启动   | `node dist/index.js` | `bun dist/index.js`                                                   |

验证:四门全绿;76 个 real 资金测试全绿;双进程形态冒烟通过;live-fire 80/80。

---

## 6. 双运行时 A/B(同机、同负载、同用例、同参数)

### 6.1 200 同瞬并发(X11)

| 配置            | node                       | bun-native         |
| --------------- | -------------------------- | ------------------ |
| 池 40(同日对等) | 8~25/200(pg-pool 建连超时) | 0/200(F-6 楔死)    |
| 池 210(≥并发)   | **200/200 @735ms**         | **200/200 @779ms** |
| 历史参考        | 静默宿主窗口 200/200@604ms | —                  |

### 6.2 10000 请求大规模负载

| 指标            | node 池210 无门              | node + 预算门                          | **bun-native + 预算门**                                |
| --------------- | ---------------------------- | -------------------------------------- | ------------------------------------------------------ |
| 成功            | 520/10000 ❌                 | 9720/10000                             | **10000/10000** ✅                                     |
| 吞吐            | 22 req/s                     | 83 req/s                               | **189 req/s**                                          |
| p50 / p95 / max | — / 65s / 65s                | 9.7s / 27s / 36s                       | **5.4s / 8.4s / 11s**                                  |
| 拒绝构成        | 500×7686、503×288、断连×1501 | 503×275(结算积压闸尾波正确触发)、409×5 | **零**                                                 |
| 结算排空        | —                            | 20s                                    | 30s                                                    |
| usage 行        | 520/10000                    | 9720/9720                              | **10000/10000**                                        |
| 资金核验        | —                            | 抽样精确全等;余额/在途零漂移           | **抽样精确全等(0.001554=5×0.0003108);余额/在途零漂移** |

### 6.3 DB 并发预算门(本次落地的架构结论)

**万级并发下,任何运行时的池检出队列都扛不住突发**(node 塌陷吞吐 / Bun SQL 楔死在途事务——两者是同一架构缺陷的不同死法)。正解:

```
入口预算门(gateway db-budget 中间件)
  ├─ 业务并发 ≤ 池容量 − 余量(178 = 210 − 32;余量给 fire-and-forget 日志与旁路)
  ├─ 超发请求进程内 FIFO 排队(事件循环健康等待,不占连接、不吃池超时)
  ├─ 探针(/healthz /livez /readyz)旁路——风暴期间 LB 探活不被排队
  └─ 队列溢出 / 等待超时 → fail-closed 503(客户端重试)
```

两分支同代码落地(`apps/gateway/src/http/middleware/db-budget.ts`);预算门之后比的是纯运行时效率,bun-native 原生 HTTP(无 node-server 模拟层)、原生 socket、JSC 单核在网关 CPU 密集链路上占优 → 吞吐 2.3×、尾延迟 3×。

### 6.4 「bun 曾落后」的三段解释

1. F-4 时期测的是 **bun 跑 node 栈**(全兼容层),非 bun-native;
2. bun-native 初期的 77/80 是真 bug(F-6)+ 不对等对照(node 的 604ms 战绩出自静默宿主;同日对等复测 node@池40 同样 8~25/200);
3. 调试期环境噪音(僵尸网关占端口、prepare:false 误伤、切分支 dist 残留)造成过多次假性落后。

---

## 7. 环境与数据变更清单

| 项                             | 变更                  | 说明                                                                                                                 |
| ------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PG `max_connections`           | 100 → 400             | 本机 homebrew PG,重启一次,数据无损;支撑池 210                                                                        |
| live-fire mock 端口            | 8790-8793 → 8890-8893 | 用户另一项目(agent-work)占用 879x                                                                                    |
| dev 库(tillgate-v5)schema      | 整库重建              | 原库处于半重置不一致态(迁移日志 91 条全在但业务表缺失);容忍式重放 91 个迁移 450 语句 0 失败;原数据经核实全为测试残渣 |
| `integration_settings.smtp`    | 重建                  | live-fire 会临时换 sink 并还原;如需原 163.com 配置请重填                                                             |
| gateway `DB_POOL_MAX` 校验上限 | 100 → 300             | 默认值不变                                                                                                           |
| 网关池等待耐心                 | 5s → 60s              | 预算门排队路径所需                                                                                                   |

---

## 8. 复现指南

```bash
# 双分支切换注意:dist 不进 git,切分支后必须重建
git checkout <branch> && bun install && bun run build --force && cd apps/gateway && rm -rf dist && bun run build && cd ../..

# 80 用例红队(任一分支)
DATABASE_URL=... REDIS_URL=... bun e2e/live-fire/run.ts

# 万级负载(任一分支;参数:总数 用户数 波宽)
DATABASE_URL=... REDIS_URL=... bun e2e/live-fire/load.ts 10000 2000 2000

# 真实 PG 资金套件(以 billing 为例)
cd packages/billing && DATABASE_URL=... bun run test:real

# 残留进程清理(网关楔死时优雅停机不完成,会留僵尸)
for port in 8810 8811 8812 8813 8814 2525 8890 8891 8892 8893; do
  for p in $(lsof -t -i tcp:$port); do kill -9 $p; done
done
```

---

## 9. 遗留与建议

1. **上游跟踪**:向 oven-sh/bun 报 F-6(检出排队楔死,触发条件与排除矩阵见 §3;`bun e2e/live-fire/load.ts` 在池<并发时可稳定复现);关注 #38163/#38231 修复后回归验证,届时预算门保留(它本身是正确架构)但可放松池尺寸耦合。
2. **连接预算**:若单机并发继续上行(>2000 在途),评估 pgbouncer(注意 Bun SQL 预编译语句与事务池模式兼容性)或多副本横向扩。
3. **F-5**:node 形态历史挂账;若最终选定 bun-native 可降级为参考记录。
4. **O-1/O-2**:结算空回执口径、responseModelRewrite 缺省,待产品裁决。
5. **形态决策建议**:未上线窗口内,**以 `feat/bun-native` 为候选主形态**(正确性/安全/并发全面达标且万级占优),`feat/live-fire-hardening` 保留为可回退对照。

---

_报告数据全部出自本次会话实测,原始日志见 `e2e/live-fire/logs/`(运行产物,不入库)与 `e2e/live-fire/FINDINGS.md`(过程档案)。_
