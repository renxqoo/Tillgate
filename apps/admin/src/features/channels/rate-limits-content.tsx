'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenuItem,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
  RowActions,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@tokenlens/ui';
import { useState, useTransition } from 'react';
import { GaugeIcon, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { formatMoney } from '@/lib/formatters';

import { updateRateLimitAction } from '@/server/rate-limits-actions';
import type { RateLimitItem, RateLimitKind } from '@/features/channels/rate-limit-types';
import { useActionResult } from '@/components/action-toast';

function fmtLimit(v: number | null): string {
  return v === null ? '' : v.toLocaleString('en-US');
}

function RateLimitTable({
  items,
  kind,
  onEdit,
}: {
  items: RateLimitItem[];
  kind: RateLimitKind;
  onEdit: (kind: RateLimitKind, item: RateLimitItem) => void;
}) {
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  if (items.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">{tUi('empty')}</p>;
  }
  const showCredit = kind === 'user';
  const showDailySpend = kind === 'user' || kind === 'key';
  return (
    <Table>
      <TableHeader className="bg-card">
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead className="text-right">RPM</TableHead>
          <TableHead className="text-right">TPM</TableHead>
          {showCredit ? <TableHead className="text-right">{tc('creditLimit')}</TableHead> : null}
          {showDailySpend ? (
            <TableHead className="text-right">{tc('dailySpendLimit')}</TableHead>
          ) : null}
          <TableHead className="text-center">{tc('status')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((it) => (
          <TableRow key={`${kind}-${it.id}`}>
            <TableCell>
              <div className="flex items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <GaugeIcon className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-medium">{it.label}</div>
                  {it.sublabel ? (
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {it.sublabel}
                    </div>
                  ) : null}
                </div>
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtLimit(it.rpmLimit) || tc('unlimited')}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtLimit(it.tpmLimit) || tc('unlimited')}
            </TableCell>
            {showCredit ? (
              <TableCell className="text-right tabular-nums">
                {fmtMoney(it.creditLimit, tc('unlimited'))}
              </TableCell>
            ) : null}
            {showDailySpend ? (
              <TableCell className="text-right tabular-nums">
                {fmtMoney(it.dailySpendLimit, tc('unlimited'))}
              </TableCell>
            ) : null}
            <TableCell className="text-center">
              {it.status === 0 ? (
                <span className="text-xs text-emerald-600">{tc('active')}</span>
              ) : (
                <span className="text-xs text-destructive">{tc('stopped')}</span>
              )}
            </TableCell>
            <TableCell className="w-16 text-center">
              <RowActions label={tc('actions')}>
                <DropdownMenuItem onClick={() => onEdit(kind, it)}>
                  <PencilIcon /> {tc('edit')}
                </DropdownMenuItem>
              </RowActions>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** 元金额：NULL=不限；数值保留 2 位小数。 */
function fmtMoney(v: string | null | undefined, unlimited: string): string {
  if (v === null || v === undefined) return unlimited;
  return formatMoney(v);
}

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
    const rpmVal = rpm.trim() === '' ? null : Number(rpm);
    const tpmVal = tpm.trim() === '' ? null : Number(tpm);
    if (rpmVal !== null && (!Number.isFinite(rpmVal) || rpmVal <= 0 || !Number.isInteger(rpmVal))) {
      toast.error(t('rpmPositive'));
      return;
    }
    if (tpmVal !== null && (!Number.isFinite(tpmVal) || tpmVal <= 0 || !Number.isInteger(tpmVal))) {
      toast.error(t('tpmPositive'));
      return;
    }

    // 信用模型字段仅 user/key 实体校验/提交
    let creditVal: string | undefined;
    let dailySpendVal: string | null | undefined;
    if (editing.kind === 'user') {
      // creditLimit 不可为 null：留空 = 0（不透支）
      creditVal = credit.trim() === '' ? '0' : credit.trim();
      dailySpendVal = dailySpend.trim() === '' ? null : dailySpend.trim();
      if (!/^\d+(?:\.\d+)?$/.test(creditVal)) {
        toast.error(t('creditNonNegative'));
        return;
      }
      if (dailySpendVal !== null && !/^\d+(?:\.\d+)?$/.test(dailySpendVal)) {
        toast.error(t('dailySpendNonNegative'));
        return;
      }
    } else if (editing.kind === 'key') {
      dailySpendVal = dailySpend.trim() === '' ? null : dailySpend.trim();
      if (dailySpendVal !== null && !/^\d+(?:\.\d+)?$/.test(dailySpendVal)) {
        toast.error(t('dailySpendNonNegative'));
        return;
      }
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
    <div className="flex flex-col gap-4">
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

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GaugeIcon className="size-4" />
              {t('editTitle')}
            </DialogTitle>
            <DialogDescription>
              {editing ? t('editDescription', { label: editing.item.label }) : ''}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <FormItem>
              <FieldLabel>{t('rpmLabel')}</FieldLabel>
              <Input
                type="number"
                min={1}
                placeholder={tc('unlimited')}
                value={rpm}
                onChange={(e) => setRpm(e.target.value)}
              />
            </FormItem>
            <FormItem>
              <FieldLabel>{t('tpmLabel')}</FieldLabel>
              <Input
                type="number"
                min={1}
                placeholder={tc('unlimited')}
                value={tpm}
                onChange={(e) => setTpm(e.target.value)}
              />
            </FormItem>
            {showCreditField ? (
              <FormItem>
                <FieldLabel>{t('creditLabel')}</FieldLabel>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0"
                  value={credit}
                  onChange={(e) => setCredit(e.target.value)}
                />
              </FormItem>
            ) : null}
            {showDailySpendField ? (
              <FormItem>
                <FieldLabel>{t('dailySpendLabel')}</FieldLabel>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder={tc('unlimited')}
                  value={dailySpend}
                  onChange={(e) => setDailySpend(e.target.value)}
                />
              </FormItem>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={pending}>
              {tUi('cancel')}
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? t('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
