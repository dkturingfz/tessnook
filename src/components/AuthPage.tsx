import { useState } from 'react';
import { useStore } from '../store/store';
import { ROLE_LABEL } from '../domain/rules';

/** 登录与选择空间页面的外框：左侧品牌区（取自横幅设计），右侧表单 */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-blob b1" aria-hidden />
      <div className="auth-blob b2" aria-hidden />
      <div className="auth-blob b3" aria-hidden />
      <section className="auth-hero">
        <img className="hero-logo" src="/favicon.svg" alt="" />
        <h1>Tessnook</h1>
        <p className="hero-tagline">A place for every idea</p>
        <p className="hero-sub">用空间组织注意力，用事件包组织工作，用看板推进执行。</p>
        <ul className="hero-quadrants" aria-label="四象限">
          <li style={{ ['--q' as any]: 'var(--q2-solid)' }}><b>Q2</b>重要 · 不紧急</li>
          <li style={{ ['--q' as any]: 'var(--q1-solid)' }}><b>Q1</b>重要 · 紧急</li>
          <li style={{ ['--q' as any]: 'var(--q3-solid)' }}><b>Q3</b>不重要 · 不紧急</li>
          <li style={{ ['--q' as any]: 'var(--q4-solid)' }}><b>Q4</b>不重要 · 紧急</li>
        </ul>
      </section>
      {children}
    </div>
  );
}

export function AuthPage() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = useStore.getState();
  const backend = useStore((x) => x.backend);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'in') await s.signIn(email, password);
      else await s.signUp(email, password, name);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">{mode === 'in' ? '欢迎回来' : '创建账户'}</div>
        {backend?.storage === 'browser' && (
          <p className="note">本地模式：账户与数据保存在本浏览器中。在不同标签页登录不同账户即可体验多人协作。</p>
        )}
        <div className="tabs">
          <button type="button" className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')}>登录</button>
          <button type="button" className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')}>注册</button>
        </div>
        {mode === 'up' && <input placeholder="显示名称" value={name} onChange={(e) => setName(e.target.value)} />}
        <input type="email" required placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <input type="password" required minLength={6} placeholder="密码（至少 6 位）" value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
        {err && <div className="error">{err}</div>}
        <button className="primary block" disabled={busy}>{mode === 'in' ? '登录' : '注册并登录'}</button>
      </form>
    </AuthShell>
  );
}

export function WorkspacePicker() {
  const workspaces = useStore((s) => s.workspaces);
  const user = useStore((s) => s.user)!;
  const s = useStore.getState();
  const [name, setName] = useState('我的工作空间');
  return (
    <AuthShell>
      <div className="auth-card">
        <div className="brand">你好，{user.display_name}</div>
        {workspaces.length > 0 && (
          <>
            <div className="section-title">选择工作空间</div>
            {workspaces.map((w) => (
              <button key={w.id} className="ws-item" onClick={() => s.openWorkspace(w.id)}>
                <span>{w.name}</span> <span className="role-tag">{ROLE_LABEL[w.role]}</span>
              </button>
            ))}
            <hr />
          </>
        )}
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) s.createWorkspace(name.trim()); }}>
          <div className="section-title">新建工作空间</div>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary block">创建</button>
        </form>
        <button className="link" onClick={() => s.signOut()}>退出登录</button>
      </div>
    </AuthShell>
  );
}
