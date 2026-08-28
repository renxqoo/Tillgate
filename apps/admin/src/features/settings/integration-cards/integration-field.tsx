'use client';

import { Button, FieldDescription, FieldLabel, FormItem, Input, PasswordInput } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import type { IntegrationSettingItem } from '@/server/settings-actions';

/** secret 字段名集合（掩码回显只标已设置项；未设置的 secret 字段按规格名单标记） */
const SECRET_FIELD_NAMES = new Set(['clientSecret', 'pass', 'secretKey', 'key', 'webhookSecret']);

/** 单个集成字段（label+控件+secret 清除行）；id 契约与 label htmlFor/测试查询对齐 */
export function IntegrationField({
  item,
  field,
  cleared,
  onToggleClear,
}: {
  item: IntegrationSettingItem;
  field: string;
  cleared: ReadonlySet<string>;
  onToggleClear: (field: string) => void;
}) {
  const t = useTranslations('settings.integrations');
  const secret = item.secretsSet.includes(field) || SECRET_FIELD_NAMES.has(field);
  const masked = item.config[field];
  const id = `integration-${item.key}-${field}`;
  return (
    <FormItem>
      <FieldLabel htmlFor={id}>
        {t(`fields.${field}`)}
        {secret ? <span className="ml-1 text-muted-foreground">(secret)</span> : null}
      </FieldLabel>
      {secret ? (
        <PasswordInput
          id={id}
          name={field}
          defaultValue=""
          placeholder={masked != null ? t('secretKeepHint', { masked }) : t('secretUnsetHint')}
          autoComplete="off"
          maxLength={1024}
        />
      ) : (
        <Input
          id={id}
          name={field}
          type="text"
          defaultValue=""
          placeholder={masked ?? ''}
          autoComplete="off"
          maxLength={1024}
        />
      )}
      {secret && masked != null ? (
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onToggleClear(field)}>
            {cleared.has(field) ? t('clearSecretUndo') : t('clearSecret')}
          </Button>
          {cleared.has(field) ? <FieldDescription>{t('clearSecretHint')}</FieldDescription> : null}
        </div>
      ) : null}
    </FormItem>
  );
}
