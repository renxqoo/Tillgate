'use client';

// 集成卡编排（受控哑件：数据由组装器 ../index.tsx 统一加载注入；词表次序渲染）。
// SMTP 不渲染独立卡（挂「邮箱验证卡二次登录」卡），见 integration-format.ts。

import { Card, CardContent } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import type { IntegrationSettingItem } from '@/server/settings-actions';
import { IntegrationCard } from './integration-card';
import { INTEGRATION_CARD_ORDER } from './integration-format';

export function IntegrationCards({
  items,
  error,
  signupGiftOn,
  totpEnabled,
}: {
  /** null = 加载中（父级一次性加载列表 + 注册送礼联动源） */
  items: readonly IntegrationSettingItem[] | null;
  error: boolean;
  /** 注册送礼开启（Turnstile 停用联动警告的数据源） */
  signupGiftOn: boolean;
  /** 当前管理员已绑定验证器（ADR-0011——未绑定者敏感按钮置灰） */
  totpEnabled: boolean;
}) {
  const t = useTranslations('settings.integrations');

  if (error) {
    return (
      <Card className="col-span-full">
        <CardContent className="p-6 text-sm text-muted-foreground">{t('loadFailed')}</CardContent>
      </Card>
    );
  }
  if (items == null) {
    return (
      <Card className="col-span-full">
        <CardContent className="p-6 text-sm text-muted-foreground">{t('loading')}</CardContent>
      </Card>
    );
  }
  const byKey = new Map(items.map((item) => [item.key, item]));
  return (
    <>
      {INTEGRATION_CARD_ORDER.flatMap((key) => {
        const item = byKey.get(key);
        return item == null
          ? []
          : [
              <IntegrationCard
                key={key}
                item={item}
                signupGiftOn={signupGiftOn}
                totpEnabled={totpEnabled}
              />,
            ];
      })}
    </>
  );
}
