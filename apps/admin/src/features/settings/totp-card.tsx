'use client';

/**
 * TOTP 绑定卡（独立完整卡：壳 + 内容一文件，组装见 ./index.tsx）：
 * 未绑定 → 绑定向导（二维码/密钥 → 验码 → 恢复码一次性展示）；已绑定 →
 * 解绑（须持有效码）。二维码 SVG 由 server action 生成（本组件只透传
 * 渲染——qrcode 不进客户端包）。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CheckIcon, CopyIcon, Loader2Icon, SmartphoneIcon } from 'lucide-react';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
} from '@tillgate/ui';

import { useActionResult } from '@/components/action-toast';
import {
  confirmTotpAction,
  disableTotpAction,
  enrollTotpAction,
  type TotpEnrollView,
} from '@/server/totp-actions';

// eslint-disable-next-line max-lines-per-function -- TOTP 开通/关闭双流程卡（二维码/验证/恢复码三阶段）平铺，拆分需抽阶段子组件
export function TotpCard({ totpEnabled }: { readonly totpEnabled: boolean }) {
  const t = useTranslations('settings.totp');
  const ts = useTranslations('settings');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [bindOpen, setBindOpen] = useState(false);
  const [enrollment, setEnrollment] = useState<TotpEnrollView | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const [unbindOpen, setUnbindOpen] = useState(false);
  const [unbindCode, setUnbindCode] = useState('');

  function resetBind() {
    setEnrollment(null);
    setCode('');
    setRecoveryCodes(null);
    setCopied(false);
  }

  function startEnroll(open: boolean) {
    setBindOpen(open);
    if (open) {
      resetBind();
      startTransition(async () => {
        const res = await enrollTotpAction();
        if (!notify(res, tc('actionFailed'))) return;
        setEnrollment(res.enrollment ?? null);
      });
    }
  }

  function submitConfirm() {
    startTransition(async () => {
      const res = await confirmTotpAction(code);
      if (!notify(res, t('confirmFailed'))) return;
      setRecoveryCodes(res.recoveryCodes ?? []);
    });
  }

  function submitUnbind() {
    startTransition(async () => {
      const res = await disableTotpAction(unbindCode);
      if (!notify(res, t('unbindFailed'), t('unbound'))) return;
      setUnbindOpen(false);
      setUnbindCode('');
      router.refresh();
    });
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SmartphoneIcon className="size-4" /> {ts('totp.title')}
        </CardTitle>
        <CardDescription>
          {totpEnabled ? t('boundDescription') : t('bindDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex flex-col  gap-3">
            <div>
              <Button
                variant={totpEnabled ? 'destructive' : 'default'}
                size="sm"
                disabled={pending}
                onClick={() => (totpEnabled ? setUnbindOpen(true) : startEnroll(true))}
              >
                {pending && <Loader2Icon className="animate-spin" />}
                {totpEnabled ? t('unbind') : t('bind')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {totpEnabled ? t('boundDescription') : t('bindDescription')}
            </p>
          </div>

          {/* 绑定向导:扫码验码 → 恢复码(仅一次) */}
          <Dialog
            open={bindOpen}
            onOpenChange={(open) => {
              setBindOpen(open);
              if (!open) {
                resetBind();
                if (recoveryCodes != null) router.refresh();
              }
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{recoveryCodes ? t('recoveryTitle') : t('bindTitle')}</DialogTitle>
                <DialogDescription>
                  {recoveryCodes ? t('recoveryDescription') : t('bindDescription')}
                </DialogDescription>
              </DialogHeader>
              {recoveryCodes ? (
                <div className="space-y-3">
                  <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
                    {recoveryCodes.map((c) => (
                      <li key={c} className="rounded border px-2 py-1 tracking-widest">
                        {c}
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(recoveryCodes.join('\n'));
                      setCopied(true);
                    }}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {t('copyCodes')}
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {enrollment == null ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2Icon className="animate-spin" /> {t('generating')}
                    </p>
                  ) : (
                    <>
                      <div
                        className="mx-auto w-fit rounded-lg border bg-white p-2"
                        // 服务端 qrcode 库生成的静态 SVG(无用户输入拼接)
                        dangerouslySetInnerHTML={{ __html: enrollment.qrSvg }}
                      />
                      <p className="break-all text-center font-mono text-xs text-muted-foreground">
                        {enrollment.secret}
                      </p>
                      <FieldGroup>
                        <FormItem>
                          <FieldLabel htmlFor="totp-confirm-code">
                            {t('confirmCodeLabel')}
                          </FieldLabel>
                          <Input
                            id="totp-confirm-code"
                            className="uppercase tracking-widest"
                            placeholder={t('confirmCodePlaceholder')}
                            value={code}
                            onChange={(e) =>
                              setCode(
                                e.target.value
                                  .toUpperCase()
                                  .replace(/[^A-Z0-9]/g, '')
                                  .slice(0, 10),
                              )
                            }
                          />
                        </FormItem>
                      </FieldGroup>
                      <Button
                        className="w-full"
                        disabled={pending || !/^([0-9]{6}|[A-Z0-9]{10})$/.test(code)}
                        onClick={submitConfirm}
                      >
                        {pending && <Loader2Icon className="animate-spin" />}
                        <SmartphoneIcon />
                        {t('confirmBind')}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </DialogContent>
          </Dialog>

          {/* 解绑:须持有效验证器/恢复码 */}
          <Dialog
            open={unbindOpen}
            onOpenChange={(open) => {
              setUnbindOpen(open);
              if (!open) setUnbindCode('');
            }}
          >
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>{t('unbindTitle')}</DialogTitle>
                <DialogDescription>{t('unbindDescription')}</DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <FormItem>
                  <FieldLabel htmlFor="totp-unbind-code">{t('confirmCodeLabel')}</FieldLabel>
                  <Input
                    id="totp-unbind-code"
                    className="uppercase tracking-widest"
                    placeholder={t('confirmCodePlaceholder')}
                    value={unbindCode}
                    onChange={(e) =>
                      setUnbindCode(
                        e.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                          .slice(0, 10),
                      )
                    }
                  />
                </FormItem>
              </FieldGroup>
              <Button
                className="w-full"
                variant="destructive"
                disabled={pending || !/^([0-9]{6}|[A-Z0-9]{10})$/.test(unbindCode)}
                onClick={submitUnbind}
              >
                {pending && <Loader2Icon className="animate-spin" />}
                {t('unbind')}
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  );
}
