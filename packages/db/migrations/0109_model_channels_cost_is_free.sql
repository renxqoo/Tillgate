-- 0109: 渠道成本「免费」显式标记（用户裁决：勾选免费不清价格——价格保持继承默认，
-- 业务判定走标记；运行时目录解析把成本物化为全 0，下游敞口/结算零改动）。
ALTER TABLE "model_channels"
  ADD COLUMN "cost_is_free" boolean NOT NULL DEFAULT false;
