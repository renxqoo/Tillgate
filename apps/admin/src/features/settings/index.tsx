'use client';

// 设置页组装器（feature 出口：每张卡独立组件一文件，本文件只做编排）：
// 邮箱验证码二次登录卡（含 SMTP 配置入口）→ TOTP → 计费时区 → 集成卡区。
// 集成列表与注册送礼联动源在此统一加载（单次请求），SMTP 项注入 2FA 卡、
// 其余注入受控的 IntegrationCards（2026-08-25 收敛，DESIGN 分叉表）。

import { Card, CardContent } from '@tillgate/ui';
import { useEffect, useState } from 'react';

import type { AdminMeInfo } from '@tillgate/api-client';

import {
  getIntegrationSettingsAction,
  getMarketingSignupGiftAction,
  type IntegrationSettingItem,
} from '@/server/settings-actions';
import { BillingTimezoneCard } from './billing-timezone-card';
import { EmailTwoFactorCard } from './email-two-factor-card';
import { IntegrationCards } from './integration-cards';
import { TotpCard } from './totp-card';

export function SettingsContent({ me, error }: { me: AdminMeInfo | null; error: string | null }) {
  const [integrations, setIntegrations] = useState<IntegrationSettingItem[] | null>(null);
  const [integrationsError, setIntegrationsError] = useState(false);
  const [signupGiftOn, setSignupGiftOn] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [list, gift] = await Promise.all([
        getIntegrationSettingsAction(),
        getMarketingSignupGiftAction(),
      ]);
      if (!alive) return;
      setIntegrationsError(list.error != null);
      setIntegrations(list.integrations);
      const amount = Number(gift.signupGiftAmount ?? '0');
      setSignupGiftOn(Number.isFinite(amount) && amount > 0);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <Card className="col-span-full">
        <CardContent className="p-6 text-sm text-muted-foreground">{error}</CardContent>
      </Card>
    );
  }

  const smtp = integrations?.find((item) => item.key === 'smtp') ?? null;
  const saveSmtp = (saved: IntegrationSettingItem): void => {
    setIntegrations((prev) =>
      prev == null ? prev : prev.map((item) => (item.key === saved.key ? saved : item)),
    );
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <EmailTwoFactorCard
        me={me}
        smtp={smtp}
        smtpUnavailable={integrationsError}
        onSavedSmtp={saveSmtp}
      />

      <TotpCard totpEnabled={me?.totpEnabled ?? false} />

      <BillingTimezoneCard />
      {/* SMTP 项由 2FA 卡消费；集成卡区按词表渲染（ORDER 不含 smtp） */}
      <IntegrationCards
        items={integrations}
        error={integrationsError}
        signupGiftOn={signupGiftOn}
      />
    </div>
  );
}
