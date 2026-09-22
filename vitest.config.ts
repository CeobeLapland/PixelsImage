/**
 * vitest 配置。
 *
 * 用 mergeConfig 复用 vite.config.ts，而不是重写一份 —— 这样 `@/` 路径别名
 * 只有一个定义处，改了不会两边不同步。
 *
 * 环境用 node 而非 jsdom：core/ 层刻意不依赖 DOM，能在 node 里跑起来
 * 本身就是对这条架构约束的验证。用到 ImageData 的渲染/导出代码不在这里测。
 */

import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
      setupFiles: ['src/core/__testing__/setup.ts'],
      reporters: ['default'],
    },
  }),
);