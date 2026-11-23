// 架构约束：业务模型、画布与看板独立于任何具体后端。
// 这些测试扫描源码的 import 关系，防止依赖在日后的修改中悄悄越界。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

interface Dep { from: string; spec: string; target: string | null }

/** 解析 import / export from / 动态 import；相对路径解析为相对 src 的路径，包名保持原样（target 为 null） */
const deps: Dep[] = walk(SRC).flatMap((file) => {
  const code = readFileSync(file, 'utf8');
  const re = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
  const out: Dep[] = [];
  for (const m of code.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const target = spec.startsWith('.') ? relative(SRC, resolve(dirname(file), spec)) : null;
    out.push({ from: relative(SRC, file), spec, target });
  }
  return out;
});

const inDir = (path: string, dir: string) => path === dir || path.startsWith(dir + '/');
const violations = (pred: (d: Dep) => boolean) => deps.filter(pred).map((d) => `${d.from} → ${d.spec}`);

describe('架构边界', () => {
  it('domain 是纯业务层：不依赖任何其他模块或第三方包', () => {
    expect(violations((d) => inDir(d.from, 'domain') && (d.target === null || !inDir(d.target, 'domain')))).toEqual([]);
  });

  it('只有 data/supabase 可以引用 Supabase SDK', () => {
    expect(violations((d) => d.spec.startsWith('@supabase/') && !inDir(d.from, 'data/supabase'))).toEqual([]);
  });

  it('具体后端实现只能由组合根 data/index.ts 加载', () => {
    const impl = (t: string | null) => !!t && (inDir(t, 'data/local') || inDir(t, 'data/supabase'));
    expect(violations((d) => impl(d.target) && d.from !== 'data/index.ts' && !inDir(d.from, d.target!.split('/').slice(0, 2).join('/')))).toEqual([]);
  });

  it('后端实现之间互不依赖', () => {
    expect(violations((d) => (inDir(d.from, 'data/local') && !!d.target && inDir(d.target, 'data/supabase'))
      || (inDir(d.from, 'data/supabase') && !!d.target && inDir(d.target, 'data/local')))).toEqual([]);
  });

  it('画布、看板与界面组件不直接访问数据层（只通过 store）', () => {
    const ui = ['canvas', 'board', 'components'];
    expect(violations((d) => ui.some((u) => inDir(d.from, u)) && !!d.target && inDir(d.target, 'data'))).toEqual([]);
  });

  it('store 只依赖后端契约 data/repo，不依赖具体实现或组合根', () => {
    expect(violations((d) => inDir(d.from, 'store') && !!d.target && inDir(d.target, 'data') && d.target !== 'data/repo')).toEqual([]);
  });

  it('业务层、画布、看板、界面与 store 的源码中不出现后端厂商名称', () => {
    const neutral = walk(SRC).filter((f) => ['domain', 'canvas', 'board', 'components', 'store'].some((d) => inDir(relative(SRC, f), d)));
    const hits = neutral.filter((f) => /supabase|postgres/i.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it('扫描器本身能识别出依赖（防止规则因解析失效而“空转”）', () => {
    expect(deps.some((d) => d.from === 'data/supabase/supabaseRepo.ts' && d.spec === '@supabase/supabase-js')).toBe(true);
    expect(deps.some((d) => d.from === 'data/index.ts' && d.target === 'data/local/localRepo')).toBe(true);
    expect(deps.length).toBeGreaterThan(50);
  });
});
