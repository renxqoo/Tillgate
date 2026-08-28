'use client';

// 集成字段编辑弹窗（spec 驱动字段面：secret write-only——留空=保持、勾选清除提交 null；
// 启停不经弹窗——独立卡卡面启停钮触达，SMTP 独立成卡后本弹窗恒为纯字段编辑）。
// 布局：字段按集成登记分行（相关字段同排、端口列收窄），连接测试紧随字段面，
// step-up 确认区以分隔线贴近保存动作——避免全宽单列长表单。

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { FormDialog } from '@/components/form-dialog';
import { useActionResult } from '@/components/action-toast';
import type { IntegrationSettingItem } from '@/server/settings-actions';
import { testIntegrationAction, updateIntegrationAction } from '@/server/settings-actions';
import { buildConfigPayload, i18nKey, payloadIsEmpty } from './integration-format';
import { IntegrationField } from './integration-field';
import { SmtpTestField } from './smtp-test-field';
import { StepupField } from './stepup-field';

/**
 * 弹窗字段分行登记（键=集成 key，行序=域内 specs 字段序）：相关字段同排两列等分。
 * 未登记的集成/字段回退整行单列——新增集成不阻塞配置。
 */
const FIELD_ROWS: Record<string, readonly (readonly string[])[]> = {
  'oauth.github': [['clientId', 'clientSecret']],
  'oauth.google': [['clientId', 'clientSecret']],
  smtp: [['host', 'port'], ['user', 'pass'], ['from']],
  'captcha.turnstile': [['siteKey', 'secretKey'], ['verifyUrl']],
  'payment.epay': [['pid', 'key'], ['gatewayUrl'], ['notifyUrl', 'returnUrl'], ['payType']],
  'payment.stripe': [['secretKey', 'webhookSecret'], ['successUrl', 'cancelUrl'], ['apiBase']],
};

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
  const notify = useActionResult();
  const formId = `integration-form-${item.key}`;
  const fields = Object.keys(item.config);
  const rows = fieldRows(item.key, fields);
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [testing, setTesting] = useState(false);

  const toggleCleared = (field: string): void => {
    setCleared((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  // SMTP 连接测试：测当前填写值（留空回退已保存值），不提交表单、不走 step-up
  const runTest = async (form: HTMLFormElement): Promise<void> => {
    const data = new FormData(form);
    const values: Record<string, string> = {};
    for (const field of fields) values[field] = String(data.get(field) ?? '');
    const config = buildConfigPayload(fields, values, cleared);
    setTesting(true);
    try {
      const res = await testIntegrationAction(item.key, payloadIsEmpty(config) ? {} : { config });
      if (res.error != null) {
        toast.error(t('testFailed'), { description: res.error });
        return;
      }
      if (res.result == null) return;
      if (res.result.ok) {
        toast.success(t('testSuccess', { ms: res.result.durationMs }));
        return;
      }
      toast.error(t('testFailed'), { description: res.result.error?.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <FormDialog
      formId={formId}
      open={open}
      onOpenChange={onOpenChange}
      title={t(`cards.${i18nKey(item.key)}`)}
      description={t('dialogDescription')}
      submitLabel={tc('save')}
      contentClassName="sm:max-w-lg"
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
              const res = await updateIntegrationAction(item.key, {
                totpCode,
                ...(!payloadIsEmpty(config) ? { config } : {}),
              });
              // 失败经 notify 出 toast（action 已把 ApiError 翻译成 error 字段）
              if (!notify(res, tc('saveFailed'), tc('saved'))) return false;
              if (res.item != null) onSaved(res.item);
              setCleared(new Set());
              return true;
            });
          }}
        >
          {rows.map((row) => (
            <div key={row[0]} className={rowClassName(row)}>
              {row.map((field) => (
                <IntegrationField
                  key={field}
                  item={item}
                  field={field}
                  cleared={cleared}
                  onToggleClear={toggleCleared}
                />
              ))}
            </div>
          ))}
          {item.key === 'smtp' ? (
            <SmtpTestField testing={testing} onTest={(form) => void runTest(form)} />
          ) : null}
          {/* step-up 是保存确认而非配置字段：分隔后贴近 footer 的保存钮 */}
          <div className="border-t pt-4">
            <StepupField itemId={item.key} />
          </div>
        </form>
      )}
    </FormDialog>
  );
}

/** 登记行过滤掉字段表中不存在的字段；字段表中存在但未登记的字段按原次序补成单列行 */
function fieldRows(key: string, fields: readonly string[]): readonly (readonly string[])[] {
  const registered = (FIELD_ROWS[key] ?? [])
    .map((row) => row.filter((field) => fields.includes(field)))
    .filter((row) => row.length > 0);
  const grouped = new Set(registered.flat());
  return [...registered, ...fields.filter((field) => !grouped.has(field)).map((field) => [field])];
}

/** 行内列宽：双列等分；host+port 行端口列收窄（端口至多 5 位数字） */
function rowClassName(row: readonly string[]): string | undefined {
  if (row.length < 2) return undefined;
  return row.includes('port')
    ? 'grid grid-cols-[minmax(0,1fr)_6rem] gap-3'
    : 'grid grid-cols-2 gap-3';
}
