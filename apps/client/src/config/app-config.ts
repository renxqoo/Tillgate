/**
 * 应用品牌与版本（唯一事实源）：全站展示统一 Tillgate Console；版本随 package.json。
 */
import packageJson from '../../package.json';

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: 'Tillgate Console',
  version: packageJson.version,
  copyright: `© ${currentYear}, Tillgate.`,
  /** 项目仓库外链（品牌事实：页脚 GitHub 入口统一取此） */
  repoUrl: 'https://github.com/renxqoo/Tillgate',
} as const;
