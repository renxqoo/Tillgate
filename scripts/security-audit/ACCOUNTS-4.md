# 第四轮逐接口审计 · 测试账号与数据留档（ACCOUNTS-4）

> 按指示：所有测试数据一律不清理，保留在开发库
> `postgres://postgres:postgres@localhost:5432/ai_gateway` 供人工核查。
> 管理员沿用 seed（admin@ai-gateway.local / admin12345）。红测 fixture（`__c2/__c3/__c4/__w1*`
> 前缀）在测试 finally 内自清理（数据纪律：只删自建）。

## 一、脚本 23 · client-api 接口矩阵（两轮）

| 用户 id | subject 前缀 | 密码 | 角色 | 结果 |
|---|---|---|---|---|
| 9919/9921 | matrix4a-* | MatrixA123! | A（企业，¥1000） | 买席位套餐建 org（285/286）、sub 4029/4030、key 4695/4696、app 915/917；作为越权目标 |
| 9920/9922 | matrix4b-* | MatrixB123! | B（普通，¥10） | 横向越权探针全 404/403；**W1 实锤：B 用 A 的 subscriptionId 建 App 201**（app 916/918，修复后应 403） |
| — | — | — | 矩阵结论 | 首轮 9 红（含探针自身 3 处误报已修正）；修复后全绿（B 再建 → 403 SUBSCRIPTION_FORBIDDEN） |

## 二、脚本 24 · admin-api 接口矩阵

| 用户 id | subject | 密码 | 说明 |
|---|---|---|---|
| 9923 | matrix4u-1786758587573-1-k5fh | MatrixU123! | 错面探针用户（用户 cookie 打 admin 面 → 全 401） |

- N3 凭证穿越探针 6 发全拒；N2 中「坏 JSON → 500」为 W2 管理面实锤（修复后 400）。
- `/users/:id/transactions?from=notadate → 200`：from/to 为未实现过滤参数（记录为功能缺口）。

## 三、脚本 25 · gateway/内部面矩阵（全绿）

| 用户 id | subject | 密码 | 说明 |
|---|---|---|---|
| 9927 | matrix4g-1786758666026-1-h3i2 | MatrixG123! | 正常用户：key + app matrix4g-app（oauth 换 token 200 → JWT 调 /v1/models 200） |
| 9928 | matrix4h-1786758666173-2-01vy | MatrixH123! | **被禁用用户**（admin PATCH status=1）：App 换 token → 401「账户已被禁用」；静态 Key → 401（留库作禁用语义证据） |

- P1 `/debug/traces` dev 未挂载（404）；P5 trace-receiver 无认证可写（G1 记录，已加 bodyLimit）。

## 四、红测/修复验证数据

- `__w1a/__w1b/__w1plan`：W1 守卫测试（finally 自清理）。
- `__c2u/__c3u/__c3pack/__c4u/__c4plan`：C2/C3/C4 红测（自清理）。
- 迁移 0035 回填：`user_subscriptions` 过期个人订阅 16 行 status 0→1（一次性治理，不可逆留痕于迁移文件）。
- 通道唯一索引/channels_name_uq、model_channels PK：建索引前存量查重均 0 行，无需治理。

## 五、渠道资金消耗

本轮全部走 4xx/本地路径与 e2e_tiny 套餐，**未触达任何真实上游、零充值**。
