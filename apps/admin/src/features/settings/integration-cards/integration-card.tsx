'use client';

// 集成单卡（哑件）：标题左、配置按钮右上与标题对齐；内容面
// 状态徽章 + 启停按钮 + Turnstile 停用联动警告。
// 卡面不显示配置字段值（与 2FA/TOTP 卡同形态，配置收进弹窗）。
// 无 settings:integrations 权限：配置/启停操作位隐藏，保留状态只读展示
// （权限判定权威在 admin-api ACL）。

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import {
  AtSignIcon,
  CreditCardIcon,
  GitBranchIcon,
  GlobeIcon,
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
import { ToggleRow } from './toggle-row';
import { CodeConfirmDialog } from '../code-confirm-dialog';

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
  totpEnabled,
  canManage,
}: {
  item: IntegrationSettingItem;
  /** 注册送礼开启（Turnstile 停用联动警告的数据源） */
  signupGiftOn: boolean;
  /** 当前管理员已绑定验证器（未绑定者敏感按钮置灰引导绑定） */
  totpEnabled: boolean;
  /** settings:integrations 持有者可见配置/启停操作位（隐藏时保留状态只读展示） */
  canManage: boolean;
}) {
  const t = useTranslations('settings.integrations');
  const ts = useTranslations('settings');
  const tc = useTranslations('common');
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [stepupOpen, setStepupOpen] = useState(false);
  const [current, setCurrent] = useState(item);
  const Icon = ICONS[INTEGRATION_ICON[current.key] ?? 'globe'] ?? GlobeIcon;

  const toggleEnabled = (totpCode: string): void => {
    const next = !current.enabled;
    setPending(true);
    void (async () => {
      try {
        const res = await updateIntegrationAction(current.key, { totpCode, enabled: next });
        // 失败经 action 翻译成 error 字段（Server Action 抛错会被 Next 脱敏弹错）
        if (res.error != null || res.item == null) {
          toast.error(res.error ?? tc('actionFailed'));
          return;
        }
        setCurrent(res.item);
        // 确认成功即关弹窗（失败保持开——可换码重试）
        setStepupOpen(false);
        if (current.key === 'captcha.turnstile' && !next && signupGiftOn) {
          // Turnstile 加固：警告不阻断——停用已生效，风险显式留痕
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
    <Card className="flex h-full w-full flex-col">
      <CardHeader>
        {/* 设置按钮放卡片右上方、与标题垂直对齐 */}
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4" /> {t(`cards.${i18nKey(current.key)}`)}
          </CardTitle>
          {canManage ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!totpEnabled}
              title={totpEnabled ? undefined : ts('stepupRequired')}
              onClick={() => setDialogOpen(true)}
            >
              {t('configure')}
            </Button>
          ) : null}
        </div>
        <CardDescription>{t(`descriptions.${i18nKey(current.key)}`)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <ToggleRow
          enabled={current.enabled}
          configured={current.configured}
          pending={pending}
          totpEnabled={totpEnabled}
          stepupTitle={totpEnabled ? undefined : ts('stepupRequired')}
          onRequestToggle={() => setStepupOpen(true)}
          canManage={canManage}
        />
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
      <CodeConfirmDialog
        open={stepupOpen}
        onOpenChange={setStepupOpen}
        title={`${current.enabled ? t('disable') : t('enable')} — ${t(`cards.${i18nKey(current.key)}`)}`}
        onConfirm={(code) => toggleEnabled(code)}
      />
    </Card>
  );
}
