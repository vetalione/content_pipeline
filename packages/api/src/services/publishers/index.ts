import { Platform, Language } from '@content-pipeline/shared';

// Central playwright-driven publisher (all platforms use browser automation)
import { publishWithPlaywright } from './playwright';
import { prisma } from '../../lib/db';

export async function publishArticle(articleId: string, platform: Platform) {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    include: { coverImage: true }
  });

  if (!article) throw new Error('Article not found');

  // Use playwright-based publisher for all platforms
  return await publishWithPlaywright(platform, article as any);
}

// helper: determine platforms for a language (used elsewhere)
export const platformsForLanguage = (lang: Language): Platform[] => {
  if (lang === Language.RU) return [Platform.DZEN as any, Platform.VK, Platform.TELEGRAM];
  if (lang === Language.EN) return [Platform.YOUTUBE, Platform.THREADS, Platform.INSTAGRAM];
  return [Platform.DZEN as any, Platform.VK, Platform.TELEGRAM, Platform.YOUTUBE, Platform.THREADS, Platform.INSTAGRAM];
};
