// 组合根：根据配置选择后端实现。具体实现通过动态 import 加载，
// 因此应用的其他部分（以及未选中的实现）不会被打包进同一个依赖图。
import type { Repo } from './repo';

export * from './repo';

export interface BackendConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export async function createRepo(config: BackendConfig): Promise<Repo> {
  if (config.supabaseUrl && config.supabaseAnonKey) {
    const { SupabaseRepo } = await import('./supabase/supabaseRepo');
    return new SupabaseRepo(config.supabaseUrl, config.supabaseAnonKey);
  }
  const { LocalRepo } = await import('./local/localRepo');
  return new LocalRepo();
}

export function configFromEnv(): BackendConfig {
  return {
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  };
}
