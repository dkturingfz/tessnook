// 备份的导出与导入流程：只依赖后端契约（Repo），因此对任何后端实现都适用。
import type { ID } from '../domain/types';
import { buildBackup, planImport, validateBackup, type Backup } from '../domain/backup';
import type { Repo } from '../data/repo';

const CHUNK = 500;

export async function exportBackup(repo: Repo, workspaceId: ID): Promise<Backup> {
  return buildBackup(await repo.loadSnapshot(workspaceId));
}

/**
 * 把备份导入为一个新的工作空间，返回新空间 id。
 * 按依赖顺序分批插入；任一步失败会删除这个未完成的新空间，不留下半成品。
 */
export async function importBackup(
  repo: Repo, backup: Backup, opts: { userId: ID; name: string; onProgress?: (done: number, total: number) => void },
): Promise<ID> {
  const problem = validateBackup(backup);
  if (problem) throw new Error(problem);
  const ws = await repo.createWorkspace(opts.name);
  try {
    // 新空间自带一个默认区域；导入的内容自带区域，先移除默认的
    for (const r of (await repo.loadSnapshot(ws.id)).regions) await repo.deleteRegion(r.id);
    const steps = planImport(backup, { workspaceId: ws.id, userId: opts.userId, newId: () => crypto.randomUUID() });
    const total = steps.reduce((n, s) => n + s.rows.length, 0);
    let done = 0;
    for (const step of steps) {
      for (let i = 0; i < step.rows.length; i += CHUNK) {
        const chunk = step.rows.slice(i, i + CHUNK);
        await repo.insertMany(step.table, chunk as any);
        done += chunk.length;
        opts.onProgress?.(done, total);
      }
    }
    return ws.id;
  } catch (e) {
    await repo.deleteWorkspace(ws.id).catch(() => undefined);
    throw e;
  }
}
