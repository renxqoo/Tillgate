'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { loginAction } from '@/app/actions';

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async (fd) => {
        const r = await loginAction(fd);
        if (r?.error) setError(r.error);
      }}
      className="space-y-4"
    >
      {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      <div className="space-y-1.5">
        <label htmlFor="username" className="text-sm font-medium">
          用户名
        </label>
        <input
          id="username"
          name="username"
          type="text"
          required
          autoFocus
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          密码
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <Button type="submit" className="w-full">
        登录
      </Button>
    </form>
  );
}
