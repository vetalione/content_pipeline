import path from 'path';
import { prisma } from '../../lib/db';
import { PipelineStage } from '@content-pipeline/shared';
import { generateCoverImage, getCoverPreviewOptions, getAllColorCombinations, CoverGenerationOptions } from './gemini-cover';

export interface CoverOptions {
  heroName?: string;
  title?: string;
  colorScheme?: string;
  icons?: string[];
  sharpFact?: string;
}

/**
 * Get cover options preview for an article
 */
export async function getCoverOptionsPreview(articleId: string) {
  const article = await prisma.article.findUnique({
    where: { id: articleId }
  });
  
  if (!article) {
    throw new Error('Article not found');
  }

  const content = article.content as any;
  const preview = getCoverPreviewOptions(article.celebrityName, content);
  
  return {
    heroName: article.celebrityName,
    title: content?.title || article.celebrityName,
    suggestedColors: preview.suggestedColors,
    allColors: getAllColorCombinations(),
    suggestedIcons: preview.suggestedIcons,
    suggestedFact: preview.suggestedFact,
  };
}

/**
 * Cover image generation service using Gemini Imagen
 */
export async function generateCover(articleId: string, template: string, options?: CoverOptions) {
  console.log(`🎨 Generating cover for article ${articleId} with template ${template}`);
  
  const article = await prisma.article.findUnique({
    where: { id: articleId }
  });
  
  if (!article) {
    throw new Error('Article not found');
  }

  const content = article.content as any;
  
  // Build generation options from article or custom options
  const generationOptions: CoverGenerationOptions = {
    heroName: options?.heroName || article.celebrityName,
    title: options?.title || content?.title || article.celebrityName,
    colorScheme: options?.colorScheme,
    icons: options?.icons,
    sharpFact: options?.sharpFact,
    articleContent: content,
  };

  // Generate cover with Gemini Imagen
  const result = await generateCoverImage(generationOptions);

  if (!result.success) {
    console.error('❌ Cover generation failed:', result.error);
    throw new Error(result.error || 'Failed to generate cover');
  }

  // Store only the file path URL — NOT the full base64 string.
  // Storing base64 in PostgreSQL was bloating the DB by 1-4 MB per cover version
  // and causing massive network egress every time the frontend loaded article data.
  // The file is already saved to disk by gemini-cover.ts; we just reference it.
  const fileName = result.imagePath ? path.basename(result.imagePath) : `cover_${articleId}_v${Date.now()}.jpg`;
  const imageUrl = `/covers/${fileName}`;

  // Get current version number (increment from latest)
  const latestCover = await prisma.coverImage.findFirst({
    where: { articleId },
    orderBy: { version: 'desc' }
  });
  
  const nextVersion = latestCover ? latestCover.version + 1 : 1;

  // Always create a new cover version (never update existing)
  const coverImage = await prisma.coverImage.create({
    data: {
      articleId,
      originalImageUrl: imageUrl,
      localPath: result.imagePath || `/covers/${articleId}_v${nextVersion}.jpg`,
      template,
      version: nextVersion,
      isSelected: false // User will manually select the best one
    }
  });

  console.log(`✅ Cover version ${nextVersion} generated for ${article.celebrityName}`);
  
  return {
    success: true,
    coverImage: {
      ...coverImage,
      imageBase64: result.imageBase64,
    }
  };
}
