/**
 * OAuth 回调 fragment 解析（纯函数）：client-api 以 `#token=…&next=…` 形态
 * 回传（fragment 不进服务端日志与 Referer）。next 只接受站内绝对路径。
 */
export interface OAuthFragment {
  token: string | null;
  next: string | null;
}

export function parseOAuthFragment(hash: string): OAuthFragment {
  const query = hash.startsWith('#') ? hash.slice(1) : hash;
  if (query === '') return { token: null, next: null };
  const params = new URLSearchParams(query);
  const token = params.get('token');
  const next = params.get('next');
  const safeNext = next !== null && next.startsWith('/') && !next.startsWith('//') ? next : null;
  return { token: token !== '' ? token : null, next: safeNext };
}
