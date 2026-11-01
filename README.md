# Latex-free

An open LaTeX workspace, built with Next.js, Express, PostgreSQL, Prisma, Better Auth, and Zustand.

## What works today

- Responsive dashboard with grid/list views, search, sorting, starred projects, rename, and delete.
- Blank, article, resume, and report starter templates.
- CodeMirror LaTeX editor, file creation, document outline, line wrapping, source downloads, and JSON project backups.
- A local workspace persisted through Zustand in this browser. It works without a running API or Google credentials.
- A separate account workspace backed by authenticated Express APIs and PostgreSQL. Better Auth handles Google OAuth and sessions. The API enforces membership, roles, write origins, and optimistic file versions.

PDF compilation, live collaboration, invitations, comments, history, MCP, AI, binary asset uploads, and backup imports are not implemented yet. The PDF pane explicitly shows that compilation is not connected. Thumbnail pages are template illustrations, not rendered PDFs.

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

To run the complete foundation:

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

Local projects and account projects are separate; signing in does not upload local documents. Local drafts persist automatically. Account drafts require Save or Ctrl/Cmd+S, and are held in memory until saved. The editor warns before closing a tab with unsaved account changes. Version conflicts reject the save rather than overwrite a newer version; download your draft before reloading to resolve a conflict.

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

The browser suite checks local creation, editing, reload persistence, export, organization, deletion, and mobile navigation. Tests use Chromium via Playwright. Google provider redirects are a separate manual check requiring valid OAuth credentials.

## Structure

```text
apps/web       Next.js, shadcn/ui, CodeMirror, Zustand
apps/api       Express, Better Auth, Prisma schema and initial migration
packages/shared  Input schemas, API types, LaTeX templates
```

Zustand owns project data and draft updates. Better Auth owns authentication/session state. Transient component state (dialogs and form fields) stays in React. Only local projects are persisted to browser storage; account projects are not mixed into the local workspace.

The UI components in `apps/web/src/components/ui` come from the official shadcn/ui new-york-v4 registry; the upstream MIT license is included. Kitchen special components are pending access to https://www.dqnamo.com/kitchen so their actual API and license can be verified. No components are attributed to Kitchen yet.

## Cloud environment notes

The current environment blocks `binaries.prisma.sh` and the requested documentation sites. Add/review those domains in environment settings; draft additions have been saved. Standard Prisma CLI generation and migration commands need its verified engine downloads. Do not bypass checksums or TLS checks.

For this session, the Prisma client was generated using matching official Prisma packages and their bundled WASM schema tooling, installed outside the checkout. The SQL migration was applied to a dedicated test database with `psql`, and the account API was validated against it. This does not establish that the normal Prisma CLI migration flow works in this environment yet. The standard commands above remain the intended reproducible setup after network access is enabled.

Deployment, compiler infrastructure, production database hosting, backups, and capacity planning are deferred. The current list API loads full project text and is intended for this initial milestone; pagination and on-demand file loading belong before large account workloads.
