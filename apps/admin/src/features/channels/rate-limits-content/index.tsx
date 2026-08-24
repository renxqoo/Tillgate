'use client';

// 限流管理编排：四实体 tab + 编辑态提升（表单值/校验/保存集中在编排器，弹窗为受控哑件）

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tillgate/ui';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { updateRateLimitAction } from '@/server/rate-limits-actions';
import type { RateLimitItem, RateLimitKind } from '@/features/channels/rate-limit-types';
import { useActionResult } from '@/components/action-toast';
import { RateLimitTable } from './rate-limit-table';
import { RateLimitEditDialog } from './rate-limit-edit-dialog';
import { parseAmountText, parseLimitText } from './rate-limit-format';

export function RateLimitsClient({
  users,
  models,
  channels,
  keys,
}: {
  users: RateLimitItem[];
  models: RateLimitItem[];
  channels: RateLimitItem[];
  keys: RateLimitItem[];
}) {
  const t = useTranslations('rateLimits');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const [editing, setEditing] = useState<{ kind: RateLimitKind; item: RateLimitItem } | null>(null);
  const [rpm, setRpm] = useState<string>('');
  const [tpm, setTpm] = useState<string>('');
  const [credit, setCredit] = useState<string>('');
  const [dailySpend, setDailySpend] = useState<string>('');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();

  const openEdit = (kind: RateLimitKind, item: RateLimitItem) => {
    setEditing({ kind, item });
    setRpm(item.rpmLimit === null ? '' : String(item.rpmLimit));
    setTpm(item.tpmLimit === null ? '' : String(item.tpmLimit));
    setCredit(
      item.creditLimit === null || item.creditLimit === undefined ? '' : String(item.creditLimit),
    );
    setDailySpend(
      item.dailySpendLimit === null || item.dailySpendLimit === undefined
        ? ''
        : String(item.dailySpendLimit),
    );
  };

  const save = () => {
    if (!editing) return;
    const rpmVal = parseLimitText(rpm);
    const tpmVal = parseLimitText(tpm);
    if (rpmVal === undefined) {
      toast.error(t('rpmPositive'));
      return;
    }
    if (tpmVal === undefined) {
      toast.error(t('tpmPositive'));
      return;
    }

    // 信用模型字段仅 user/key 实体校验/提交
    let creditVal: string | undefined;
    let dailySpendVal: string | null | undefined;
    if (editing.kind === 'user') {
      // creditLimit 不可为 null：留空 = 0（不透支）
      creditVal = credit.trim() === '' ? '0' : credit.trim();
      const daily = parseAmountText(dailySpend);
      if (!/^\d+(?:\.\d+)?$/.test(creditVal)) {
        toast.error(t('creditNonNegative'));
        return;
      }
      if (daily === undefined) {
        toast.error(t('dailySpendNonNegative'));
        return;
      }
      dailySpendVal = daily;
    } else if (editing.kind === 'key') {
      const daily = parseAmountText(dailySpend);
      if (daily === undefined) {
        toast.error(t('dailySpendNonNegative'));
        return;
      }
      dailySpendVal = daily;
    }

    startTransition(async () => {
      const res = await updateRateLimitAction(editing.kind, editing.item.id, {
        rpmLimit: rpmVal,
        tpmLimit: tpmVal,
        creditLimit: creditVal,
        dailySpendLimit: dailySpendVal,
      });
      if (notify(res, undefined, t('savedImmediate'))) setEditing(null);
    });
  };

  const showCreditField = editing?.kind === 'user';
  const showDailySpendField = editing?.kind === 'user' || editing?.kind === 'key';

  return (
    <div className="flex flex-col gap-4 mt-4">
      <Tabs defaultValue="user">
        {/* 与 ListToolbar 的 px-4、表格首列 pl-4 对齐（ListContent 本身无内边距） */}
        <TabsList className="ml-4">
          <TabsTrigger value="user">{t('tabUser', { count: users.length })}</TabsTrigger>
          <TabsTrigger value="model">{t('tabModel', { count: models.length })}</TabsTrigger>
          <TabsTrigger value="channel">{t('tabChannel', { count: channels.length })}</TabsTrigger>
          <TabsTrigger value="key">{t('tabKey', { count: keys.length })}</TabsTrigger>
        </TabsList>
        <TabsContent value="user">
          <RateLimitTable items={users} kind="user" onEdit={openEdit} />
        </TabsContent>
        <TabsContent value="model">
          <RateLimitTable items={models} kind="model" onEdit={openEdit} />
        </TabsContent>
        <TabsContent value="channel">
          <RateLimitTable items={channels} kind="channel" onEdit={openEdit} />
        </TabsContent>
        <TabsContent value="key">
          <RateLimitTable items={keys} kind="key" onEdit={openEdit} />
        </TabsContent>
      </Tabs>

      <RateLimitEditDialog
        editing={editing}
        rpm={rpm}
        tpm={tpm}
        credit={credit}
        dailySpend={dailySpend}
        pending={pending}
        showCreditField={showCreditField}
        showDailySpendField={showDailySpendField}
        onClose={() => setEditing(null)}
        onSave={save}
        setRpm={setRpm}
        setTpm={setTpm}
        setCredit={setCredit}
        setDailySpend={setDailySpend}
        t={t}
        tc={tc}
        tUi={tUi}
      />
    </div>
  );
}
