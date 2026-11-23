# Tessnook 架构：后端无关的分层设计

**原则**：Tessnook 的业务模型、画布组件和看板逻辑独立于 Supabase。Supabase 只是 V1 的一个后端实现。系统通过清晰的数据访问接口（后端契约），保留将来切换数据库服务或自建后端的能力。

## 分层与依赖方向

```
            ┌────────────────────────────────────────────┐
            │  main.tsx（组合根：唯一选择后端实现的地方）    │
            └───────────────┬───────────────┬────────────┘
                            │ 注入            │ createRepo(config)
                            ▼               ▼
 canvas/ board/ components/ ──► store/ ──► data/repo.ts（后端契约：接口 + 错误类型）
            │                    │              ▲            ▲
            └──────────┬─────────┘              │ implements │ implements
                       ▼               data/local/        data/supabase/
                   domain/              （浏览器）          （Supabase SDK）
       （类型、布局算法、业务规则；不依赖任何东西）
```

| 层 | 目录 | 职责 | 允许依赖 |
|---|---|---|---|
| 业务模型 | `src/domain` | 实体类型、布局算法（象限判定、网格整理、排序键、卡片堆展开）、业务规则（权限矩阵 `can()`、堆叠约束 `validateStack()`） | 无 |
| 后端契约 | `src/data/repo.ts` | `Repo` 接口（Auth / Workspace / Member / Record / Command / Realtime 六个端口）、`ConflictError` / `PermissionError`、`BackendInfo` | domain |
| 后端实现 | `src/data/local`、`src/data/supabase` | 实现 `Repo`，把各自的错误映射到契约错误 | domain、契约 |
| 组合根 | `src/data/index.ts`、`src/main.tsx` | 根据配置动态加载一个实现并注入 store | 全部 |
| 状态 | `src/store` | 乐观更新、串行写队列、实时合并、冲突回退、快照校准 | domain、契约 |
| 画布 / 看板 / 界面 | `src/canvas`、`src/board`、`src/components` | React Flow 适配、Trello 式看板、对话框 | domain、store |

界面根据 `BackendInfo.storage`（数据保存在 `browser` 还是 `cloud`）显示提示，而不是根据后端厂商。

## 这些约束如何被保证

1. **架构测试** `tests/architecture.test.ts`：扫描源码的 import 关系，违反下列任何一条就让测试失败。
   - domain 不依赖任何模块或第三方包；
   - 只有 `data/supabase` 可以引用 `@supabase/*`；
   - 具体实现只能由组合根加载，实现之间互不依赖；
   - 画布、看板、界面组件不直接访问数据层；
   - store 只依赖 `data/repo`；
   - 这些层的源码中不出现后端厂商名称。
2. **后端契约测试** `tests/contract/repoContract.ts`：同一组行为测试同时运行在每个实现上，覆盖版本冲突、事务命令、堆叠规则、级联删除、权限矩阵、邀请、实时推送与在线状态。它既是测试，也是"实现一个新后端需要满足什么"的可执行规范。
   - `npm test` 总会对本地实现运行；
   - `npm run test:contract:supabase` 会对真实的 Supabase 项目运行同一组测试。
3. **打包隔离**：后端实现通过动态 `import()` 加载。云端构建时 Supabase SDK 位于独立的 chunk 中；本地构建完全不包含它。

## 接入一个新后端（例如自建 API 服务）

1. 新建 `src/data/<name>/<name>Repo.ts`，实现 `Repo` 接口。
2. 按 `src/data/repo.ts` 顶部的语义要求实现：
   - 版本递增与 `ConflictError`；
   - 按 `domain/rules.ts` 在服务端执行权限并抛出 `PermissionError`；
   - 命令的事务性，并返回 `ChangeSet`；
   - 禁止跨工作空间引用；
   - 实时推送，以及可能漏消息时调用 `onResync`。
3. 在 `src/data/index.ts` 的 `createRepo()` 中根据配置加载它。
4. 仿照 `tests/contract/supabase.contract.test.ts` 新建一个契约测试入口，直到全部通过。
5. 数据迁移：所有实体都是普通的、带 `workspace_id` 和 `version` 的记录，可以通过 `loadSnapshot` 导出、再通过新后端导入。

不需要修改 domain、canvas、board、components 或 store。

## 关于字段命名

实体字段使用 snake_case（如 `workspace_id`、`archived_at`）。这是 Tessnook 业务模型自己的命名约定，不是 Supabase 的要求，任何后端都可以直接使用。由于它与常见的 SQL 列名一致，自建的 SQL 后端也不需要做字段映射。

## Supabase 实现的特有部分

以下内容只存在于 `supabase/` 和 `src/data/supabase/` 中：
- 表结构与复合外键；
- RLS 策略与表级授权；
- 触发器（版本号、修订号、活动记录）；
- 事务性 RPC；
- Realtime 发布。

`scripts/verify-supabase.mjs` 额外检查只能在数据库层面验证的安全细节，例如未登录用户不能访问、邀请凭证只保存哈希。
