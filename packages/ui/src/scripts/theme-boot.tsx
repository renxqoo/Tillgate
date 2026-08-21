/**
 * Boot script that reads user preference values from cookies or localStorage
 * based on the configured persistence mode.
 *
 * Runs early in <head> to apply the correct data attributes before hydration,
 * preventing layout or theme flicker and keeping RootLayout fully static.
 *
 * 导出原始 JS 代码字符串（不是 React 组件），由 root layout 在 <head> 里
 * 通过 <script dangerouslySetInnerHTML> 内联。Next.js 16 对 root layout 的
 * <head> 里的 <script> 有特殊处理，不会触发 React 的 script tag 警告。
 */
import { PREFERENCE_REGISTRY } from "@/lib/preferences/preferences-config";

export function getThemeBootCode(): string {
  const registry = JSON.stringify(PREFERENCE_REGISTRY);

  return `(function(){try{var root=document.documentElement;var REGISTRY=${registry};function readCookie(name){var match=document.cookie.split("; ").find(function(c){return c.startsWith(name+"=")});return match?decodeURIComponent(match.split("=")[1]):null}function readLocal(name){try{return window.localStorage.getItem(name)}catch(e){return null}}function readPreference(key,definition){var mode=definition.persistence;var value=null;if(mode==="localStorage"){value=readLocal(key)}if(!value&&(mode==="client-cookie"||mode==="server-cookie")){value=readCookie(key)}return definition.values.indexOf(value)>=0?value:definition.defaultValue}var preferences={};Object.keys(REGISTRY).forEach(function(key){var definition=REGISTRY[key];var value=readPreference(key,definition);preferences[key]=value;root.setAttribute(definition.attribute,value)});var mode=preferences.theme_mode;var resolvedMode=mode==="system"&&window.matchMedia?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):mode==="dark"?"dark":"light";root.classList.toggle("dark",resolvedMode==="dark");root.style.colorScheme=resolvedMode}catch(e){console.warn("ThemeBootScript error:",e)}})();`;
}
