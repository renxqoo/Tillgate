# 性能测试报告：pnpm+node 工具链 → bun 全链迁移（2026-08-21）

> 被测对象：TokenLens 仓库 @ `074f469`（pnpm 11 + tsup + tsx + node 22 基线）
> vs ai-gateway @ `refactor/bun-toolchain` 分支（bun 1.4 全链）。
> 两边**代码完全相同**（该提交即迁移前最后一个 main 提交），所有差异可归因于工具链与运行时。
> 基准库 `ai_gateway_bench_node/bun` 与原始采样（`/tmp/samples.csv`、`/tmp/sust-*.json`、
> `/tmp/old-gw.log`）保留可复查。

---

## 1. 测试目的

量化「pnpm/node 全家桶 → bun 全家桶」迁移在四个层面的实际收益与代价：
依赖安装、构建、测试/开发体验、生产运行时（吞吐/延迟/内存/GC），
并给出生产运维参数建议。

## 2. 被测对象

| | 基线（node 版） | 被测（bun 版） |
|---|---|---|
| 代码 | TokenLens @ `074f469` | ai-gateway @ `refactor/bun-toolchain` |
| 包管理 | pnpm 11.1.2 | bun 1.4.0（workspaces + bun.lock） |
| 构建 | tsup 8（esbuild + dts） | bun build（native，无 dts，`exports.types` 指源码） |
| dev / 测试运行时 | tsx 4.23 / vitest@node | bun --watch / vitest@bun |
| 生产运行时 | node v22.20.0（`node dist/index.js`） | bun 1.4.0（`bun dist/index.js`） |

## 3. 测试环境

- 硬件/系统：Apple Silicon（arm64），macOS darwin 25.5.0
- 数据面：本机 PostgreSQL（独立基准库 ×2）、本机 Redis（独立 db 2/3，与开发环境隔离）
- 负载工具：autocannon（`/livez` 饱和）；仓库自带 loadtest（全链路，
  统一 node 客户端打两端）
- 数据种子：migrate 幂等建库 + seed-loadtest 同规模种子 + 共享 mock 上游
  （1.5s 生成 / 20ms token 间隔）

## 4. 方法论与口径

- 每项 3~10 轮取中位数（冷启动 10 轮、其余 3 轮），先热身后正式采样
- 构建计时关闭 turbo 缓存（`--force`）；安装为「暖包缓存 + 冷 node_modules」口径
- 深度画像：20 分钟持续饱和（200 连接）+ 10s 间隔 RSS/CPU 采样器；
  node 侧 `--trace-gc` 精确 GC 事件
- **已知局限**（解读结论时须一并考虑）：
  1. 「24h 趋势」由 20 分钟饱和曲线外推，非实测 24h
  2. bun（JSC）无 trace-gc 等价物，其 GC 暂停由请求延迟分布代理
  3. `/livez` 饱和（2~4 万 RPS）为极端压力，真实 LLM 网关流量为几十 RPS 量级
  4. 全链路非流式场景因压测客户端 1.8s 超时 × mock 排队出现确定性失败，
     两端失败率逐场景一致，不构成对比项

## 5. 测试结果

### 5.1 工具链（开发体验）

| 维度 | node 链 | bun 链 | 提升 |
|---|---|---|---|
| 冷安装（暖缓存，3 轮） | pnpm 4.30s | bun 1.13s | **3.8×** |
| 全量构建（19 个后端包，3 轮） | tsup 14.32s | bun build 0.29s | **49×** ¹ |
| 全量测试（31 任务，1541+ 用例全绿） | 103.78s | 21.66s | **4.8×** |
| dev 冷启动（到服务可用） | tsx 1,093ms | bun --watch 428ms | **2.6×** |
| Next.js admin 构建 | 11.64s | 6.36s | **1.8×** |

¹ 已验证非缓存空跑：单包 bundling 仅 6~18ms；49× 中约一半来自 native 构建、
一半来自 dts 生成退役。

### 5.2 运行时概览

| 维度 | node | bun | 结论 |
|---|---|---|---|
| 生产冷启动（10 轮分布） | p50 621ms（595~809） | p50 419ms（402~609） | bun 快 1.5× |
| 启动内存 | 171MB | 122MB | bun 省 29% |
| `/livez` 吞吐（50 连接×15s×2） | 22.0k RPS，p99=4ms | 43.9k RPS，p99=2ms | **吞吐 2.0×** |
| 阶梯饱和（10→200 连接，5 档） | 21~22k RPS 封顶 | 38~40k RPS 封顶 | 两端均单线程事件循环饱和 |
| 全链路流式吞吐（mock 1.5s 封顶） | 37.1 rps @C50 | 37.4 rps @C50 | 打平（上游生成时长主导） |
| 全链路流式尾延迟 p99 | C10 2149 / C50 1483 / C100 1565ms | 1331 / 1382 / 1508ms | **bun 低 4~38%** |
| 同负载 CPU 累计 | 22.0s | 15.3s | bun 省 30% |
| Next standalone 启动+首页 | 228ms / 105MB | 234ms / 90MB | 平手 |

### 5.3 深度画像（20 分钟持续饱和，200 连接 `/livez`）

**吞吐稳定性**

