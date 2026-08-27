/**
 * 应用品牌与版本（唯一事实源）：全站展示统一 Tillgate Console；版本随 package.json。
 */
import packageJson from '../../package.json';

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: 'Tillgate Console',
  version: packageJson.version,
  copyright: `© ${currentYear}, Tillgate.`,
} as const;
