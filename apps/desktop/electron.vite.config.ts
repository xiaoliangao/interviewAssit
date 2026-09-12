import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // better-sqlite3 是原生模块，必须 external —— 它的 .node 按 ABI 编译，
        // 打不进 bundle。core 和 contract 反过来要打进去：它们是 TS 源码，
        // externalize 之后运行时会去 require 一个 .ts 文件。
        external: ['better-sqlite3'],
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      // outDir 默认相对 root，不写死会把产物丢到仓库根的 out/
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    plugins: [react()],
  },
});
