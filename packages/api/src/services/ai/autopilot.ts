/**
 * Autopilot - Runs the full content pipeline automatically
 * 1. Research (facts + quotes)
 * 2. Find images for each fact
 * 3. Generate article
 * 4. Generate cover
 */

import { prisma } from '../../lib/db';
import { PipelineStage } from '@content-pipeline/shared';

type ProgressCallback = (stage: string, progress: number, message: string) => void;

export async function runAutopilot(
  articleId: string,
  onProgress?: ProgressCallback
): Promise<{ success: boolean; error?: string }> {
  
  const emit = (stage: string, progress: number, message: string) => {
    console.log(`  [${stage}] ${progress}% - ${message}`);
    onProgress?.(stage, progress, message);
  };

  try {
    // Get article
    const article = await prisma.article.findUnique({
      where: { id: articleId }
    });
    
    if (!article) {
      throw new Error('Article not found');
    }

    emit('starting', 0, `Запускаем автопилот для ${article.celebrityName}...`);

    // ============ STAGE 1: RESEARCH ============
    emit('research', 5, 'Начинаем исследование...');
    
    await prisma.article.update({
      where: { id: articleId },
      data: { currentStage: PipelineStage.RESEARCH }
    });

    const { performPerplexityResearch } = await import('./perplexity-research');
    await performPerplexityResearch(articleId, 'normal');
    
    emit('research', 25, 'Исследование завершено, найдены факты и цитаты');

    // ============ STAGE 2: FIND IMAGES ============
    emit('images', 30, 'Подбираем изображения для фактов...');

    // Reload article to get research data
    const articleWithResearch = await prisma.article.findUnique({
      where: { id: articleId }
    });
    
    const researchData = articleWithResearch?.researchData as any;
    const facts = researchData?.facts || [];
    const visibleFacts = facts.filter((f: any) => !f.isDeleted);
    
    if (visibleFacts.length > 0) {
      const { findFactImage } = await import('../media/google-images');
      
      // Find images for first 5 facts (to save time)
      const factsToProcess = visibleFacts.slice(0, 5);
      
      for (let i = 0; i < factsToProcess.length; i++) {
        const fact = factsToProcess[i];
        const progressPercent = 30 + Math.round((i / factsToProcess.length) * 20);
        
        emit('images', progressPercent, `Подбираем изображение ${i + 1}/${factsToProcess.length}: ${fact.title.substring(0, 40)}...`);
        
        try {
          const imageUrl = await findFactImage(
            article.celebrityName,
            fact.title,
            fact.year,
            fact.visualSuggestion,
            undefined, // no progress callback for individual images
            { confidenceThreshold: 70, resultsPerSource: 5 }
          );
          
          if (imageUrl) {
            // Update fact with image
            const updatedFacts = facts.map((f: any) => 
              f.id === fact.id ? { ...f, imageUrl } : f
            );
            
            await prisma.article.update({
              where: { id: articleId },
              data: {
                researchData: { ...researchData, facts: updatedFacts }
              }
            });
            
            // Reload research data for next iteration
            const reloaded = await prisma.article.findUnique({ where: { id: articleId } });
            Object.assign(researchData, reloaded?.researchData);
          }
        } catch (imgError) {
          console.error(`Failed to find image for fact ${fact.id}:`, imgError);
          // Continue with other facts
        }
      }
    }
    
    emit('images', 50, 'Изображения подобраны');

    // ============ STAGE 3: GENERATE ARTICLE ============
    emit('generation', 55, 'Генерируем статью...');
    
    await prisma.article.update({
      where: { id: articleId },
      data: { currentStage: PipelineStage.GENERATION }
    });

    const { generateContent } = await import('./generator');
    await generateContent(articleId);
    
    emit('generation', 75, 'Статья сгенерирована');

    // ============ STAGE 4: GENERATE COVER ============
    emit('cover', 80, 'Генерируем обложку...');
    
    await prisma.article.update({
      where: { id: articleId },
      data: { currentStage: PipelineStage.COVER }
    });

    const { generateCover } = await import('../media/cover');
    await generateCover(articleId, 'celebrity');  // Use default celebrity template
    
    emit('cover', 95, 'Обложка сгенерирована');

    // ============ COMPLETE ============
    await prisma.article.update({
      where: { id: articleId },
      data: { 
        status: 'READY',
        currentStage: PipelineStage.PUBLISHING
      }
    });

    emit('complete', 100, '✅ Автопилот завершён! Статья готова к публикации.');

    return { success: true };

  } catch (error: any) {
    console.error('Autopilot error:', error);
    
    // Update article status to failed
    await prisma.article.update({
      where: { id: articleId },
      data: { status: 'FAILED' }
    }).catch(() => {});
    
    emit('error', 0, `Ошибка: ${error.message}`);
    
    return { success: false, error: error.message };
  }
}
