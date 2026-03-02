-- Migration: remove base64 data from CoverImage.originalImageUrl
-- Old code stored the full JPEG as data:image/jpeg;base64,... (1-4 MB per row)
-- This bloated PostgreSQL volume from expected ~100 MB to 2-4 GB.
-- After this migration, new covers store only the file path (/covers/filename.jpg).

UPDATE "CoverImage"
SET "originalImageUrl" = '/covers/legacy_cover_' || id || '.jpg'
WHERE "originalImageUrl" LIKE 'data:image/%';
