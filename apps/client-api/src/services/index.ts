import type { Db } from '@ai-gateway/db';
import type { Wallet } from '@ai-gateway/wallet';
import type { SubscriptionDomain } from '@ai-gateway/ledger/subscription';
import type { Logger } from '@ai-gateway/core';
import type { Redis } from '@ai-gateway/http';
import type { CaptchaService, Mailer } from '@ai-gateway/identity';
import type { Promotions } from './promotions.js';

/**
 * client-api 服务依赖集合（依赖注入的唯一入口；S7 重写：资金事实在 wallet，
 * 订阅成域，营销/兑换/支付为 app 自有状态机 + wallet 动词）。
 * 路由/服务只接收本对象，不直读 process.env / 全局单例。
 */
export interface ClientServices {
  db: Db;
  redis: Redis;
  /** 资金动作（refTypes 白名单：subscription/pack/redeem/payment/promo） */
  wallet: Wallet;
  subscription: SubscriptionDomain;
  /** 注册赠额/邀请奖励（worker 佣金同款实现） */
  promotions: Promotions;
  logger: Logger;
  /** 登录验证码发信；null = SMTP 未配置 → 登录 fail-closed 503 */
  mailer: Mailer | null;
  /** 注册面人机验证（Turnstile）；null = 未配置 → 门禁关闭（部署兼容期，生产应配置） */
  captcha: CaptchaService | null;
}
