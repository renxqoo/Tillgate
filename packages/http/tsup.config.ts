import { defineConfig } from 'tsup';
import { shared } from '../../tsup.config.base';

export default defineConfig({
  ...shared,
  entry: ['src/index.ts', 'src/network.ts'], // network：纯函数子路径出口（FE 可安全打包，不拖 barrel 的 DB 依赖）
  dts: true,
});
