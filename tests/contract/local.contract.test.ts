import { LocalRepo, type SessionStore } from '../../src/data/local/localRepo';
import { defineRepoContract } from './repoContract';

/** 每个模拟用户一个独立的内存会话，共享同一个（内存）localStorage 数据库 */
class MemorySession implements SessionStore {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

defineRepoContract({
  name: 'LocalRepo（浏览器内实现）',
  newSession: () => new LocalRepo({ session: new MemorySession() }),
  realtime: true,
  dispose: (r) => (r as LocalRepo).dispose(),
});
