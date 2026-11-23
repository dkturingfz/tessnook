// 对真实 Supabase 项目运行后端契约：
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=... npm run test:contract:supabase
// 需要已执行 supabase/migrations，并在测试期间关闭邮箱确认。未设置环境变量时跳过。
// 设置 CONTRACT_REALTIME=0 可跳过实时部分（例如在不支持 WebSocket 的网络环境中）。
import { describe, it } from 'vitest';
import { SupabaseRepo } from '../../src/data/supabase/supabaseRepo';
import { defineRepoContract } from './repoContract';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (url && key) {
  defineRepoContract({
    name: 'SupabaseRepo',
    newSession: () => new SupabaseRepo(url, key, { persistSession: false }),
    realtime: process.env.CONTRACT_REALTIME !== '0',
    timeout: 30_000,
  });
} else {
  describe('后端契约：SupabaseRepo', () => {
    it.skip('未设置 SUPABASE_URL / SUPABASE_ANON_KEY，跳过', () => {});
  });
}
