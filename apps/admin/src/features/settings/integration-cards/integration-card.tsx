'use client';

// 集成单卡（哑件）：标题左、配置按钮右上与标题对齐（用户裁决）；内容面
// 状态徽章 + 启停按钮 + 字段掩码摘要 + Turnstile 停用联动警告（DESIGN §5 D11）。

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import {
  AtSignIcon,
  CreditCardIcon,
  GitBranchIcon,
  GlobeIcon,
  Loader2Icon,
  MailIcon,
  ShieldAlertIcon,
  WalletIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';

import type { IntegrationSettingItem } from '@/server/settings-actions';
import { updateIntegrationAction } from '@/server/settings-actions';
import { IntegrationFormDialog } from './integration-form-dialog';
import { INTEGRATION_ICON, i18nKey } from './integration-format';

const ICONS: Record<string, LucideIcon> = {
  globe: GlobeIcon,
  github: GitBranchIcon,
  chrome: AtSignIcon,
  mail: MailIcon,
  shield: ShieldAlertIcon,
  wallet: WalletIcon,
  card: CreditCardIcon,
};

export function IntegrationCard({
  item,
  signupGiftOn,
}: {
  item: IntegrationSettingItem;
  /** 注册送礼开启（Turnstile 停用联动警告的数据源） */
  signupGiftOn: boolean;
}) {
  const t = useTranslations('settings.integrations');
  const tc = useTranslations('common');
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [current, setCurrent] = useState(item);
  const Icon = ICONS[INTEGRATION_ICON[current.key] ?? 'globe'] ?? GlobeIcon;

  const toggleEnabled = (): void => {
    const next = !current.enabled;
    setPending(true);
    void (async () => {
      try {
        const saved = await updateIntegrationAction(current.key, { enabled: next });
        setCurrent(saved);
        if (current.key === 'captcha.turnstile' && !next && signupGiftOn) {
          // Turnstile 加固（DESIGN §5 D11）：警告不阻断——停用已生效，风险显式留痕
          toast.warning(t('captchaWarning'));
        }
      } catch {
        toast.error(tc('actionFailed'));
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <Card className="flex w-full max-w-xl flex-col">
      <CardHeader>
        {/* 用户裁决：设置按钮放卡片右上方、与标题垂直对齐 */}
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4" /> {t(`cards.${i18nKey(current.key)}`)}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
            {t('configure')}
          </Button>
        </div>
        <CardDescription>{t(`descriptions.${i18nKey(current.key)}`)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant={current.enabled ? 'destructive' : 'default'}
            size="sm"
            disabled={pending || (!current.enabled && !current.configured)}
            onClick={toggleEnabled}
          >
            {pending && <Loader2Icon className="animate-spin" />}
            {current.enabled ? t('disable') : t('enable')}
          </Button>
          <span className="text-sm text-muted-foreground">
            <span className={current.enabled ? 'text-green-600' : ''}>
              {current.enabled ? t('enabledState') : t('disabledState')}
            </span>
            <span className="mx-1">·</span>
            <span>{current.configured ? t('configuredState') : t('unconfiguredState')}</span>
          </span>
        </div>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {Object.entries(current.config).map(([field, value]) => (
            <div key={field} className="col-span-2 flex gap-3">
              <dt className="w-32 shrink-0 truncate">{t(`fields.${field}`)}</dt>
              <dd className="truncate font-mono">{value ?? '—'}</dd>
            </div>
          ))}
        </dl>
        {current.key === 'captcha.turnstile' && current.enabled && signupGiftOn ? (
          <p className="text-xs text-amber-600">{t('captchaWarning')}</p>
        ) : null}
        {current.rotatedAt != null ? (
          <p className="text-xs text-muted-foreground">
            {t('rotatedAt', { at: current.rotatedAt })}
          </p>
        ) : null}
      </CardContent>
      <IntegrationFormDialog
        item={current}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={(saved) => setCurrent(saved)}
      />
    </Card>
  );
}
