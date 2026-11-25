import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5174', viewport: { width: 1440, height: 900 }, trace: 'off',
    // 浏览器需要 UTF-8 语言环境，否则含中文的下载文件名会被替换为 “download”
    launchOptions: { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } },
  },
  webServer: [
    {
      command: 'npx vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      // 强制本地模式，e2e 不依赖 Supabase
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    },
    {
      // 生产构建的预览：用于只在生产构建中生效的功能（例如新版本提示）
      command: 'npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4175 --strictPort',
      url: 'http://localhost:4175',
      reuseExistingServer: true,
      timeout: 120_000,
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    },
  ],
});
