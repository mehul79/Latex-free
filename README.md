# Latex-free

An open LaTeX workspace, built with Next.js, Express, PostgreSQL, Prisma, Better Auth, and Zustand.

## What works today

- Responsive dashboard with grid/list views, search, sorting, starred projects, rename, and delete.
- Blank, article, resume, and report starter templates.
- CodeMirror LaTeX editor, nested file paths, rename/move/delete, binary uploads, document outline, line wrapping, source downloads, and ZIP/JSON project import and export.
- A local workspace persisted through Zustand in this browser. It works without a running API or Google credentials.
- A separate account workspace backed by authenticated Express APIs and PostgreSQL. Better Auth handles Google OAuth and sessions. The API enforces membership, roles, write origins, and optimistic file versions.
- Optional self-hosted compilation through an isolated TeX Live container, with compiler/entry-file controls, error logs, and a PDF.js preview.
- Account project sharing with existing Google-linked accounts, owner-managed editor/viewer roles, and read-only viewer access.
- Saved text-file history with snapshot previews and downloads. Owners and editors can restore a snapshot as a new version; restores keep the current file path.

- Live account collaboration through Yjs, with concurrent editing, retained offline drafts, reconnect synchronization, and live access revocation.
- Account text-file discussions with replies, resolve/reopen, author or owner moderation, viewer read-only access, and bounded pagination. Use Refresh comments to see other members’ replies. Optional selection anchors are supported by the API; the current UI creates file discussions.
- Personal access tokens created and revoked in Account settings. Tokens restrict MCP tools by project, permission, and expiration; versioned MCP edits reach live collaborators.

AI assistance is paused at the user’s request; its prototypes remain unfinished and are not active. Invitation emails and interactive SyncTeX navigation are not implemented. Compiler SyncTeX artifacts are available for download. Deleted text and binary files can be restored from [File Trash](docs/file-trash.md), including their account history and discussions; owners can permanently purge trashed files. Dashboard thumbnail pages are template illustrations; the editor preview renders compiled PDFs.

## Local development

Requires Node.js 22.12+ (Node 24 recommended), npm, and Docker Compose. Use the existing checkout; each cloud task is already isolated and does not need another Git worktree.

```bash
npm ci
npm run db:generate
npm run build -w @latex-free/shared
```

For the frontend alone:

```bash
npm run dev -w @latex-free/web
```

To run the web app and account API:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# Set BETTER_AUTH_SECRET to the output of: openssl rand -base64 32
# Edit the API .env; do not commit it.
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Next.js runs on port 3000 and Express on port 4000. Use `localhost` consistently for cookie-based development. The database's example credentials and loopback binding are for local development only. Compose retains the database in a named volume. Do not delete that volume if you want to keep your data.

### Google sign-in

Create a Google OAuth web client and configure:

- Authorized JavaScript origin: `http://localhost:3000`
- Authorized redirect URI: `http://localhost:4000/api/auth/callback/google`
- API environment: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

Restart Express after changing credentials. No passwords or development login bypasses are enabled. Without Google configuration, the UI explains that sign-in is unavailable and the local workspace still works. API health and provider availability are exposed at `/api/health` and `/api/config`.

Local projects and account projects are separate; signing in does not upload local documents. Local drafts persist automatically. Account drafts save automatically after a short idle period; Save or Ctrl/Cmd+S also flushes changes. Recovery drafts remain in this browser until a save succeeds or you explicitly discard them. The editor warns before closing a tab with unsaved account changes. Version conflicts reject the save rather than overwrite a newer version; download your draft before reloading to resolve a conflict.

### Browser offline compiler

The editor can prepare a pinned browser pdfLaTeX engine (~137 MB) and compile current files without the API or network while the editor stays open. See [browser compilation setup, limits and licenses](docs/offline-compiler.md). Its preparation button adapts the ISC-licensed DynamicButton; see [UI attribution](docs/ui-attribution.md). Web development/build scripts install and verify the generated engine assets automatically.

### Optional local compiler

The API and web app work without a compiler. To enable compilation, first build the TeX image and configure the worker:

```bash
docker build -t latex-free-tex:local apps/compiler
cp apps/compiler/.env.example apps/compiler/.env
# Generate a worker token with: openssl rand -base64 32
# Set WORKER_TOKEN in apps/compiler/.env.
# Set the same value as COMPILER_TOKEN in apps/api/.env.
# Set COMPILER_URL=http://127.0.0.1:4100 in apps/api/.env.
npm run dev:compiler
```

