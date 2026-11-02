ALTER TABLE "File" ADD COLUMN "yState" BYTEA;
ALTER TABLE "FileRevision" DROP CONSTRAINT "FileRevision_reason_check";
ALTER TABLE "FileRevision" ADD CONSTRAINT "FileRevision_reason_check" CHECK ("reason" IN ('create','baseline','edit','rename','restore','collaboration'));
