/**
 * OAuth 登录方式数据（纯函数，server page 组装、client 按钮组渲染共用）。
 * label 存 auth 命名空间 i18n key，渲染处统一翻译。
 */
export interface OAuthOption {
  id: 'github' | 'google';
  label: string;
  url: string;
}

export function oauthOptionsFromProviders(providers: string[]): OAuthOption[] {
  const options: OAuthOption[] = [];
  if (providers.includes('github')) {
    options.push({
      id: 'github',
      label: 'oauthGithub',
      url: '/v1/oauth/github/authorize?next=/oauth/callback',
    });
  }
  if (providers.includes('google')) {
    options.push({
      id: 'google',
      label: 'oauthGoogle',
      url: '/v1/oauth/google/authorize?next=/oauth/callback',
    });
  }
  return options;
}
