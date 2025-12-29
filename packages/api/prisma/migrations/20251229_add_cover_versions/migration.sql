-- AlterTable: Remove unique constraint from articleId to allow multiple covers per article
ALTER TABLE "CoverImage" DROP CONSTRAINT IF EXISTS "CoverImage_articleId_key";

-- AlterTable: Add version and isSelected fields
ALTER TABLE "CoverImage" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CoverImage" ADD COLUMN IF NOT EXISTS "isSelected" BOOLEAN NOT NULL DEFAULT false;
