'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';

export interface MobileLink {
  href: string;
  label: string;
  newBadge?: boolean;
}

interface Props {
  links: MobileLink[];
  loggedIn: boolean;
  loginLabel: string;
  enterLabel: string;
  startLabel: string;
}

/** 移动端头部菜单：汉堡按钮 + 下拉面板 */
export function MobileMenu({ links, loggedIn, loginLabel, enterLabel, startLabel }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label="menu"
        className="flex size-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>
      {open ? (
        <div className="absolute inset-x-0 top-full border-t border-slate-100 bg-white px-6 py-4 shadow-lg">
          <nav className="space-y-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                onClick={() => setOpen(false)}
              >
                {l.label}
                {l.newBadge ? (
                  <span className="rounded bg-[#f64041] px-1 py-0.5 text-[10px] font-semibold leading-none text-white">
                    NEW
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          <div className="mt-4 flex gap-3 border-t border-slate-100 pt-4">
            {loggedIn ? (
              <Link
                href="/dashboard"
                className="flex-1 rounded-full bg-slate-900 px-5 py-2.5 text-center text-sm font-medium text-white"
                onClick={() => setOpen(false)}
              >
                {enterLabel}
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="flex-1 rounded-full border border-slate-200 px-5 py-2.5 text-center text-sm font-medium text-slate-700"
                  onClick={() => setOpen(false)}
                >
                  {loginLabel}
                </Link>
                <Link
                  href="/register"
                  className="flex-1 rounded-full bg-slate-900 px-5 py-2.5 text-center text-sm font-medium text-white"
                  onClick={() => setOpen(false)}
                >
                  {startLabel}
                </Link>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
