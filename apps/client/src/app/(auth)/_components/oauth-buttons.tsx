import { useTranslations } from "next-intl";

/** 品牌图标（lucide 已移除品牌图标，用官方 mark 内联 SVG） */
function GithubMarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-current">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.27 5.66.41.36.78 1.05.78 2.12v3.15c0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function GoogleMarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.53 5.53 0 0 1-2.4 3.63v3.01h3.87c2.27-2.09 3.57-5.17 3.57-8.83Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.87-3.01c-1.08.72-2.46 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.11A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.11Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.62l3.98 3.11C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

/** client-api 已配置的 OAuth 登录方式（页面服务端拉取，未配置不渲染）；
 *  label 存 auth 命名空间 i18n key，渲染处统一翻译 */
export interface OAuthOption {
  id: "github" | "google";
  label: string;
  url: string;
}

export function oauthOptionsFromProviders(
  providers: string[],
): OAuthOption[] {
  const options: OAuthOption[] = [];
  if (providers.includes("github")) {
    options.push({ id: "github", label: "oauthGithub", url: "/v1/oauth/github/authorize?next=/oauth/callback" });
  }
  if (providers.includes("google")) {
    options.push({ id: "google", label: "oauthGoogle", url: "/v1/oauth/google/authorize?next=/oauth/callback" });
  }
  return options;
}

/** 分隔线 + 第三方登录按钮组（无可用方式时不渲染） */
export function OAuthButtons({ options }: { options: OAuthOption[] }) {
  const t = useTranslations("auth");
  if (options.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {t("or")}
        <span className="h-px flex-1 bg-border" />
      </div>
      {options.map((option) => (
        <a
          key={option.id}
          href={option.url}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-input bg-background text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {option.id === "github" ? <GithubMarkIcon /> : <GoogleMarkIcon />}
          {t(option.label)}
        </a>
      ))}
    </div>
  );
}
