# Agent guide

Latex-free is a free, open LaTeX workspace inspired by Overleaf. Free collaboration is a product goal; do not promise unlimited operational capacity. Use [README.md](README.md) for setup, environment variables, detailed commands, and verified feature scope. Read any directory-specific `AGENTS.md` before editing there.

## Working preferences

- Work sequentially on one feature at a time. Use one executor by default; do not spawn extra agents unless the user requests parallel work.
- Keep changes small and reviewable. Use the existing checkout; cloud tasks are already isolated and do not need another worktree.
- Run focused checks appropriate to the changed behavior. Avoid broad or repeated integration runs unless a failure or shared change justifies them. Documentation-only changes need formatting and diff checks, not application tests.
- Hydration work is deferred at the user's request. Do not resume it without a new instruction.
- AI assistance is paused. Preserve unfinished prototypes without activating or developing them.
- Where model selection is available, use GPT-6.1 Sol (`gpt-6.1-sol`): high reasoning for planning, medium or low for implementation. Simple documentation edits do not need extra agents or extra-high reasoning.

## Current architecture

| Area                   | Implementation                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Web                    | Next.js, TypeScript, shadcn/ui, CodeMirror 6, PDF.js                                                 |
| API and authentication | Express, Better Auth with Google OAuth                                                               |
| Database               | PostgreSQL with Prisma                                                                               |
| Workspace state        | Zustand; browser-persisted local projects and separate account state                                 |
| Collaboration          | Yjs + Hocuspocus, owned by one API process                                                           |
| File storage           | Bounded text and base64-encoded binary assets in PostgreSQL                                          |
| Compilation            | Synchronous API request to a separate trusted Node worker, which runs TeX Live + `latexmk` in Docker |

There is no S3/object-storage backend, Redis job queue, or horizontally distributed collaboration authority. Do not assume those services exist.

```text
apps/web/src/app          Next.js routes
apps/web/src/components   Editor, dashboard, sharing, history, comments, UI
apps/web/src/stores       Workspace, comments, tokens, project details
apps/web/src/hooks        Collaboration lifecycle
apps/api/src              Express routes, auth, project/document services, collaboration
apps/api/src/mcp          MCP server, token authorization, compile integration
apps/api/src/comments     Discussions and optional anchors
apps/api/prisma           Database schema and migrations
apps/compiler/src         Trusted worker, sandbox orchestration, diagnostics
packages/shared/src       Validation, API types, templates
tests                     Browser checks
```

The paused prototypes are under `apps/api/src/ai`, `apps/api/src/resume`, and `apps/api/src/research`; their presence does not make AI an active feature.

## Implemented behavior

- Dashboard grid/list views, search, sorting, stars, rename/delete, and blank/article/resume/report templates.
- CodeMirror editing, nested file trees, rename/move/delete, binary assets, outline, source downloads, and ZIP/JSON import/export.
- Browser-local workspace independent of the API; separate authenticated account workspace with offline drafts, reconnect synchronization, and recovery controls.
- Live account collaboration and cursors; owner/editor/viewer sharing with existing Google-linked accounts and live access revocation.
- Immutable saved text revisions, previews/downloads, and restore as a new version at the current path. Deleted files can be recovered through File Trash, preserving identity, history, comments and CRDT state; permanent purge requires the owner.
- Text-file discussions, replies, resolve/reopen, moderation, and viewer read-only access. The UI creates file discussions and requires manual **Refresh comments** for other members' replies; optional selection anchors exist in the API.
- Optional server compilation with pdfLaTeX, XeLaTeX, or LuaLaTeX; PDF.js preview, parsed logs, and downloadable SyncTeX artifacts. Browser pdfLaTeX supports compilation in the current open editor after explicitly preparing a pinned ~137 MB basic TeX Live pack; see `docs/offline-compiler.md` for hosting, limits and licenses. Interactive SyncTeX navigation is deferred.
- Remote MCP with ten tools: `list_projects`, `list_files`, `read_file`, `create_file`, `edit_file`, `write_file`, `delete_file`, `compile`, `get_compile_errors`, and `share_project`. Account settings provide personal access tokens with permission scopes, project restrictions, expiry, and revocation. Versioned MCP edits reach live collaborators.

