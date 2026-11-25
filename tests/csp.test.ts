// 内容安全策略只放行本站脚本，以及 index.html 中那一段内联脚本（按 sha256 哈希）。
// 改动内联脚本而忘了更新 public/_headers，线上会静默失效（外观选择不生效），这里提前拦住。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync('index.html', 'utf8');
const headers = readFileSync('public/_headers', 'utf8');
const csp = headers.split('\n').find((l) => l.includes('Content-Security-Policy:'))!;
const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))!;

describe('内容安全策略', () => {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  it('每段内联脚本的哈希都在 script-src 中', () => {
    expect(inline.length).toBeGreaterThan(0);
    for (const js of inline) {
      const h = `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`;
      expect(scriptSrc, js.slice(0, 60)).toContain(h);
    }
  });

  it('script-src 不放行任意内联脚本或 eval', () => {
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(scriptSrc.match(/'sha256-/g)?.length ?? 0).toBe(inline.length);
  });
});
