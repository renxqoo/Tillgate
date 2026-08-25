'use client';

// 设置页组装器（feature 出口：每张卡独立组件一文件，本文件只做编排）：
// 邮箱验证码二次登录卡（纯个人自助）→ TOTP → 计费时区 → 集成卡区
// （SMTP 独立卡在卡区，2026-08-25 二次裁决——系统级配置与个人自助分离）。
// 集成列表与注册送礼联动源在此统一加载（单次请求），整表注入 IntegrationCards。
// 按钮级权限（2026-08-25 用户裁决 D1）：页级 server 端算好布尔下传——
// settings:update → 时区可写；settings:integrations → 集成卡区操作位；
// TOTP/2FA 启停属 SELF 域不挂码。显隐仅 UX，权威判定在 admin-api ACL。

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

export function SettingsContent({
  me,
  error,
  canUpdateTimezone,
  canManageIntegrations,
}: {
  me: AdminMeInfo | null;
  error: string | null;
  /** settings:update 持有者可写计费时区；否则只读展示当前值 */
  canUpdateTimezone: boolean;
  /** settings:integrations 持有者可见集成/SMTP 配置与启停操作位 */
  canManageIntegrations: boolean;
}) {
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

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <EmailTwoFactorCard me={me} />

      <TotpCard totpEnabled={me?.totpEnabled ?? false} />

      <BillingTimezoneCard canUpdate={canUpdateTimezone} />
      {/* 集成卡区按词表渲染（ORDER 含 smtp——独立卡，2026-08-25 二次裁决） */}
      <IntegrationCards
        items={integrations}
        error={integrationsError}
        signupGiftOn={signupGiftOn}
        totpEnabled={me?.totpEnabled === true}
        canManage={canManageIntegrations}
      />
    </div>
  );
}