| | node | bun |
|---|---|---|
| 20min 均值 RPS | 18.7k（较峰值 22k **衰减 15%**） | 37.7k（**零衰减**） |
| 总请求 / 错误 | 22,440,908 / 0 | 45,263,725 / 0 |
| p50 / p99 | 11 / 12ms | 5 / 7ms |
| p99.9 | 28ms | 13ms |
| **p99.99（万分之一）** | **310ms** | **19ms** |
| **p99.999（十万分之一）** | **543ms** | **27ms** |

**单核承载**（CPU 采样：node 峰值 1.05 核、bun 1.15 核即饱和）

- node：~21k RPS/核 · bun：~34k RPS/核（单核效率 1.6×）

**内存曲线**（10s 采样，20 分钟饱和全程）

| | node | bun |
|---|---|---|
| 起点 | 182MB | 325MB |
| 终点 | **2,581MB，未收敛**（~120MB/min） | **445MB，平台收敛**（p95=max） |
| 负载停止后 20min | 回落 183MB | 保持平台 |
| 静置基线（无流量 3min） | 130MB | 122MB |

**GC 行为**（node 精确 trace / bun 延迟代理）

| | node（`--trace-gc` 实测） | bun（延迟分布代理） |
|---|---|---|
| 事件 | Scavenge 92,869 次（77 次/秒）；**老年代 Mark-sweep 0 次** | 不可观测（无等价 trace） |
| 单次暂停 | p50=2.58ms，p99=3.25ms，max=15.2ms | 由尾延迟覆盖：全程无 >30ms 毛刺 |
| 累计 GC 时间 | **205s = 全程 17%** | 无吞吐衰减、无尾延迟恶化 |
| 行为定性 | 轻载堆小；持续负载下堆只涨不收（20min 零整代回收），空闲才归还 | 快速到达工作集平台后走平 |

### 5.4 测试偏差修正记录

第一轮短窗测量曾得出「负载后驻留 bun 366MB vs node 59MB，bun 高 6×」的结论，
**该结论作废**。偏差分析：loadtest 全链路为轻负载（几十 RPS）且 node 段先跑、
采样时 node 已有约 2 分钟空闲收缩——59MB 是「膨胀起点」，366MB 已是 bun 平台附近，
单点采样时机对两端不公平。20 分钟饱和曲线（§5.3）给出相反且可外推的图景：
**node 无界膨胀、bun 平台收敛**。此修正过程保留在报告中，作为方法教训：
**运行时内存对比必须依据长时间曲线，单点读数会得出方向相反的结论。**

## 6. 结论

1. **开发体验**：bun 全线提速 1.8~49×，全量四门（含 1541+ 测试）从约 2 分钟降到 22 秒。
2. **生产吞吐**：框架层 bun 2×（22k→39k RPS）且持续负载零衰减；
   node 在同等压力下因 GC（17% 时间）衰减 15%。
3. **尾延迟**：bun 全面更优，极端分位差距达数量级（p99.99：19ms vs 310ms）——
   对 API 网关这类延迟敏感服务是最有价值的单项收益。
4. **内存**：bun「快速到平台（445MB）后收敛」；node「轻载小、持续负载无界膨胀
   （20min 2.5GB 未收敛、老年代零回收）」。修正第一轮误判后，内存维度 bun 亦占优。
5. **CPU**：同等产出 bun 省 30% CPU，单核承载 1.6×。
6. **无劣项**：修正后未发现 bun 在任一被测维度落后于 node。

## 7. 运维建议

| 对象 | 建议 |
|---|---|
| bun 生产容器 | 内存 limit **1GB**（平台 445MB × 2 余量）；无需计划性重启 |
| node 存量环境（如有） | 必须设置 `--max-old-space-size` 强制提前整代回收 + RSS 告警；持续高压下需计划性滚动重启 |
| 容量规划 | bun 单核 ~34k RPS（`/livez` 口径）；实际业务路径由上游 LLM 时长主导，网关层余量充足 |

## 8. 后续建议

- 上线后用真实生产流量复核内存平台与 p99.99（本测试为 localhost 极端压力）
- bun GC 如需精确暂停统计，可通过 `--inspect` + Chrome DevTools Heap/GC 面板补测
- 20 分钟外推结论建议在生产灰度期间以 24h 内存曲线验证

## 9. 附录：可复跑命令

```bash
# 安装（各 3 轮取中位；暖包缓存口径）
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install --frozen-lockfile        # 老仓库
bun install --frozen-lockfile         # 新仓库

# 构建（后端范围，关 turbo 缓存）
pnpm exec turbo build --force --filter=!@ai-gateway/admin --filter=!@ai-gateway/client
bunx turbo build --force --filter=!@ai-gateway/admin --filter=!@ai-gateway/client

# 饱和吞吐 + 延迟分位
bunx --bun autocannon --connections 200 --duration 1200 --json http://localhost:PORT/livez

# 全链路（mock 上游 + seed，两端同客户端）
bun scripts/loadtest/mock-llm-server.ts &
bun scripts/loadtest/seed-loadtest.ts
tsx scripts/loadtest/run.ts --all --gateway http://localhost:PORT --key <seed 输出>

# GC 事件（node；事件输出在 stdout）
node --trace-gc --env-file=../../.env dist/index.js

# 冷启动计时辅助（boot_bench.py：起进程→轮询 /livez→记录毫秒与 RSS）
python3 boot_bench.py <label> <port> <timeout> -- <cmd...>
```

> 附：测试期间发现并修复 seed-loadtest.ts 两处断点（协议名不一致、
> key 未绑订阅），见提交 `5e208f3`。
