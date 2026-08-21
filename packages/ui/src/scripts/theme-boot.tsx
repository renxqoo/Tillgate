/**
 * 主题 boot 脚本（仅夜间模式）：读 theme_mode cookie（light/dark/system，默认
 * light），在水合前把 data-theme-mode / dark class / colorScheme 落到 <html>，
 * 防首屏闪白；system 模式订阅系统配色变化实时切换。
 *
 * 导出原始 JS 代码字符串（不是 React 组件），由 root layout 在 <head> 里
 * 通过 <script dangerouslySetInnerHTML> 内联。
 */
export function getThemeBootCode(): string {
  return `(function(){try{var root=document.documentElement;var m=document.cookie.split("; ").find(function(c){return c.startsWith("theme_mode=")});var v=m?decodeURIComponent(m.split("=")[1]):null;var mode=v==="dark"||v==="system"?v:"light";root.setAttribute("data-theme-mode",mode);function apply(){var dark=mode==="dark"||(mode==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);root.classList.toggle("dark",dark);root.style.colorScheme=dark?"dark":"light"}apply();if(mode==="system"&&window.matchMedia){var media=window.matchMedia("(prefers-color-scheme: dark)");if(media.addEventListener)media.addEventListener("change",function(){apply()})}}catch(e){console.warn("ThemeBootScript error:",e)}})();`;
}
