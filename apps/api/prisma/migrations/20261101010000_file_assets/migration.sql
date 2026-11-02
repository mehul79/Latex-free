ALTER TABLE "File" ADD COLUMN "encoding" TEXT NOT NULL DEFAULT 'utf8', ADD COLUMN "mimeType" TEXT;
ALTER TABLE "File" ADD CONSTRAINT "File_encoding_check" CHECK ("encoding" IN ('utf8', 'base64'));
