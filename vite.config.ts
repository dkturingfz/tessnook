import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 首屏提速：后端实现由 data/index.ts 动态加载，浏览器要等入口脚本执行后才开始下载它，
 * 形成串行瀑布。构建时按配置判断本次用哪个实现，在 HTML 里为它加 modulepreload，
 * 让它与入口脚本并行下载。未选中的实现不预加载。
 */
function preloadBackend(cloud: boolean): Plugin {
  const target = cloud ? '/src/data/supabase/supabaseRepo.ts' : '/src/data/local/localRepo.ts';
  return {
    name: 'tessnook-preload-backend',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const chunk = Object.values(ctx.bundle ?? {}).find(
          (c) => c.type === 'chunk' && c.facadeModuleId?.replace(/\\/g, '/').endsWith(target),
        );
        if (!chunk) return [];
        return [{ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: '', href: `/${chunk.fileName}` }, injectTo: 'head' }];
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const cloud = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);
  return {
    plugins: [react(), preloadBackend(cloud)],
    test: { environment: 'node', include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup-dom.ts'] },
  } as any;
});
