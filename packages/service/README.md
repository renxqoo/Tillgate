# @ai-gateway/service —— 用例层

四层契约（service → domain → repository → db）的用例编排层：组合纯规则（`@ai-gateway/domain`）
与全部 SQL（`@ai-gateway/repository`），持有事务边界。铁律由
`src/__tests__/architecture.test.ts` 机器强制：

- **零 SQL**：源码禁 import drizzle-orm / pg；Db 与 DbTx 类型经 repository 再导出获取
- **依赖箭头唯一**：外部只依赖 `@ai-gateway/domain` 与 `@ai-gateway/repository`
- **包内单向**：billing → wallet 允许（预扣走钱包动词）；wallet / channel-budget / shared 互不引用、不上行

## 上下文（三生命周期法则）

- 进程级（db / guards / clock / repos）→ 装配注入 env，工厂闭包捕获
- 请求级（requestId / actor / traceParent）→ `RunContext`，用例第一参数
- 事务级（tx）→ `inTx(ctx, tx)` 派生 `RepoContext` 传给仓储；跨用例共享事务由 `input.tx` 注入
  （wallet 幂等三段式的「唯一冲突兜底重放」需要在池连接上重读——事务所有权双轨是刻意设计）

## 子域

| 域 | 职责 |
|---|---|
| `wallet/` | 八动词：credit / authorize / settle / release / transfer / setCreditLimit / accounts / statement |
| `billing/` | authorize 预扣管线（七步事务）、signal 四事件（8 态状态机网关侧）、reserveChannel 渠道敞口 |
| `channel-budget/` | 结算收尾：敞口释放 + 成本扣减熔断（运营资金自治域） |
| `shared/` | 幂等操作（operationId 占位 → 执行 → 回执存档/重放） |

## 测试

- `src/__tests__/` 集成测试跑真实 PostgreSQL（`DATABASE_URL`，缺省
  `postgres://postgres:postgres@localhost:5432/ai_gateway`）
- 数据纪律：每套件独立测试前缀 + 独立用户；wallet 腿/交易 append-only 留档（DB 触发器禁删）
