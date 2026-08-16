"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Loader2Icon, ShieldCheckIcon } from "lucide-react";

/**
 * Cloudflare Turnstile 隐形挑战 widget（managed 模式）。
 *
 *   - 显式渲染：脚本全局去重加载 → turnstile.render → token 上抛给表单
 *   - token 服务端单次消费：失败提交后由父组件递增 resetNonce 强制换票
 *   - 过期回调清空 token（managed 模式自动重新挑战，用户无感）
 *   - 脚本不可达/渲染失败显示重试按钮，不阻塞表单其余部分
 *
 * CSP 前提（apps/client/next.config.mjs）：script-src + frame-src 放行
 * https://challenges.cloudflare.com。
 */

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: "auto" | "light" | "dark";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: (code: string) => void;
}

interface TurnstileAPI {
  render: (el: HTMLElement, opts: TurnstileRenderOptions) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileAPI;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<TurnstileAPI> | null = null;

function loadTurnstile(): Promise<TurnstileAPI> {
  scriptPromise ??= new Promise<TurnstileAPI>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile 全局对象缺失"));
    });
    script.addEventListener("error", () => reject(new Error("turnstile 脚本不可达")));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  /** token 产生/过期（null）时上抛；父组件持有并随表单提交 */
  onToken: (token: string | null) => void;
  /** 父组件递增以强制换票（token 服务端单次消费，失败提交后必须换新） */
  resetNonce?: number;
}

export function TurnstileWidget({ siteKey, onToken, resetNonce = 0 }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [failed, setFailed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  // 首次 resetNonce（0）不触发换票，只挂载
  const firstResetRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current || widgetIdRef.current !== null) return;
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => {
            setFailed(true);
          },
        });
        setMounted(true);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null) {
        window.turnstile?.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
      setMounted(false);
    };
  }, [siteKey, reloadNonce]);

  useEffect(() => {
    if (firstResetRef.current) {
      firstResetRef.current = false;
      return;
    }
    if (widgetIdRef.current !== null) window.turnstile?.reset(widgetIdRef.current);
  }, [resetNonce]);

  if (failed) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
        <span>人机验证加载失败（网络或脚本被拦截）</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setFailed(false);
            setReloadNonce((n) => n + 1);
          }}
        >
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div ref={containerRef} className="min-h-16" aria-label="人机验证" />
      {!mounted && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />
          正在加载人机验证…
        </p>
      )}
      {mounted && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3" />
          注册受隐形人机验证保护，通常无需任何操作
        </p>
      )}
    </div>
  );
}
