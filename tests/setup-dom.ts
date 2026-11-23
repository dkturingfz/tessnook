// 为 LocalRepo 提供最小的浏览器环境（localStorage / sessionStorage / window / document）
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const g = globalThis as any;
g.localStorage = new MemStorage();
g.sessionStorage = new MemStorage();
g.window ??= { addEventListener() {}, removeEventListener() {} };
g.document ??= { addEventListener() {}, removeEventListener() {} };
export function switchUser(id: string) { g.sessionStorage.setItem('spatial-board:session-user', id); }
export function resetStorage() { g.localStorage.clear(); g.sessionStorage.clear(); }
