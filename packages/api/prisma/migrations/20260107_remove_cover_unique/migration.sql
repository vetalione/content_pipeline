-- Remove unique constraint on articleId to allow multiple cover versions per article

-- Drop the unique constraint (Prisma names it CoverImage_articleId_key)
ALTER TABLE "CoverImage" DROP CONSTRAINT IF EXISTS "CoverImage_articleId_key";

-- Also drop by index name in case it's an index
DROP INDEX IF EXISTS "CoverImage_articleId_key";
