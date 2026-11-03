# Recovering deleted files

Use a file's **Move to Trash** menu item. Open **File Trash** beside the file-tree upload/add controls, including when the project has no active files. Trash lists the path, deletion time and file type. Restore to the original path or enter another relative path when it is occupied. Refresh Trash to see changes by other account members.

Files remain in Trash until explicitly deleted forever. They still count toward the existing 500-file and 20 MiB project storage limits. Exported JSON/ZIP archives and compilation include only active files. There is no automatic expiry or scheduled purge. Deleting a whole project still permanently removes the project and its files.

In account projects, owners and editors can view Trash, move files there and restore them. Only owners can permanently delete trashed files. Viewers cannot access Trash. Restore preserves the file ID, text/binary content, encoding, MIME type, saved text revisions, discussions and CRDT state, and creates a new file version. Text history records moving to Trash and restoring from it. Trashed documents reject edits, history restoration, comment access and collaboration; recovery drafts never implicitly restore deleted files. Unsaved drafts from a removed collaborative document remain available through account draft recovery/download controls.

Permanent deletion requires a confirmation and removes the file with its saved revisions and discussions. Both restoration and permanent deletion compare the current version; conflicts leave the retained file intact. Active files cannot be purged through the Trash endpoint.

Browser-local Trash retains full files in the browser's separate local-workspace storage and survives reloads. Account Trash contains only transient metadata in the browser and is cleared when changing workspace/account; account content is never copied into local-project persistence. Local Trash does not add server history or discussions.

## Deployment

Apply the Prisma migration before starting the updated API:

```sh
npm run db:generate
# In apps/api with the deployment DATABASE_URL configured:
npx prisma migrate deploy
```

The migration adds `File.deletedAt`, replaces the all-files path constraint with a partial unique index for active paths, and extends text-revision reasons. A trashed path can be reused by a new active file; restoration checks both equal and ancestor/descendant path conflicts under the shared project queue and transactional project-row lock. Storage quota reads include active and trashed files.

Focused checks: `apps/api/tests/trash.test.ts` uses a dedicated migrated PostgreSQL database ending in `_test`; `tests/trash.spec.ts` checks local text/binary retention, reload, collision rename, and active-only JSON/ZIP exports.
