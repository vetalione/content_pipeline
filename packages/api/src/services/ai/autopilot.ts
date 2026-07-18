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
  onProgress?: ProgressCallback,
  factSources?: any,
  coverModel?: 'gemini' | 'gemini-pro' | 'openai'
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

    const { performMultiResearch, normalizeFactConfig } = await import('./multi-research');
    const factConfig = normalizeFactConfig({ sources: factSources });
    await performMultiResearch(articleId, 'normal', factConfig);
    
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
      
      // Track already used images to avoid duplicates.
      // Seed with images already assigned to research facts and any existing
      // section images — same rule as the manual re-pick routes, so autopilot
      // can't assign a section the photo a fact is already displaying.
      const usedImageUrls: string[] = [];
      for (const f of facts) {
        if (f?.imageUrl && !f.isDeleted) usedImageUrls.push(String(f.imageUrl));
      }
      for (const s of sections) {
        if (s?.imageUrl) usedImageUrls.push(String(s.imageUrl));
      }
      
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const progressPercent = 45 + Math.round((i / sections.length) * 35);
        
        const sectionTitle = section.heading || section.title || `Секция ${i + 1}`;
        emit('images', progressPercent, `Подбираем изображение ${i + 1}/${sections.length}: ${sectionTitle.substring(0, 40)}...`);
        
        try {
          // Find matching fact by factId (primary) or fallback to title matching
          let matchingFact = null;
          
          // Primary: match by factId from Claude's output
          if (section.factId) {
            matchingFact = facts.find((f: any) => f.id === section.factId && !f.isDeleted);
            if (matchingFact) {
              console.log(`  ✅ Section ${i + 1}: matched by factId "${section.factId}"`);
            }
          }
          
          // Fallback: match by similar title
          if (!matchingFact) {
            matchingFact = facts.find((f: any) => 
              !f.isDeleted && (
                f.title.toLowerCase().includes(sectionTitle.toLowerCase().substring(0, 20)) ||
                sectionTitle.toLowerCase().includes(f.title.toLowerCase().substring(0, 20))
              )
            );
            if (matchingFact) {
              console.log(`  ⚠️ Section ${i + 1}: matched by title similarity to fact "${matchingFact.title}"`);
            }
          }
          
          // Build visual suggestion from fact or section context.
          // When no fact matched, a bare "Name - heading" collapses the query
          // builder to a near-generic query — every such section then gets the
          // SAME candidate pool, which all dedup away and the section stays
          // empty. The section's first paragraph carries the concrete
          // ages/places/events needed for a distinctive query, so feed it in.
          let visualSuggestion = matchingFact?.visualSuggestion;
          if (!visualSuggestion) {
            const paragraph = String(section.paragraph1 || section.content || '').substring(0, 300);
            visualSuggestion = paragraph
              ? `${article.celebrityName}. ${sectionTitle}. ${paragraph}`
              : `${article.celebrityName} - ${sectionTitle}`;
            console.log(`  ℹ️ Section ${i + 1}: no matched fact — using paragraph-based visual suggestion`);
          }

          // Extract year from fact, section, or the section text itself
          // (headings like "В 1923 году студия умерла" carry the year).
          let year: number | undefined = Number(matchingFact?.year || section.year) || undefined;
          if (!year) {
            const yearMatch = `${sectionTitle} ${section.paragraph1 ?? ''}`.match(/\b(18|19|20)\d{2}\b/);
            if (yearMatch) year = parseInt(yearMatch[0], 10);
          }
          
          const imageUrl = await findFactImage(
            article.celebrityName,
            sectionTitle,
            year,
            visualSuggestion,
            undefined,
            { 
              confidenceThreshold: 65, 
              resultsPerSource: 5,
              // Pass already-assigned local paths so findFactImage skips
              // candidates that would resolve to the same cached file
              // (works reliably thanks to content-hashed filenames).
              excludeLocalPaths: usedImageUrls,
            }
          );
          
          if (imageUrl) {
            // Track this URL to avoid reusing
            usedImageUrls.push(imageUrl);
            
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

          // Brief pause between sections so Brave rate-limit queue has room to breathe
          // (Brave Free = 1 req/sec; each section fires 2 Brave calls via the throttle queue)
          if (i < sections.length - 1) {
            await new Promise(r => setTimeout(r, 3000));
          }
        } catch (imgError) {
          console.error(`Failed to find image for section ${i + 1}:`, imgError);
          // Continue with other sections
        }
      }
      
      const sectionsWithImages = sections.filter((s: any) => s.imageUrl).length;
      console.log(`📸 Found images for ${sectionsWithImages}/${sections.length} sections`);

      // ── Block images: "Успех" (conclusion) and "Бонусный факт" ────────────
      emit('images', 78, 'Подбираем изображения для блоков «Успех» и «Бонус»...');

      const conclusionText = String(
        (typeof content?.conclusion === 'object' ? content?.conclusion?.text : content?.conclusion) || ''
      ).substring(0, 200);

      const blockJobs: Array<{ key: 'conclusionImageUrl' | 'bonusFactImageUrl'; title: string; suggestion: string; year?: number }> = [
        {
          key: 'conclusionImageUrl',
          title: 'success triumph',
          suggestion: `${article.celebrityName} at the peak of success: smiling or confident, at an award ceremony, premiere or public triumph, recent years, high-quality photo. ${conclusionText}`,
        },
      ];
      const bonusText = String(content?.bonusFact || '').substring(0, 250);
      if (bonusText) {
        const yearMatch = bonusText.match(/\b(18|19|20)\d{2}\b/);
        blockJobs.push({
          key: 'bonusFactImageUrl',
          title: 'bonus fact',
          suggestion: `${article.celebrityName}. ${bonusText}`,
          year: yearMatch ? parseInt(yearMatch[0], 10) : undefined,
        });
      }

      for (const job of blockJobs) {
        try {
          const imageUrl = await findFactImage(
            article.celebrityName,
            job.title,
            job.year,
            job.suggestion,
            undefined,
            {
              confidenceThreshold: 65,
              resultsPerSource: 5,
              excludeLocalPaths: usedImageUrls,
            }
          );
          if (imageUrl) {
            usedImageUrls.push(imageUrl);
            (content as any)[job.key] = imageUrl;
            await prisma.article.update({
              where: { id: articleId },
              data: { content: { ...content, sections } }
            });
            console.log(`📸 Block image set: ${job.key} → ${imageUrl}`);
          } else {
            console.log(`ℹ️ No image cleared the floor for block ${job.key}`);
          }
          await new Promise(r => setTimeout(r, 3000));
        } catch (blockImgError) {
          console.error(`Failed to find image for block ${job.key}:`, blockImgError);
        }
      }
    }

    emit('images', 80, 'Изображения подобраны');

    // ============ STAGE 4: GENERATE COVER ============
    emit('cover', 85, 'Генерируем обложку...');
    
    await prisma.article.update({
      where: { id: articleId },
      data: { currentStage: PipelineStage.COVER }
    });

    const { generateCover } = await import('../media/cover');
    await generateCover(articleId, 'celebrity', coverModel ? { model: coverModel } : undefined);
    
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
