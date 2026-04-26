-- AlterTable: Add articleStyle field for narrative style preset
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "articleStyle" TEXT NOT NULL DEFAULT 'basic';
