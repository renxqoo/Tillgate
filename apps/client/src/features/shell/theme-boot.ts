/**
 * 主题水合前 boot 脚本（防 FOUC）：在水合前读取 ui ThemeProvider 的
 * localStorage key（`theme`，light/dark/system）落 dark class。
 * ui 包是纯 React 设计系统（无 Next 依赖、无 server action），SSR 首帧
 * class 注入由 app 承担——key 名与 packages/ui ThemeProvider 默认 storageKey
 * 同源，改动需双侧同步。
 */
const THEME_STORAGE_KEY = 'theme';
const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export function getThemeBootCode(): string {
  return `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=t==='dark'||((t==='system'||!t)&&window.matchMedia('${COLOR_SCHEME_QUERY}').matches);var r=document.documentElement;r.classList.remove('light','dark');r.classList.add(d?'dark':'light');r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
}
