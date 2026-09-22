import { defineConfig, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

/**
 * 与构建模式无关的公共配置。
 *
 * 单独导出是为了让 vitest.config.ts 复用同一份 —— 别名 `@/` 只能有一个定义处，
 * 否则改了这边、测试那边不同步，报错还很难往这上面想。
 */
export const sharedConfig: UserConfig = {
  // 相对路径：打包产物可放在任意目录下由本地静态服务器托管
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    open: false,
    // 构建产物不参与开发时的热更新：否则跑完一次 build，浏览器会莫名其妙地
    // 重新加载（它盯着 dist 里的文件），看起来像代码出了问题
    watch: { ignored: ['**/dist/**', '**/dist-offline/**'] },
  },
  worker: {
    format: 'es',
  },
};

/**
 * 离线构建时把 Google Fonts 的三行 link 删掉。
 *
 * 字体是从谷歌拉的，整份界面在没网时会退回系统字体（CSS 里本来就写了
 * 一层层 fallback：Segoe UI / Consolas…）。日常构建保留它，图的是设计味道；
 * 但**离线构建的整个意义就是不联网**，留一行外链请求等于自己拆台。
 */
function dropWebFonts(): Plugin {
  return {
    name: 'pixelsimage:drop-webfonts',
    transformIndexHtml(html) {
      return html
        .replace(/\s*<link rel="preconnect" href="https:\/\/fonts[^>]*>/g, '')
        .replace(/\s*<link\s+href="https:\/\/fonts\.googleapis[^>]*>/g, '');
    },
  };
}

/**
 * 两种构建，产物是同一份代码：
 *
 * - 默认（`npm run build`）：分文件的静态站点，用任意静态服务器托管。
 * - 离线（`npm run build:offline`，mode = 'offline'）：把 JS / CSS 全部内联进
 *   单个 index.html，**双击即可打开**。
 *
 * 为什么内联能让双击可用：浏览器拦的是「从 file:// 去 fetch 外部的 module 脚本」，
 * 而内联的 `<script type="module">` 与内联样式不受这条限制。
 *
 * 一个已知限制：Web Worker 是独立文件，file:// 下拉不到，会触发主线程降级路径
 * （状态栏显示「已降级 主线程」）。功能全部可用，只是拖参数时略卡 ——
 * 想要完整性能就用静态服务器打开，见 README。
 */
export default defineConfig(({ mode }) => {
  const offline = mode === 'offline';
  return {
    ...sharedConfig,
    plugins: [react(), ...(offline ? [viteSingleFile(), dropWebFonts()] : [])],
    build: {
      target: 'es2022',
      outDir: offline ? 'dist-offline' : 'dist',
      // 内联之后 sourcemap 指向的文件已经不存在了，留着只是几个孤立的 .map
      sourcemap: !offline,
    },
  };
});