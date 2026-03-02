/**
 * One-time cleanup script: deletes ALL articles, cover images, publications from the DB
 * and removes cover files from the /covers directory.
 *
 * Run locally (needs DATABASE_URL in env):
 *   cd packages/api && DATABASE_URL="postgresql://..." npx tsx scripts/cleanup-all-articles.ts
 *
 * Run via Railway CLI:
 *   railway run --service hearty-insight npx tsx packages/api/scripts/cleanup-all-articles.ts
 */

import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Starting full database cleanup...\n');

  // Count before deletion
  const [articleCount, coverCount, pubCount] = await Promise.all([
    prisma.article.count(),
    prisma.coverImage.count(),
    prisma.publication.count(),
  ]);

  console.log(`📊 Found in DB:`);
  console.log(`   Articles:     ${articleCount}`);
  console.log(`   Cover images: ${coverCount}`);
  console.log(`   Publications: ${pubCount}\n`);

  if (articleCount === 0) {
    console.log('✅ Database is already empty. Nothing to do.');
    return;
  }

  // Delete all articles — Publication and CoverImage cascade automatically
  const deleted = await prisma.article.deleteMany({});
  console.log(`🗑️  Deleted ${deleted.count} articles (+ all related cover images & publications)\n`);

  // Clean up physical cover files from the Volume (/covers directory)
  const coversDir = path.join(process.cwd(), 'covers');
  try {
    const files = await fs.readdir(coversDir);
    const jpgFiles = files.filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png'));
    
    if (jpgFiles.length === 0) {
      console.log('📁 /covers directory is empty, nothing to delete.');
    } else {
      for (const file of jpgFiles) {
        await fs.unlink(path.join(coversDir, file));
      }
      console.log(`🗑️  Deleted ${jpgFiles.length} cover files from /covers/`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      console.log('📁 /covers directory does not exist, skipping file cleanup.');
    } else {
      console.warn('⚠️  Could not clean /covers directory:', err.message);
    }
  }

  // Verify
  const remaining = await prisma.article.count();
  console.log(`\n✅ Cleanup complete! Articles remaining in DB: ${remaining}`);
}

main()
  .catch(err => {
    console.error('❌ Cleanup failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
