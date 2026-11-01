# AGENTS.md

Guidance for AI coding agents working in this repo.

## Project

**Latex-free** is a free, open alternative to Overleaf:

- Sign in with Google
- Create and manage multiple LaTeX projects
- Collaborate in real time with an unlimited number of people
- An Overleaf-style editor with a LaTeX compiler and PDF preview
- An **MCP server** so Claude, ChatGPT and other AI tools can read and edit the files in a user's account
- An in-app **AI agent** for two domains: **Resume** and **Research report**

Status: planning. There is no code yet.

## Proposed stack (defaults, not yet confirmed)

| Area | Choice |
|---|---|
| Language | TypeScript (monorepo) |
| Web app | Next.js, CodeMirror 6, PDF.js |
| Auth | Google OAuth (Auth.js / Better Auth) |
| Real-time collaboration | Yjs + Hocuspocus (WebSocket), with live cursors |
| Database | Postgres (Prisma or Drizzle) |
| File storage | S3-compatible storage (R2 / MinIO) |
| Compile jobs | Redis queue → sandboxed Docker workers |
| Compiler | TeX Live + `latexmk` (pdfLaTeX / XeLaTeX / LuaLaTeX) |
| AI | Claude API by default |

## Compiler rules

- Self-host TeX Live in Docker. Do not depend on public compile APIs.
- Sandbox every compile: no network, no `--shell-escape`, and limits on CPU, memory and time.
- Return the PDF, parsed log errors and SyncTeX data.
- Alternatives considered: Tectonic, SwiftLaTeX / BusyTeX (WebAssembly, possible offline mode later), and Overleaf Community Edition (AGPL, not forked).

## MCP server (planned)

A remote MCP server, authenticated with a personal access token first and OAuth 2.1 later. Tools:
`list_projects`, `list_files`, `read_file`, `create_file`, `edit_file` (find-and-replace),
`write_file`, `delete_file`, `compile`, `get_compile_errors`, `share_project`.
Edits go through Yjs, so collaborators see them live. Each tool must check the user's role on the project.

## AI agent (planned)

The agent uses the same tools as the MCP server and shows every edit as a diff for the user to accept or reject.
- **Resume:** templates, tailoring to a job description, checks that applicant tracking systems can read it, bullet rewrites, fitting the content to one page.
- **Research report:** outlines, real citations from Crossref, arXiv and Semantic Scholar converted to BibTeX, tables and figures, fixing compile errors.

## Roadmap

1. MVP: auth, dashboard, editor, file tree, compile, PDF preview, templates
2. Collaboration: live editing, sharing roles (owner / editor / viewer), comments, history
3. MCP server
4. AI agent
5. Later: track changes, Git sync, SyncTeX, offline WASM compile

## Open questions

Who pays for AI (bring-your-own-key, platform limits, or both) · hosting and budget · storage and compile limits · license · MCP sign-in (tokens or OAuth first) · MVP scope.

## Conventions

- Develop on the assigned feature branch. Never push to `main` directly.
- Keep changes small. Run lint, typecheck and tests before committing.
- Never commit secrets. Use `.env` (gitignored) and keep `.env.example` up to date.
