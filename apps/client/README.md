# @tillgate/client —— Next.js 用户控制台（BFF）

## 本地运行

```bash
bun x next dev -p 3001        # 需先起 client-api（默认 http://localhost:8081）
bun x vitest run --coverage   # 单元 + 架构门禁（含覆盖率阈值 90/85）
bun x next build              # standalone 产物
```

## 环境变量（BFF 侧）

| 变量                     | 缺省                    | 说明                                                        |
| ------------------------ | ----------------------- | ----------------------------------------------------------- |
| `CLIENT_API_BASE`        | `http://localhost:8081` | client-api 基地址（生产由部署显式注入）                     |
| `GATEWAY_BASE`           | `http://localhost:8080` | dev rewrites 兜底：操练场 4 个同域推理端点                  |
| `TRUSTED_PROXY_HOPS`     | `0`                     | 反代跳数（解出用户 IP 才回传 `x-forwarded-for`）            |
| `SESSION_TTL_SECONDS`    | `86400`                 | `ag_session` cookie 寿命                                    |
| `NEXT_PUBLIC_DISPLAY_TZ` | `Asia/Shanghai`         | 展示时区（SSR/浏览器同值；与后端 CLIENT_USAGE_TZ 同源默认） |
| `DEV_FAKE_ME`            | —                       | `=1` 且非生产时注入演示会话（离线截图/演示）                |

## 已知限制（挂账 MIGRATION §8）

- dev 无 nginx 时 `/v1/oauth/:provider/authorize` 浏览器直连不可达（生产由 nginx 分流）；
- 渲染层测试与真实链路 e2e 是独立切片（根 `e2e/client-journey`）。