Restart the API after configuring it. The worker listens on loopback port 4100 and uses Docker to start a fresh TeX container for each job. Containers have no network, a read-only root filesystem, dropped capabilities, disabled shell escape, and CPU, memory, process, output, and time limits. The trusted worker requires host Docker access; do not give the API or browser access to the Docker socket. `WORKER_TOKEN` must be at least 32 characters; keep it out of tracked files.

Account compilation requires an authenticated session and compiles the submitted project snapshot. To compile browser-local projects during development, explicitly set `ENABLE_LOCAL_COMPILE=true` in the API environment. This enables anonymous local compile requests and should stay disabled for a public deployment unless an appropriate abuse-control layer is added. The worker's `GET /health` endpoint reports availability; `POST /compile` requires the bearer token. The API exposes its compiler availability through `/api/config`.

Project files use relative paths. Folders are derived from file paths and disappear when their last file is deleted. Uploads and archives preserve binary assets. Imports reject unsafe paths and unsupported archives, and enforce up to 500 files, 20 MiB total unpacked content, 1 MB per text file, and 5 MiB per binary asset. ZIP exports contain the project files; JSON backups also retain project metadata. Keep backups outside browser storage when the documents matter.

### Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The integration suite uses real PostgreSQL and signed Better Auth session cookies. Give it a **dedicated database ending in `_test`** and apply the migration first:

```bash
docker compose exec postgres createdb -U latex latex_free_test
cd apps/api
DATABASE_URL=postgresql://latex:latex@localhost:5432/latex_free_test npx prisma migrate deploy
cd ../..
TEST_DATABASE_URL=postgresql://latex:latex@localhost:5432/latex_free_test npm run test:integration
```

Start the frontend before browser tests:

```bash
npm run dev -w @latex-free/web
# In another terminal, with Chromium installed:
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

The browser suite checks local creation, editing, reload persistence, export, organization, deletion, nested files, asset preservation across archive imports, and mobile navigation. Tests use Chromium via Playwright. Google provider redirects are a separate manual check requiring valid OAuth credentials. With the API, worker, and TeX image running, set `RUN_COMPILER_E2E=1` to include the real compile, PDF rendering, entry-file selection, and mobile preview check. Run `npm run test:integration -w @latex-free/compiler` for the Docker-backed compiler suite.

With the migrated API and frontend running, `RUN_ACCOUNT_E2E=1 npm run test:e2e -- --grep 'account sharing'` enables the account browser check. It reads the API's local `.env` configuration and creates unique temporary Google-linked accounts and signed Better Auth sessions in that configured database, then deletes its own fixtures. It checks sharing roles, viewer restrictions, editor autosave, and history restore. This session-fixture check does not exercise the Google OAuth redirect or consent flow.

## Structure

```text
apps/web       Next.js, shadcn/ui, CodeMirror, Zustand
apps/api       Express, Better Auth, Prisma schema and migrations
apps/compiler  Trusted Node worker and isolated TeX Live image
packages/shared  Input schemas, API types, LaTeX templates
```

Zustand owns project data and draft updates. Better Auth owns authentication/session state. Transient component state (dialogs and form fields) stays in React. Only local projects are persisted to browser storage; account projects are not mixed into the local workspace.

The existing shadcn/ui components in `apps/web/src/components/ui` come from the official new-york-v4 registry and retain the included upstream MIT license. The offline preparation control adapts DynamicButton from the Kitchen catalog’s linked dqnamo/website source under ISC; its pinned provenance and separate license notice are documented in [UI attribution](docs/ui-attribution.md).

## Operational scope

Standard Prisma generation and migration commands are supported; no manual client-generation workaround is needed. Production deployment, database hosting, durable artifact storage, automated backups, queueing, and capacity planning remain deployment work. The current list API loads full project content; pagination and on-demand loading should precede large account workloads.

For focused account browser checks, run `RUN_ACCOUNT_E2E=1 npx playwright test tests/collaboration.spec.ts`, `tests/mcp-account.spec.ts`, or `tests/comments.spec.ts` individually with the migrated API and web app running. These cases create and clean up their own signed account fixtures; they do not exercise Google OAuth consent. The comments API security check is `TEST_DATABASE_URL=postgresql://latex:latex@localhost:5432/latex_free_test npx vitest run --config vitest.integration.config.ts tests/comments.test.ts` from `apps/api`, using a dedicated migrated test database.
