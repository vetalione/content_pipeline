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

  // Create data URL for storage
  const imageUrl = `data:image/jpeg;base64,${result.imageBase64}`;

  // Save or update cover image in database
  const existingCover = await prisma.coverImage.findFirst({
    where: { articleId }
  });

  let coverImage;
  if (existingCover) {
    // Update existing cover
    coverImage = await prisma.coverImage.update({
      where: { id: existingCover.id },
      data: {
        originalImageUrl: imageUrl,
        localPath: result.imagePath || `/covers/${articleId}.jpg`,
        template
      }
    });
  } else {
    // Create new cover
    coverImage = await prisma.coverImage.create({
      data: {
        articleId,
        originalImageUrl: imageUrl,
        localPath: result.imagePath || `/covers/${articleId}.jpg`,
        template
      }
    });
  }
  
  // Update article stage to PUBLISHING (only if not already there or beyond)
  const currentStage = article.currentStage;
  if (currentStage === PipelineStage.GENERATION || currentStage === PipelineStage.COVER) {
    await prisma.article.update({
      where: { id: articleId },
      data: {
        currentStage: PipelineStage.PUBLISHING,
        updatedAt: new Date()
      }
    });
  }
  
  console.log(`✅ Cover generated for ${article.celebrityName}`);
  
  return {
    success: true,
    coverImage: {
      ...coverImage,
      imageBase64: result.imageBase64,
    }
  };
}
