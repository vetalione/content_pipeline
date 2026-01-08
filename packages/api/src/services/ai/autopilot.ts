/**
 * Autopilot - Runs the full content pipeline automatically
 * 1. Research (facts + quotes + visualSuggestions)
 * 2. Generate article (sections)
 * 3. Find images for each SECTION in the generated article
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
    
    emit('research', 20, 'Исследование завершено, найдены факты и цитаты');

    // ============ STAGE 2: GENERATE ARTICLE ============
    emit('generation', 25, 'Генерируем статью...');
    
    await prisma.article.update({
      where: { id: articleId },
      data: { currentStage: PipelineStage.GENERATION }
    });

    const { generateContent } = await import('./generator');
    await generateContent(articleId);
    
    emit('generation', 40, 'Статья сгенерирована');

    // ============ STAGE 3: FIND IMAGES FOR SECTIONS ============
    emit('images', 45, 'Подбираем изображения для секций статьи...');

    // Reload article to get generated content and research data
    const articleWithContent = await prisma.article.findUnique({
      where: { id: articleId }
    });
    
    const content = articleWithContent?.content as any;
    const researchData = articleWithContent?.researchData as any;
    const sections = content?.sections || [];
    const facts = researchData?.facts || [];
    
    if (sections.length > 0) {
      const { findFactImage } = await import('../media/google-images');
      
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const progressPercent = 45 + Math.round((i / sections.length) * 35);
        
        emit('images', progressPercent, `Подбираем изображение ${i + 1}/${sections.length}: ${section.title.substring(0, 40)}...`);
        
        try {
          // Find matching fact by similar title to get visualSuggestion
          const matchingFact = facts.find((f: any) => 
            !f.isDeleted && (
              f.title.toLowerCase().includes(section.title.toLowerCase().substring(0, 20)) ||
              section.title.toLowerCase().includes(f.title.toLowerCase().substring(0, 20))
            )
          );
          
          // Build visual suggestion from fact or section context
          const visualSuggestion = matchingFact?.visualSuggestion || 
            `${article.celebrityName} - ${section.title}`;
          
          // Extract year from fact or section
          const year = matchingFact?.year || section.year || '';
          
          const imageUrl = await findFactImage(
            article.celebrityName,
            section.title,
            year,
            visualSuggestion,
            undefined,
            { confidenceThreshold: 65, resultsPerSource: 5 }
          );
          
          if (imageUrl) {
            // Update section with image
            sections[i] = { ...section, imageUrl };
            
            // Save updated content
            await prisma.article.update({
              where: { id: articleId },
              data: {
                content: { ...content, sections }
              }
            });
          }
        } catch (imgError) {
          console.error(`Failed to find image for section ${i + 1}:`, imgError);
          // Continue with other sections
        }
      }
      
      const sectionsWithImages = sections.filter((s: any) => s.imageUrl).length;
      console.log(`📸 Found images for ${sectionsWithImages}/${sections.length} sections`);
    }
    
    emit('images', 80, 'Изображения подобраны');

    // ============ STAGE 4: GENERATE COVER ============
    emit('cover', 85, 'Генерируем обложку...');
    
    await prisma.article.update({
      where: { id: articleId },
      data: { currentStage: PipelineStage.COVER }
    });

    const { generateCover } = await import('../media/cover');
    await generateCover(articleId, 'celebrity');
    
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