Dashboard thumbnails are template illustrations; editor previews render compiled PDFs.

## State and mutation rules

- Zustand owns workspace/project state; Better Auth owns sessions. Keep transient dialogs and forms in React state. Never leak account projects or content into local-workspace persistence. Signing in does not upload local projects.
- Route account text mutations, including REST/MCP edits and history restores, through `DocumentService` and its attached collaboration authority. Do not introduce independent Prisma and Yjs write paths that can disagree about document content.
- Preserve the shared per-project mutex in `project-mutex.ts` and transactional project-row locking for authorization. Membership writers and document writers must serialize through the project lock and recheck current roles/revocation inside that lock; connection-time checks alone are insufficient.
- Keep optimistic versions on REST/MCP writes and reject conflicts instead of overwriting newer content. Preserve immutable history snapshots.
- Show **Saved** only after the persistence-barrier acknowledgment confirms the relevant edits reached the database. A Yjs **synced** event alone does not establish durability.
- Preserve offline/recovery drafts until acknowledged or explicitly discarded. Do not add an offline REST fallback around the collaborative write path.
- The current collaboration authority requires one API process. Multiple API replicas need an explicit coordination design before deployment.

## Compiler and security rules

- Self-host TeX Live; do not depend on public compile APIs. Keep the trusted Node worker separate from the API. Never expose the Docker socket to the API or browser.
- Run each TeX job in a fresh container with no network, non-root user, read-only root filesystem, dropped capabilities, no new privileges, and CPU, memory, process, time, and output limits.
- Keep `latexmk -norc`, disabled shell escape, restricted file access, and engine-specific safety flags. Uploaded project files must not supply executable compiler configuration.
- Authenticate API-to-worker requests with matching secret tokens. Keep anonymous local compilation opt-in through `ENABLE_LOCAL_COMPILE=true`; it is disabled by default.
- Preserve source/path/count/byte limits and artifact bounds across uploads, archives, API requests, and worker responses. Current import bounds include 500 files, 20 MiB unpacked total, 1 MB per text file, and 5 MiB per binary asset.
- Never print or commit secrets. Keep actual credentials in ignored `.env`/`.env.local` files and update the relevant `.env.example` when adding configuration.

## Development and verification

Use Node.js 22.12+ (24 recommended), npm workspaces, and Docker Compose for local PostgreSQL. Normal commands from the repository root:

```bash
npm ci
npm run db:generate
npm run build -w @latex-free/shared
npm run dev -w @latex-free/web  # Frontend/local workspace only
docker compose up -d postgres
npm run db:migrate
npm run dev                    # Account API and web
npm run dev:compiler           # Optional configured worker
```

README documents required environment files, compiler image/token setup, and checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:integration`, and `npm run test:e2e`. Select the smallest relevant checks; these are available commands, not a requirement to run every suite on every change. Database integration checks require a dedicated migrated database ending in `_test`. Account browser checks use signed Better Auth fixtures; they do not verify the full Google redirect/consent flow.

Use feature branches and PR merges. Never commit or push directly to `main` unless the user explicitly overrides this rule. Do not commit or push unless requested.

## Deferred scope and limitations

- The full Google OAuth redirect/consent flow remains unverified; signed-session fixture tests do not cover it. Production deployment and a public preview are not configured.
- Object storage, durable artifact storage, automated backups, queueing, capacity planning, and multi-process collaboration need future deployment work. Project listing currently loads full content; larger accounts need pagination/on-demand loading.
- Invitation/notification emails, track changes, and interactive SyncTeX are deferred.
- MCP currently uses personal access tokens; OAuth 2.1 sign-in is future work.
- The compiler preparation control adapts the Kitchen-catalog DynamicButton from pinned dqnamo/website source under ISC; see `docs/ui-attribution.md`. No Kitchen plugin/tool is installed. Verify API and license before using other catalog components. Existing shadcn/ui components include their separate upstream MIT license.
- AI prototypes remain paused and unwired. Do not turn this deferred list into implementation work without the user's direction.
