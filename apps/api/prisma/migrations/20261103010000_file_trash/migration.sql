ALTER TABLE "File" ADD COLUMN "deletedAt" TIMESTAMP(3);
DROP INDEX "File_projectId_path_key";
CREATE UNIQUE INDEX "File_projectId_path_live_key" ON "File"("projectId", "path") WHERE "deletedAt" IS NULL;
CREATE INDEX "File_projectId_deletedAt_idx" ON "File"("projectId", "deletedAt");
ALTER TABLE "FileRevision" DROP CONSTRAINT "FileRevision_reason_check";
ALTER TABLE "FileRevision" ADD CONSTRAINT "FileRevision_reason_check" CHECK ("reason" IN ('create','baseline','edit','rename','restore','collaboration','trash','trash-restore'));
