# 安全审计脚本集

针对**已运行的真实服务**（gateway `:8787` / admin-api `:8790` / client-api `:8791` / worker `:8792`，真实 PostgreSQL + Redis）发真实 HTTP 请求的安全与计费回归脚本。每个脚本以 exit 0 表示通过。

> 只应打**本地/自有环境**。脚本会自建测试账号与数据且不做清理（审计留痕），不要对生产库运行。

## 运行

```bash
# 前提：四个服务已运行（bun dev），本地 PostgreSQL + Redis 已起
bun scripts/security-audit/01-login-timing-user-enumeration.mts
```

需要真实上游的脚本（06/08/21）会消耗约 ¥0.0002/次的模型调用，其余脚本不命中上游。

## 脚本清单

| 编号 | 覆盖面 |
|---|---|
| 01 | 登录时序侧信道（用户枚举）——不存在用户必须执行等量密码哈希 |
| 02 | 登录锁定 DoS——锁定不得绑 identifier-only（防任意账号锁死） |
| 03 | CSRF——状态变更接口的 Origin/Referer 校验 |
| 04 | App JWT 路径不得绕过每用户 RPM 限流 |
| 05 | 并发冒烟（容量参考，无断言缺陷） |
| 06/08 | 计费结算 / 并发计费（真实模型）：usage 归一、429 释放、无透支无重复扣费 |
| 07 | 鉴权失败路径来源级限流 |
| 09 | 计费异常人工复核链路（dead/uncertain 的 retry/resolve） |
| 10-17 | 费率卡 / 订阅生命周期与计费 / 免费套餐 / Key 日限额等资金域矩阵 |
| 18-19 | 免费套餐自助订阅 / OAuth 锁定与会话边界 |
| 20 | 临界值扣费 7 场景（余额边界，含结算重试退避等待） |
| 21 | 真实模型对账（deepseek 并发 / MiniMax / gpt-oss） |
| 22 | 幂等键攻击（命名空间投毒 / 超长键 / 席位购买幂等） |
| 23-25 | 三面接口矩阵：client-api / admin-api / gateway（无认证、错面、越权、非法输入） |

## 输出与账号

- 运行产物（FINDINGS-*.md / ACCOUNTS*.md / ENDPOINTS.md 等）仅生成于本地，已被 .gitignore 排除，勿提交。
- 测试账号密码由 `helpers.mts` 随机生成，写在本地 `ACCOUNTS*.md` 里便于排障。
