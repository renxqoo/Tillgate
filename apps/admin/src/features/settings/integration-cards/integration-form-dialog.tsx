'use client';

// 集成字段编辑弹窗（spec 驱动字段面：secret write-only——留空=保持、勾选清除提交 null；
// 启停不经弹窗——独立卡卡面启停钮触达，2026-08-25 二次裁决 SMTP 亦独立成卡后
// 本弹窗恒为纯字段编辑）。

import { Button, FieldDescription, FieldLabel, FormItem, Input } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { FormDialog } from '@/components/form-dialog';
import type { IntegrationSettingItem } from '@/server/settings-actions';
import { updateIntegrationAction } from '@/server/settings-actions';
import { buildConfigPayload, i18nKey, payloadIsEmpty } from './integration-format';

export function IntegrationFormDialog({
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  item: IntegrationSettingItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (item: IntegrationSettingItem) => void;
}) {
  const t = useTranslations('settings.integrations');
  const tc = useTranslations('common');
  const formId = `integration-form-${item.key}`;
  const fields = Object.keys(item.config);
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());

  const isSecret = (field: string): boolean =>
    item.secretsSet.includes(field) || SECRET_FIELD_NAMES.has(field);

  return (
    <FormDialog
      formId={formId}
      open={open}
      onOpenChange={onOpenChange}
      title={t(`cards.${i18nKey(item.key)}`)}
      description={t('dialogDescription')}
      submitLabel={tc('save')}
    >
      {({ run }) => (
        <form
          id={formId}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const values: Record<string, string> = {};
              for (const field of fields) values[field] = String(data.get(field) ?? '');
              const config = buildConfigPayload(fields, values, cleared);
              if (payloadIsEmpty(config)) {
                toast.info(t('nothingToSave'));
                return false;
              }
              const totpCode = String(data.get('totpCode') ?? '');
              const saved = await updateIntegrationAction(item.key, {
                totpCode,
                ...(!payloadIsEmpty(config) ? { config } : {}),
              });
              onSaved(saved);
              setCleared(new Set());
              return true;
            });
          }}
        >
          <StepupField itemId={item.key} />
          {fields.map((field) => {
            const secret = isSecret(field);
            const masked = item.config[field];
            return (
              <FormItem key={field}>
                <FieldLabel htmlFor={`integration-${item.key}-${field}`}>
                  {t(`fields.${field}`)}
                  {secret ? <span className="ml-1 text-muted-foreground">(secret)</span> : null}
                </FieldLabel>
                <Input
                  id={`integration-${item.key}-${field}`}
                  name={field}
                  type={secret ? 'password' : 'text'}
                  defaultValue=""
                  placeholder={
                    secret
                      ? masked != null
                        ? t('secretKeepHint', { masked })
                        : t('secretUnsetHint')
                      : (masked ?? '')
                  }
                  autoComplete="off"
                  maxLength={1024}
                />
                {secret && masked != null ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setCleared((prev) => {
                          const next = new Set(prev);
                          if (next.has(field)) next.delete(field);
                          else next.add(field);
                          return next;
                        });
                      }}
                    >
                      {cleared.has(field) ? t('clearSecretUndo') : t('clearSecret')}
                    </Button>
                    {cleared.has(field) ? (
                      <FieldDescription>{t('clearSecretHint')}</FieldDescription>
                    ) : null}
                  </div>
                ) : null}
              </FormItem>
            );
          })}
        </form>
      )}
    </FormDialog>
  );
}

/** secret 字段名集合（掩码回显只标已设置项；未设置的 secret 字段按规格名单标记） */
const SECRET_FIELD_NAMES = new Set(['clientSecret', 'pass', 'secretKey', 'key', 'webhookSecret']);

/** step-up 码框（ADR-0011：敏感写操作强制 TOTP——原生校验 6 位，模块级哑件拆分） */
function StepupField({ itemId }: { itemId: string }) {
  const t = useTranslations('settings.integrations');
  return (
    <FormItem>
      <FieldLabel htmlFor={`integration-stepup-${itemId}`}>{t('stepupCodeLabel')}</FieldLabel>
      <Input
        id={`integration-stepup-${itemId}`}
        name="totpCode"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder=""
        required
        pattern="\d{6}"
      />
      <FieldDescription>{t('stepupCodeHint')}</FieldDescription>
    </FormItem>
  );
}
