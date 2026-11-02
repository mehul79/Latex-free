CREATE TABLE "FileRevision" (
  "id" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "authorId" TEXT,
  "version" INTEGER NOT NULL,
  "path" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "reason" TEXT NOT NULL CHECK ("reason" IN ('create','baseline','edit','rename','restore')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FileRevision_fileId_version_key" ON "FileRevision"("fileId", "version");
CREATE INDEX "FileRevision_fileId_createdAt_idx" ON "FileRevision"("fileId", "createdAt");
ALTER TABLE "FileRevision" ADD CONSTRAINT "FileRevision_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FileRevision" ADD CONSTRAINT "FileRevision_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
