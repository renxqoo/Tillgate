import { Hono } from 'hono';
import type { Db } from '@ai-gateway/db';
import type { Wallet } from '@ai-gateway/wallet';
import type { Logger } from '@ai-gateway/core';
import { errorHandler, csrfProtection, type Redis } from '@ai-gateway/http';
import { bodyLimit } from 'hono/body-limit';
import { userSessionMiddleware, type Mailer, type CaptchaService, type ClientEnv } from '@ai-gateway/identity';
import type { ClientApiConfig } from './config.js';
import type { ClientServices } from './services/index.js';
import { clientAuthRoutesPublic, clientAuthRoutesProtected } from './routes/auth.js';
import { oauthRoutes } from './routes/oauth.js';
import { paymentRoutes, paymentPublicRoutes } from './routes/payments.js';
import { publicPricingRoutes, pricingRoutes } from './routes/public-pricing.js';
import { referralRoutes } from './routes/referrals.js';
import { playgroundRoutes } from './routes/playground.js';
import { inviteOverview } from './services/referrals.js';
import { createSubscriptionDomain } from '@ai-gateway/ledger/subscription';
import { createPromotions } from './services/promotions.js';
import { createPaymentServices } from './services/payments/orders.js';
import { createEpayProvider, createStripeProvider, type PaymentProvider } from './services/payments/providers.js';
import { keyRoutes } from './routes/keys.js';
import { appRoutes } from './routes/apps.js';
import { meRoutes } from './routes/me.js';
import { usageRoutes } from './routes/usage.js';
import { redeemRoutes } from './routes/redeem.js';
import { planRoutes } from './routes/plans.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { orgRoutes } from './routes/orgs.js';

/**
 * client-api 应用组装（依赖注入唯一入口）。
 *
 * 挂载结构（默认安全）：
 *   - 公开端点显式挂载（login/logout/healthz）
 *   - 其余全部挂在受保护子应用：api.use('*', userSessionMiddleware)
 *     → 新增路由默认被会话守护（fail-closed），无需逐条挂中间件
 */

export interface ClientApiDeps {
  db: Db;
  redis: Redis;
  /** 资金动作（refTypes 白名单：subscription/pack/redeem/payment/promo） */
  wallet: Wallet;
  logger: Logger;
  /** 登录验证码发信（null = SMTP 未配置 → 登录 fail-closed） */
  mailer?: Mailer | null;
  /** 注册面人机验证（null = 未配置 → 门禁关闭，生产应配置） */
  captcha?: CaptchaService | null;
  config: ClientApiConfig;
}

export function createApp(deps: ClientApiDeps): Hono {
  const services: ClientServices = {
    db: deps.db,
    redis: deps.redis,
    wallet: deps.wallet,
    subscription: createSubscriptionDomain({ db: deps.db, wallet: deps.wallet }),
    promotions: createPromotions(deps.db, deps.wallet),
    mailer: deps.mailer ?? null,
    captcha: deps.captcha ?? null,
    logger: deps.logger,
  };

  const app = new Hono();
  app.onError(errorHandler(deps.logger));
  // T5：内部面也设请求体上限（32MB，兼容兑换券图 ≤20MB）——无上限时
  // /api/auth/login 一个未鉴权大 body 即可打爆堆内存。
  app.use('*', bodyLimit({ maxSize: 32 * 1024 * 1024 }));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 公开端点（不要求用户会话）
  app.route('/api/auth', clientAuthRoutesPublic(services, deps.config));
  // OAuth 社交登录（公开组：authorize/callback 均为浏览器跳转流）
  app.route('/api/auth/oauth', oauthRoutes(services, deps.config));

  // 公开定价页（未登录可访问；官方价）
  app.route('/api/public', publicPricingRoutes(deps.db));
  // 支付公开回调（签名验证替代会话；渠道服务器直连）
  const paymentServices = createPaymentServices(deps.db, deps.wallet, buildPaymentProviders(deps.config), deps.logger);
  app.route('/api/public/payments', paymentPublicRoutes(paymentServices));

  // 受保护子应用：默认要求有效用户会话 + 状态变更 Origin 校验（CSRF 纵深防御）
  const api = new Hono<ClientEnv>();
  api.use('*', userSessionMiddleware(deps.db, deps.config.jwtSecret));
  api.use('*', csrfProtection({ trustedOrigins: deps.config.trustedOrigins, internalToken: deps.config.internalApiToken }));
  api.route('/auth', clientAuthRoutesProtected(services));
  api.route('/me', meRoutes(services));
  api.route('/keys', keyRoutes(services));
  api.route('/apps', appRoutes(services));
  api.route('/usage', usageRoutes(services));
  api.route('/redeem', redeemRoutes(services));
  api.route('/plans', planRoutes(services));
  api.route('/subscriptions', subscriptionRoutes(services));
  api.route('/orgs', orgRoutes(services));
  api.route('/payments', paymentRoutes(paymentServices));
  api.route('/pricing', pricingRoutes(deps.db));
  // Playground 操练场代理（成组配置才挂载；未配置 = 404）
  if (deps.config.playground) {
    api.route('/playground', playgroundRoutes(deps.db, deps.config.playground));
  }
  api.route('/referrals', referralRoutes((userId) =>
    inviteOverview(deps.db, deps.wallet, userId, {
      frontendUrl: deps.config.oauth.frontendUrl,
      signupBonus: deps.config.referralSignupBonus,
      commissionRate: deps.config.referralCommissionRate,
    }),
  ));
  app.route('/api', api);

  return app;
}

/** 渠道装配（config 驱动；未配置渠道不注册 → 下单 503 payment_unavailable） */
function buildPaymentProviders(config: ClientApiConfig): { epay?: PaymentProvider; stripe?: PaymentProvider } {
  const providers: { epay?: PaymentProvider; stripe?: PaymentProvider } = {};
  if (config.payments.epay) {
    providers.epay = createEpayProvider(config.payments.epay);
  }
  if (config.payments.stripe) {
    providers.stripe = createStripeProvider(config.payments.stripe);
  }
  return providers;
}
