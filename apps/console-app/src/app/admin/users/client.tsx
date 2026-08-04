'use client';

import { useState } from 'react';
import { Dialog, Field, Input, Feedback, ConfirmButton } from '@/components/dialog';
import {
  updateUserStatusAction,
  adjustUserBalanceAction,
  setUserPasswordAction,
  bindRateCardAction,
} from '../actions';

interface RateCard {
  id: number;
  name: string;
}

/** 用户行操作：封禁/解封 + 调账 + 设密码 + 绑卡 */
export default function UserActions({ user, rateCards }: { user: { id: number; status: number; subject: string; rateCardId: number | null }; rateCards: RateCard[] }) {
  return (
    <div className="flex justify-end gap-2">
      {user.status === 0 ? <BanButton id={user.id} /> : <UnbanButton id={user.id} />}
      <AdjustButton id={user.id} />
      <PasswordButton id={user.id} />
      <BindCardButton id={user.id} current={user.rateCardId} rateCards={rateCards} />
    </div>
  );
}

function BanButton({ id }: { id: number }) {
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <>
      <ConfirmButton
        label="封禁"
        confirmText="确认封禁？"
        onConfirm={async () => {
          const r = await updateUserStatusAction(id, 1);
          setResult(r);
        }}
      />
      <Feedback result={result} />
    </>
  );
}

function UnbanButton({ id }: { id: number }) {
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <>
      <button
        onClick={async () => {
          const r = await updateUserStatusAction(id, 0);
          setResult(r);
        }}
        className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
      >
        解封
      </button>
      <Feedback result={result} />
    </>
  );
}

function AdjustButton({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md border px-3 py-1 text-xs hover:bg-muted">
        调账
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`调账 #${id}`}>
        <form
          action={async (fd) => {
            const r = await adjustUserBalanceAction(id, fd);
            setResult(r);
            if (!r.error) setTimeout(() => setOpen(false), 800);
          }}
          className="space-y-3"
        >
          <Field label="金额（元）" hint="正=增加余额，负=扣减。如 5 = +¥5，-1 = -¥1">
            <Input name="amount" type="number" step="0.01" required placeholder="5" />
          </Field>
          <Field label="备注（可选）">
            <Input name="remark" placeholder="调账原因" />
          </Field>
          <Feedback result={result} />
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-md border px-4 py-1.5 text-sm">取消</button>
            <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">确认调账</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function PasswordButton({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md border px-3 py-1 text-xs hover:bg-muted">
        设密码
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`设置密码 #${id}`}>
        <form
          action={async (fd) => {
            const r = await setUserPasswordAction(id, fd);
            setResult(r);
            if (!r.error) setTimeout(() => setOpen(false), 800);
          }}
          className="space-y-3"
        >
          <Field label="新密码" hint="至少 8 位（用于本地账号登录控制台）">
            <Input name="password" type="password" minLength={8} required />
          </Field>
          <Feedback result={result} />
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-md border px-4 py-1.5 text-sm">取消</button>
            <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">设置</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function BindCardButton({ id, current, rateCards }: { id: number; current: number | null; rateCards: RateCard[] }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ error?: string } | null>(null);
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-md border px-3 py-1 text-xs hover:bg-muted">
        绑卡
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`绑定费率卡 #${id}`}>
        <form
          action={async (fd) => {
            const raw = String(fd.get('rateCardId') ?? '');
            const cardId = raw === '' || raw === 'null' ? null : Number(raw);
            const r = await bindRateCardAction(id, cardId);
            setResult(r);
            if (!r.error) setTimeout(() => setOpen(false), 800);
          }}
          className="space-y-3"
        >
          <Field label="费率卡" hint={`当前: ${current === null ? '未绑定' : `#${current}`}`}>
            <select name="rateCardId" defaultValue={current === null ? '' : String(current)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
              <option value="">未绑定</option>
              {rateCards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (#{c.id})
                </option>
              ))}
            </select>
          </Field>
          <Feedback result={result} />
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-md border px-4 py-1.5 text-sm">取消</button>
            <button type="submit" className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground">绑定</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
