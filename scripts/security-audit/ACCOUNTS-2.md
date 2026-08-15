# 第二轮审查 · 测试账号与数据留档（ACCOUNTS-2）

> 按指示：**本轮所有测试数据一律不清理**，全部保留在开发库
> `postgres://postgres:postgres@localhost:5432/ai_gateway` 供人工核查。
> 密码统一见下表（均为审计专用弱强度可记密码，仅存在于此开发库）。
> 管理员沿用 seed 账号（admin@ai-gateway.local / admin12345，仅用于开通测试用户）。

## 一、脚本 18 · 零价套餐薅羊毛（R2）

| 用户 id | subject | 密码 | 结果 |
|---|---|---|---|
| 7888 | freeload-1786750253302-1-byy8 | FreeLoad123! | 订阅 2585（loadtest-plan，¥10 亿额度至 2036） |
| 7889 | freeload-1786750262333-1-mdsf | FreeLoad123! | 订阅 2586 + Key 3778（freeload-key）+ 真实 deepseek-v4-flash 调用，平台上游成本 ¥0.0001 |

## 二、脚本 19 · 认证三缺陷（R5）

| 用户 id | subject | 密码 | 场景 |
|---|---|---|---|
| 7895 | oauthlock-1786750459220-1-khjc | OAuthLock123! | R5-1：App client_id=app_038b641d15ced4dd 被 10 次错 secret 锁死，正确 secret → 429 |
| 7896 | sess-1786750459597-2-7dck | 旧 OldPass123! → 新 NewPass456! | R5-2：改密后旧会话 cookie 依旧 200 /api/me |

（R5-3 NaN→500 用管理员会话，无新建账号。）

## 三、脚本 20 · 临界值扣费（两轮，mock 上游 rede2e-boundary-*）

第一轮（2026-08-15 07:30 前后，model rede2e-boundary-5e70b543 / free=rede2e-free-5e70b543）：

| 用户 id | subject | 场景 | 结果 |
|---|---|---|---|
| 7903 | rede2e-1786750705788-1-8fwb | P0 探针 | E=A=¥0.001002，余额扣减精确 |
| 7904 | rede2e-…-2-zf7g | S1 恰好够（非流式） | settled，余额精确归 0 |
| 7905 | rede2e-…-3-tnl5 | S1b 流式 | settled，余额精确归 0 |
| 7906 | rede2e-…-4-ql2t | S2 差 1e-6 | 402，零残留 |
| 7907 | rede2e-…-5-lklr | S3 上游超发 | retry_wait→（10 次重试后）dead，余额 ¥0.001011 不变不为负 |
| 7908 | rede2e-…-6-6t1q | S4 is_free+非零价 | **R6 实锤：0 元授权 + 实扣 ¥0.001002** |
| 7909 | rede2e-…-7-vrw4 | S5 上游 500 | uncertain（保守持有，设计行为） |

第二轮（07:45 前后，model rede2e-boundary-d2adf1f2 / free=rede2e-free-d2adf1f2，密码统一 Boundary123!）：

| 用户 id | subject | 场景 | 结果 |
|---|---|---|---|
| 7912–7916 | rede2e-1786750916*-*. | P0/S1/S1b/S2/S3 | 同上全绿；S3 终态 dead |
| 7930 | （S4） | 免费（is_free+零价） | 200，0 元计费，余额 ¥1（礼金）不动 |
| 7931 | （S5） | 上游 429 → released | **R1 实时实锤：released 后 reserved_balance=0.001007 永久滞留** |

## 四、脚本 21 · 真实模型对账（密码 RealModel123!）

| 用户 id | subject | 场景 | 结果 |
|---|---|---|---|
| 7917 | real21-1786750991186-1-unby | deepseek-v4-flash 20 并发（max_tokens=16） | 20/20 成功；公式一致/余额守恒/无双扣/预占清零全绿；消费 ¥0.002346（渠道 1 上游成本同额） |
| 7918 | real21-1786750992678-2-r81u | MiniMax-M3 单次 | 200；usage in=182 cached=128 out=16；amount=¥0.00030156 = 公式精确值（缓存价 0.42 计入） |
| 7919 | real21-1786750994649-3-ncit | gpt-oss-20b（免费渠道） | 200；0 元计费，预占 0 |

渠道资金消耗（本轮合计）：deepseek 渠道（id 1）≈ ¥0.0025；minimax 渠道（id 2）≈ ¥0.0003。
未做任何充值。

## 五、红测产生的数据（ledger 集成测试，issuer=test）

- subject 前缀 `redpayg-*`（R1）、`redsub-*`（R3）、`redch-*`/`redp-*`（R4，provider/channel 同前缀）、
  `redfree-*`（R6）——集成测试 finally 自清理（遵循测试数据纪律第 7 条：测试清理只删自建数据）。
- 红测运行记录：4 文件 10 用例 = 9 红 1 绿（对照），vitest exit 1（预期）。

## 六、配置残留（保留供复核）

- providers/channels：`rede2e-prov-*`（id 2143-2146）、channel `rede2e-ch-*`（id 2561-2564，budget ¥100，
  mock 上游 127.0.0.1:9899，脚本退出后不可达——属预期留档状态）。
- model_mappings：`rede2e-boundary-*`、`rede2e-free-*`（共 4 个，含 R6 证据模型
  `rede2e-free-5e70b543`：is_free=true + 价 1/1/1 的矛盾配置样本）。
- 订阅残留：2585/2586（¥10 亿 loadtest-plan，R2 证据，勿删）。


## 七、修复验证轮（2026-08-15 晚，全部保留）

| 用户 id | subject 前缀 | 场景 | 结果 |
|---|---|---|---|
| 8387 | freeload-1786753069132 | R2 验收：零价套餐购买 | 400 PLAN_NOT_PURCHASABLE（脚本 18 exit 0） |
| 8390 | oauthlock-1786753112371 | R5-1 验收 | 10 次错 secret 后正确 secret → 200 |
| 8391 | sess-1786753112659 | R5-2 验收 | 改密后旧 cookie /api/me → 401 |
| 8397 | oauthlock-17867532* | 脚本 19 终验 | 全绿 |
| sessfix1~5 / sess-17867531* | R5-2 迭代验证 | 毫米级吊销语义调试账号（iatMs 方案定稿） |
| rede2e-1786753333463 | 脚本 20 终验 S3 | 上游超发 → 10 次重试后 dead，余额 ¥0.001011 不为负 |
| 7970+ 多个 | 脚本 20 终验 P0/S1/S1b/S2/S4/S5 | 全绿（S5=R1 实时验证：released 且 reserved=0） |

渠道资金消耗（两轮合计）：deepseek ≈¥0.005、minimax ≈¥0.0006、免费模型 0 —— 未充值。

### R5-2 会话吊销验证结论（手动全链路）
```
登录 → /api/me 200 → 修改密码 200 → 旧 cookie /api/me 401 → 新密码重登 /api/me 200
```
