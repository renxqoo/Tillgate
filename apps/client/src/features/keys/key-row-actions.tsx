'use client';

import type * as React from 'react';
import { useState } from 'react';

import { Loader2Icon, PencilIcon, Trash2Icon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  RowActions,
  toast,
} from '@tillgate/ui';
import type { KeyRow } from '@tillgate/api-client';

import { actionResult } from '@/features/shared/action-result';
import { ConfirmAction } from '@/features/shared/confirm-action';
import { RhfNumberField } from '@/features/shared/rhf-number-field';
import { parseDailySpend, parsePositiveInt } from '@/features/keys/key-params';
import { revokeKeyAction, updateKeyAction } from '@/server/actions/keys';

interface EditKeyValues {
  name: string;
  remark?: string;
  rpmLimit?: string;
  tpmLimit?: string;
  dailySpendLimit?: string;
}

export function KeyRowActions({ keyRow }: { keyRow: KeyRow }) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const [editOpen, setEditOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  return (
    <>
      <RowActions label={tCommon('actions')}>
        {keyRow.status === 0 ? (
          <>
            <DropdownMenuItem onClick={() => setEditOpen(true)}>
              <PencilIcon /> {tCommon('edit')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setRevokeOpen(true)}>
              <Trash2Icon /> {t('revoke')}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem disabled>{t('statusRevoked')}</DropdownMenuItem>
        )}
      </RowActions>
      <EditKeyDialog keyRow={keyRow} open={editOpen} onOpenChange={setEditOpen} />
      {/* 弹窗挂在菜单外(受控 open):菜单点选关闭时会卸载整个 content,放里面会连弹窗一起卸掉 */}
      <ConfirmAction
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        confirm={t('revokeConfirm')}
        action={async () => revokeKeyAction(keyRow.id)}
        errorTitle={t('revokeFailed')}
        success={t('revokedToast')}
      />
    </>
  );
}

function EditKeyDialog({
  keyRow,
  trigger = null,
  open,
  onOpenChange,
}: {
  keyRow: KeyRow;
  trigger?: React.ReactElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const tUi = useTranslations('ui');

  const editSchema = z.object({
    name: z.string().min(1, t('nameRequired')).max(100),
    remark: z.string().max(200).optional(),
    rpmLimit: z.string().optional(),
    tpmLimit: z.string().optional(),
    dailySpendLimit: z.string().optional(),
  });

  const form = useForm<EditKeyValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: keyRow.name,
      remark: keyRow.remark ?? '',
      rpmLimit: keyRow.rpmLimit === null ? '' : String(keyRow.rpmLimit),
      tpmLimit: keyRow.tpmLimit === null ? '' : String(keyRow.tpmLimit),
      dailySpendLimit: keyRow.dailySpendLimit === null ? '' : String(keyRow.dailySpendLimit),
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (nextOpen) {
          form.reset({
            name: keyRow.name,
            remark: keyRow.remark ?? '',
            rpmLimit: keyRow.rpmLimit === null ? '' : String(keyRow.rpmLimit),
            tpmLimit: keyRow.tpmLimit === null ? '' : String(keyRow.tpmLimit),
            dailySpendLimit: keyRow.dailySpendLimit === null ? '' : String(keyRow.dailySpendLimit),
          });
        }
      }}
    >
      {trigger ? (
        <DialogTrigger render={trigger}>
          <PencilIcon />
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('editTitle')}</DialogTitle>
          <DialogDescription>{t('editDesc')}</DialogDescription>
        </DialogHeader>
        <form
          id="edit-key-form"
          onSubmit={form.handleSubmit(async (values) => {
            const rpm = parsePositiveInt(values.rpmLimit, t('positiveIntError', { field: 'RPM' }));
            if (!rpm.ok) {
              toast.error(rpm.message);
              return;
            }
            const tpm = parsePositiveInt(values.tpmLimit, t('positiveIntError', { field: 'TPM' }));
            if (!tpm.ok) {
              toast.error(tpm.message);
              return;
            }
            const daily = parseDailySpend(values.dailySpendLimit, t('dailySpendError'));
            if (!daily.ok) {
              toast.error(daily.message);
              return;
            }
            const res = await updateKeyAction(keyRow.id, {
              name: values.name,
              remark: values.remark,
              rpmLimit: rpm.value,
              tpmLimit: tpm.value,
              dailySpendLimit: daily.value,
            });
            if (!actionResult(res, tCommon('updateFailed'), t('updatedToast'))) return;
            onOpenChange(false);
          })}
          className="space-y-4"
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="edit-key-name">{tCommon('name')}</FieldLabel>
                  <Input id="edit-key-name" {...field} />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="remark"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="edit-key-remark">{t('remarkOptional')}</FieldLabel>
                  <Input id="edit-key-remark" {...field} />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <RhfNumberField
              control={form.control}
              name="rpmLimit"
              label={t('rpmLabel')}
              id="edit-key-rpm"
              min={1}
              step="1"
              placeholder={tCommon('unlimited')}
            />
            <RhfNumberField
              control={form.control}
              name="tpmLimit"
              label={t('tpmLabel')}
              id="edit-key-tpm"
              min={1}
              step="1"
              placeholder={tCommon('unlimited')}
            />
            <RhfNumberField
              control={form.control}
              name="dailySpendLimit"
              label={t('dailyLimitLabel')}
              id="edit-key-dailyspend"
              min={0}
              step="0.01"
              placeholder={tCommon('unlimited')}
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
          <Button type="submit" form="edit-key-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
            {tCommon('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
