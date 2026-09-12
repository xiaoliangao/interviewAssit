import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 守门测试不依赖 Electron / 网络，纯 Node 跑，CI 上能直接跑
    environment: 'node',
    testTimeout: 20000,
  },
});
