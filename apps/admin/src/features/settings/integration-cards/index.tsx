'use client';

// 集成卡编排（数据加载：列表 + 注册送礼联动警告源；词表次序渲染 7 张卡）

import { Card, CardContent } from '@tillgate/ui';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  getIntegrationSettingsAction,
  getMarketingSignupGiftAction,
  type IntegrationSettingItem,
} from '@/server/settings-actions';
import { IntegrationCard } from './integration-card';
import { INTEGRATION_CARD_ORDER } from './integration-format';

export function IntegrationCards() {
  const t = useTranslations('settings.integrations');
  const [items, setItems] = useState<IntegrationSettingItem[] | null>(null);
  const [error, setError] = useState(false);
  const [signupGiftOn, setSignupGiftOn] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [list, gift] = await Promise.all([
        getIntegrationSettingsAction(),
        getMarketingSignupGiftAction(),
      ]);
      if (!alive) return;
      setError(list.error != null);
      setItems(list.integrations);
      const amount = Number(gift.signupGiftAmount ?? '0');
      setSignupGiftOn(Number.isFinite(amount) && amount > 0);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <Card className="max-w-xl">
        <CardContent className="p-6 text-sm text-muted-foreground">{t('loadFailed')}</CardContent>
      </Card>
    );
  }
  if (items == null) {
    return (
      <Card className="max-w-xl">
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
          : [<IntegrationCard key={key} item={item} signupGiftOn={signupGiftOn} />];
      })}
    </>
  );
}
