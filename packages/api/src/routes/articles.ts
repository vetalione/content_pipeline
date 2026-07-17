import { Router } from 'express';
import { prisma } from '../lib/db';
import { Article, ArticleStatus, PipelineStage } from '@content-pipeline/shared';
import { searchGoogleImages, findFactImage, downloadAndCacheImage, type ScoredImageCandidate } from '../services/media/google-images';
import { getIO } from '../lib/socket';

export const articlesRouter = Router();

// Get all articles
articlesRouter.get('/', async (req, res, next) => {
  try {
    const { status, stage, page = 1, pageSize = 20 } = req.query;
    
    const where: any = {};
    if (status) where.status = status;
    if (stage) where.currentStage = stage;
    
    const skip = (Number(page) - 1) * Number(pageSize);
    const take = Number(pageSize);
    
    const [articles, total] = await Promise.all([
      prisma.article.findMany({
        where,
        include: {
          coverImages: {
            orderBy: { generatedAt: 'desc' },
            take: 1 // Only latest for list view
          },
          publications: true
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.article.count({ where })
    ]);
    
    res.json({
      success: true,
      data: articles,
      total,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(total / Number(pageSize))
    });
  } catch (error) {
    next(error);
  }
});

// Get single article
articlesRouter.get('/:id', async (req, res, next) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.id },
      include: {
        coverImages: {
          orderBy: { generatedAt: 'desc' }
        },
        publications: true
      }
    });
    
    if (!article) {
      return res.status(404).json({
        success: false,
        error: 'Article not found'
      });
    }
    
    res.json({ success: true, data: article });
  } catch (error) {
    next(error);
  }
});

// Create new article
articlesRouter.post('/', async (req, res, next) => {
  try {
    const { celebrityName, language, articleStyle } = req.body;
    
    if (!celebrityName) {
      return res.status(400).json({
        success: false,
        error: 'Celebrity name is required'
      });
    }
    
    const allowedStyles = ['basic', 'rasplata'];
    const style = allowedStyles.includes(articleStyle) ? articleStyle : 'basic';

    const article = await prisma.article.create({
      data: {
        celebrityName,
        status: ArticleStatus.DRAFT,
        currentStage: PipelineStage.INPUT,
        language: language || 'ru',
        articleStyle: style
      }
    });
    
    res.status(201).json({ success: true, data: article });
  } catch (error) {
    next(error);
  }
});

// Update article
articlesRouter.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const article = await prisma.article.update({
      where: { id },
      data: updates,
      include: {
        coverImages: {
          orderBy: { generatedAt: 'desc' }
        },
        publications: true
      }
    });
    
    res.json({ success: true, data: article });
  } catch (error) {
    next(error);
  }
});

// Delete article
articlesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Get article with all cover images to delete files
    const article = await prisma.article.findUnique({
      where: { id },
      include: {
        coverImages: true
      }
    });
    
    if (!article) {
      return res.status(404).json({
        success: false,
        error: 'Article not found'
      });
    }
    
    // Delete all cover image files from disk
    const fs = await import('fs/promises');
    const path = await import('path');
    
    for (const cover of article.coverImages) {
      try {
        // Delete the file if it exists
        const filePath = cover.localPath.startsWith('/') 
          ? cover.localPath 
          : path.join(process.cwd(), cover.localPath);
        
        await fs.unlink(filePath);
        console.log(`🗑️ Deleted cover file: ${filePath}`);
      } catch (err) {
        console.warn(`⚠️ Could not delete cover file ${cover.localPath}:`, err);
      }
    }
    
    // Delete article (this will cascade delete covers and publications)
    await prisma.article.delete({
      where: { id }
    });
    
    console.log(`✅ Deleted article ${id} with ${article.coverImages.length} cover(s)`);
    
    res.json({ 
      success: true, 
      message: 'Article and all associated data deleted',
      deletedCovers: article.coverImages.length
    });
  } catch (error) {
    next(error);
  }
});

// Regenerate image for a specific fact
articlesRouter.post('/:id/facts/:factId/regenerate-image', async (req, res, next) => {
  try {
    const { id: articleId, factId } = req.params;
    
    // Get article with research data
    const article = await prisma.article.findUnique({
      where: { id: articleId }
    });
    
    if (!article || !article.researchData) {
      return res.status(404).json({ success: false, message: 'Article or research data not found' });
    }
    
    const researchData = article.researchData as any;
    const factIndex = researchData.facts?.findIndex((f: any) => f.id === factId);
    
    if (factIndex === -1 || factIndex === undefined) {
      return res.status(404).json({ success: false, message: 'Fact not found' });
    }
    
    const fact = researchData.facts[factIndex];
    const currentImageUrl = fact.imageUrl;

    // Collect ALL image URLs already in use across this article so we never
    // return the same photo that is displayed elsewhere.
    const usedUrls = new Set<string>();
    for (const f of researchData.facts || []) {
      if (f.imageUrl) usedUrls.add(String(f.imageUrl).toLowerCase());
    }
    const articleContent = article.content as any;
    for (const s of articleContent?.sections || []) {
      if (s.imageUrl) usedUrls.add(String(s.imageUrl).toLowerCase());
    }
    if (currentImageUrl) usedUrls.add(String(currentImageUrl).toLowerCase());
    
    // Build search query
    const queryParts = [article.celebrityName, 'photo'];
    if (fact.visualSuggestion) {
      queryParts.push(fact.visualSuggestion);
    } else {
      queryParts.push(fact.title);
    }
    if (fact.year) {
      queryParts.push(String(fact.year));
    }
    
    const query = queryParts.join(' ');
    console.log(`🔄 Regenerating image for fact "${fact.title}": ${query}`);
    
    // Get up to 10 alternative image candidates (returns ImageCandidate[] with thumbnails)
    const imageCandidates = await searchGoogleImages(query, 10, article.celebrityName);
    const imageResults = imageCandidates.map(c => c.originalUrl);
    
    if (imageResults.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No alternative images found' 
      });
    }
    
    // Find first image that's different from ALL currently-used URLs in this article
    const newImageUrl = imageResults.find(url => !usedUrls.has(url.toLowerCase()))
      || imageResults.find(url => url !== currentImageUrl)
      || imageResults[0];
    
    // Update fact with new image
    researchData.facts[factIndex].imageUrl = newImageUrl;
    
    await prisma.article.update({
      where: { id: articleId },
      data: {
        researchData: researchData as any,
        updatedAt: new Date()
      }
    });
    
    console.log(`✅ Updated fact image: ${currentImageUrl} → ${newImageUrl}`);
    
    res.json({ 
      success: true, 
      data: { 
        factId,
        oldImageUrl: currentImageUrl,
        newImageUrl 
      } 
    });
    
  } catch (error) {
    console.error('Image regeneration error:', error);
    next(error);
  }
});

// Find image for a specific fact (with WebSocket progress)
articlesRouter.post('/:id/facts/:factId/find-image', async (req, res, next) => {
  try {
    const { id: articleId, factId } = req.params;
    const { useGoogle = true, useBrave = true, usePerplexity = true, useOpenAI = false, confidenceThreshold = 85, resultsPerSource = 5 } = req.body || {};
    
    // Get article with research data
    const article = await prisma.article.findUnique({
      where: { id: articleId }
    });
    
    if (!article || !article.researchData) {
      return res.status(404).json({ success: false, message: 'Article or research data not found' });
    }
    
    const researchData = article.researchData as any;
    const factIndex = researchData.facts?.findIndex((f: any) => f.id === factId);
    
    if (factIndex === -1 || factIndex === undefined) {
      return res.status(404).json({ success: false, message: 'Fact not found' });
    }
    
    const fact = researchData.facts[factIndex];
    
    // Collect every image URL currently used in this article so we don't
    // return one that's already displayed somewhere else (or the one the
    // user just said they don't want).
    const usedPaths: string[] = [];
    for (const f of researchData.facts || []) {
      if (f.id !== factId && f.imageUrl) usedPaths.push(String(f.imageUrl));
    }
    const articleContent = article.content as any;
    for (const s of articleContent?.sections || []) {
      if (s.imageUrl) usedPaths.push(String(s.imageUrl));
    }
    if (fact.imageUrl) usedPaths.push(String(fact.imageUrl));

    // Emit progress: starting
    const io = getIO();
    io.emit('image-search-progress', {
      articleId,
      factId,
      status: 'searching',
      progress: 10,
      message: 'Поиск изображений в Google и Brave...'
    });
    
    console.log(`🔍 Finding image for fact "${fact.title}"`);
    
    // Collect all Gemini-scored candidates so the UI can offer manual pick
    // when the auto-selection doesn't clear the quality floor.
    let factCandidates: ScoredImageCandidate[] = [];

    // Use full findFactImage with Gemini validation
    const imageUrl = await findFactImage(
      article.celebrityName,
      fact.title,
      fact.year,
      fact.visualSuggestion,
      // Progress callback
      (progress: { stage: string; current: number; total: number; confidence?: number }) => {
        io.emit('image-search-progress', {
          articleId,
          factId,
          status: progress.stage,
          progress: Math.round((progress.current / progress.total) * 100),
          current: progress.current,
          total: progress.total,
          confidence: progress.confidence,
          message: progress.stage === 'validating' 
            ? `Проверка изображения ${progress.current}/${progress.total}...`
            : progress.stage === 'found'
            ? `Найдено! Уверенность: ${progress.confidence}%`
            : 'Поиск...'
        });
      },
      // Search options from request body
      {
        useGoogle,
        useBrave,
        usePerplexity,
        useOpenAI,
        confidenceThreshold,
        resultsPerSource,
        excludeLocalPaths: usedPaths,
        onCandidates: (cands) => { factCandidates = cands; },
      }
    );
    
    if (!imageUrl) {
      io.emit('image-search-progress', {
        articleId,
        factId,
        status: 'not-found',
        progress: 100,
        message: 'Автоподбор не прошёл порог качества — выберите вручную из кандидатов'
      });
      
      // Not a dead-end: return the scored candidates so the user can pick one manually
      return res.status(200).json({ 
        success: false, 
        message: 'No suitable image found',
        data: { factId, candidates: factCandidates }
      });
    }
    
    // Update fact with new image
    researchData.facts[factIndex].imageUrl = imageUrl;
    
    await prisma.article.update({
      where: { id: articleId },
      data: {
        researchData: researchData as any,
        updatedAt: new Date()
      }
    });
    
    // Emit progress: complete
    io.emit('image-search-progress', {
      articleId,
      factId,
      status: 'complete',
      progress: 100,
      message: 'Изображение найдено и сохранено!'
    });
    
    console.log(`✅ Found and saved image for fact "${fact.title}": ${imageUrl}`);
    
    res.json({ 
      success: true, 
      data: { 
        factId,
        imageUrl,
        candidates: factCandidates
      } 
    });
    
  } catch (error) {
    console.error('Image search error:', error);
    
    // Emit error
    try {
      const io = getIO();
      io.emit('image-search-progress', {
        articleId: req.params.id,
        factId: req.params.factId,
        status: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    } catch {}
    
    next(error);
  }
});

// Find image for a specific SECTION in generated article (with WebSocket progress)
articlesRouter.post('/:id/sections/:sectionIndex/find-image', async (req, res, next) => {
  try {
    const { id: articleId, sectionIndex } = req.params;
    const sectionIdx = parseInt(sectionIndex, 10);
    const { useGoogle = true, useBrave = true, usePerplexity = true, useOpenAI = false, confidenceThreshold = 70, resultsPerSource = 5 } = req.body || {};
    
    // Get article with content and research data
    const article = await prisma.article.findUnique({
      where: { id: articleId }
    });
    
    if (!article || !article.content) {
      return res.status(404).json({ success: false, message: 'Article or content not found' });
    }
    
    const content = article.content as any;
    const researchData = article.researchData as any;
    const sections = content.sections || [];
    
    if (sectionIdx < 0 || sectionIdx >= sections.length) {
      return res.status(404).json({ success: false, message: 'Section not found' });
    }
    
    const section = sections[sectionIdx];
    const sectionTitle = section.heading || section.title || `Section ${sectionIdx + 1}`;
    
    // Find matching fact by factId or title similarity
    let matchingFact = null;
    const facts = researchData?.facts || [];
    
    if (section.factId) {
      matchingFact = facts.find((f: any) => f.id === section.factId && !f.isDeleted);
    }
    
    if (!matchingFact) {
      matchingFact = facts.find((f: any) => 
        !f.isDeleted && (
          f.title.toLowerCase().includes(sectionTitle.toLowerCase().substring(0, 20)) ||
          sectionTitle.toLowerCase().includes(f.title.toLowerCase().substring(0, 20))
        )
      );
    }
    
    // Build search parameters from fact or section
    const visualSuggestion = matchingFact?.visualSuggestion || `${article.celebrityName} - ${sectionTitle}`;
    const year = matchingFact?.year || section.year || '';
    
    // Collect every image URL already used in this article so findFactImage
    // can skip any candidate that resolves to the same cached file.
    const usedPaths: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      if (i !== sectionIdx && sections[i]?.imageUrl) {
        usedPaths.push(String(sections[i].imageUrl));
      }
    }
    for (const f of researchData?.facts || []) {
      if (f?.imageUrl) usedPaths.push(String(f.imageUrl));
    }
    // Also exclude the section's current image so "re-pick" actually gives
    // the user something different.
    if (section.imageUrl) usedPaths.push(String(section.imageUrl));
    
    // Emit progress: starting
    const io = getIO();
    io.emit('section-image-search-progress', {
      articleId,
      sectionIndex: sectionIdx,
      status: 'searching',
      progress: 10,
      message: 'Поиск изображений...'
    });
    
    console.log(`🔍 Finding image for section ${sectionIdx + 1}: "${sectionTitle}"`);
    if (matchingFact) {
      console.log(`  ✅ Matched to fact: "${matchingFact.title}"`);
      console.log(`  🎨 Visual suggestion: "${visualSuggestion}"`);
    }

    // Collect all Gemini-scored candidates for the manual-pick gallery
    let sectionCandidates: ScoredImageCandidate[] = [];
    
    // Use findFactImage with Gemini validation
    const imageUrl = await findFactImage(
      article.celebrityName,
      sectionTitle,
      year,
      visualSuggestion,
      // Progress callback
      (progress: { stage: string; current: number; total: number; confidence?: number }) => {
        io.emit('section-image-search-progress', {
          articleId,
          sectionIndex: sectionIdx,
          status: progress.stage,
          progress: Math.round((progress.current / progress.total) * 100),
          current: progress.current,
          total: progress.total,
          confidence: progress.confidence,
          message: progress.stage === 'validating' 
            ? `Проверка изображения ${progress.current}/${progress.total}...`
            : progress.stage === 'found'
            ? `Найдено! Уверенность: ${progress.confidence}%`
            : 'Поиск...'
        });
      },
      {
        useGoogle, useBrave, usePerplexity, useOpenAI, confidenceThreshold, resultsPerSource,
        excludeLocalPaths: usedPaths,
        onCandidates: (cands) => { sectionCandidates = cands; },
      }
    );
    
    if (!imageUrl) {
      io.emit('section-image-search-progress', {
        articleId,
        sectionIndex: sectionIdx,
        status: 'not-found',
        progress: 100,
        message: 'Автоподбор не прошёл порог качества — выберите вручную из кандидатов'
      });
      
      // Not a dead-end: hand back the scored candidates for manual selection in the UI
      return res.status(200).json({ 
        success: false, 
        message: 'No suitable image found',
        data: { sectionIndex: sectionIdx, candidates: sectionCandidates }
      });
    }
    
    // Update section with new image
    sections[sectionIdx].imageUrl = imageUrl;
    if (matchingFact?.visualSuggestion) {
      sections[sectionIdx].visualSuggestion = matchingFact.visualSuggestion;
    }
    
    await prisma.article.update({
      where: { id: articleId },
      data: {
        content: { ...content, sections } as any,
        updatedAt: new Date()
      }
    });
    
    // Emit progress: complete
    io.emit('section-image-search-progress', {
      articleId,
      sectionIndex: sectionIdx,
      status: 'complete',
      progress: 100,
      message: 'Изображение найдено и сохранено!'
    });
    
    console.log(`✅ Found and saved image for section ${sectionIdx + 1}: ${imageUrl}`);
    
    res.json({ 
      success: true, 
      data: { 
        sectionIndex: sectionIdx,
        imageUrl,
        candidates: sectionCandidates
      } 
    });
    
  } catch (error) {
    console.error('Section image search error:', error);
    
    try {
      const io = getIO();
      io.emit('section-image-search-progress', {
        articleId: req.params.id,
        sectionIndex: parseInt(req.params.sectionIndex, 10),
        status: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    } catch {}
    
    next(error);
  }
});

// Manually set an image for a SECTION (used by the candidate-pick gallery).
// Accepts a web URL (downloads + caches it locally) or an already-local /images/ path.
articlesRouter.post('/:id/sections/:sectionIndex/set-image', async (req, res, next) => {
  try {
    const { id: articleId, sectionIndex } = req.params;
    const sectionIdx = parseInt(sectionIndex, 10);
    const { imageUrl, thumbnailUrl } = req.body || {};

    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).json({ success: false, message: 'imageUrl is required' });
    }

    const article = await prisma.article.findUnique({ where: { id: articleId } });
    if (!article || !article.content) {
      return res.status(404).json({ success: false, message: 'Article or content not found' });
    }

    const content = article.content as any;
    const sections = content.sections || [];
    if (sectionIdx < 0 || sectionIdx >= sections.length) {
      return res.status(404).json({ success: false, message: 'Section not found' });
    }

    // Local paths are stored as-is; web URLs get downloaded & cached
    const finalUrl = imageUrl.startsWith('/images/')
      ? imageUrl
      : await downloadAndCacheImage(imageUrl, thumbnailUrl);

    sections[sectionIdx].imageUrl = finalUrl;

    await prisma.article.update({
      where: { id: articleId },
      data: { content: { ...content, sections } as any, updatedAt: new Date() }
    });

    console.log(`✅ Manually set image for section ${sectionIdx + 1}: ${finalUrl}`);
    res.json({ success: true, data: { sectionIndex: sectionIdx, imageUrl: finalUrl } });
  } catch (error) {
    next(error);
  }
});

// Manually set an image for a FACT (used by the candidate-pick gallery).
articlesRouter.post('/:id/facts/:factId/set-image', async (req, res, next) => {
  try {
    const { id: articleId, factId } = req.params;
    const { imageUrl, thumbnailUrl } = req.body || {};

    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).json({ success: false, message: 'imageUrl is required' });
    }

    const article = await prisma.article.findUnique({ where: { id: articleId } });
    if (!article || !article.researchData) {
      return res.status(404).json({ success: false, message: 'Article or research data not found' });
    }

    const researchData = article.researchData as any;
    const factIndex = researchData.facts?.findIndex((f: any) => f.id === factId);
    if (factIndex === -1 || factIndex === undefined) {
      return res.status(404).json({ success: false, message: 'Fact not found' });
    }

    const finalUrl = imageUrl.startsWith('/images/')
      ? imageUrl
      : await downloadAndCacheImage(imageUrl, thumbnailUrl);

    researchData.facts[factIndex].imageUrl = finalUrl;

    await prisma.article.update({
      where: { id: articleId },
      data: { researchData: researchData as any, updatedAt: new Date() }
    });

    console.log(`✅ Manually set image for fact "${factId}": ${finalUrl}`);
    res.json({ success: true, data: { factId, imageUrl: finalUrl } });
  } catch (error) {
    next(error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Block images: illustration for the "Успех" (conclusion) and "Бонусный факт"
// blocks of the generated article. blockKey: 'conclusion' | 'bonus'.
// Image is stored at content.conclusionImageUrl / content.bonusFactImageUrl.
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_IMAGE_FIELD: Record<string, string> = {
  conclusion: 'conclusionImageUrl',
  bonus: 'bonusFactImageUrl',
};

articlesRouter.post('/:id/blocks/:blockKey/find-image', async (req, res, next) => {
  try {
    const { id: articleId, blockKey } = req.params;
    const field = BLOCK_IMAGE_FIELD[blockKey];
    if (!field) {
      return res.status(400).json({ success: false, message: `Unknown block: ${blockKey}` });
    }

    const { useGoogle = true, useBrave = true, usePerplexity = true, useOpenAI = false, confidenceThreshold = 70, resultsPerSource = 5 } = req.body || {};

    const article = await prisma.article.findUnique({ where: { id: articleId } });
    if (!article || !article.content) {
      return res.status(404).json({ success: false, message: 'Article or content not found' });
    }

    const content = article.content as any;
    const researchData = article.researchData as any;

    // Build the visual description per block
    let visualSuggestion: string;
    let year: number | undefined;
    if (blockKey === 'conclusion') {
      const conclusionText = String(
        (typeof content.conclusion === 'object' ? content.conclusion?.text : content.conclusion) || ''
      ).substring(0, 200);
      // Success block: the hero at their peak — confident, celebrated, recent
      visualSuggestion = `${article.celebrityName} at the peak of success: smiling or confident, at an award ceremony, premiere or public triumph, recent years, high-quality photo. ${conclusionText}`;
    } else {
      const bonusText = String(content.bonusFact || '').substring(0, 250);
      if (!bonusText) {
        return res.status(400).json({ success: false, message: 'Article has no bonus fact' });
      }
      visualSuggestion = `${article.celebrityName}. ${bonusText}`;
      const yearMatch = bonusText.match(/\b(18|19|20)\d{2}\b/);
      if (yearMatch) year = parseInt(yearMatch[0], 10);
    }

    // Exclude everything already used in the article
    const usedPaths: string[] = [];
    for (const s of content.sections || []) {
      if (s?.imageUrl) usedPaths.push(String(s.imageUrl));
    }
    for (const f of researchData?.facts || []) {
      if (f?.imageUrl) usedPaths.push(String(f.imageUrl));
    }
    for (const f of Object.values(BLOCK_IMAGE_FIELD)) {
      if (content[f]) usedPaths.push(String(content[f]));
    }

    console.log(`🔍 Finding image for block "${blockKey}" of ${article.celebrityName}`);

    let blockCandidates: ScoredImageCandidate[] = [];
    const imageUrl = await findFactImage(
      article.celebrityName,
      blockKey === 'conclusion' ? 'success triumph' : 'bonus fact',
      year,
      visualSuggestion,
      undefined,
      {
        useGoogle, useBrave, usePerplexity, useOpenAI, confidenceThreshold, resultsPerSource,
        excludeLocalPaths: usedPaths,
        onCandidates: (cands) => { blockCandidates = cands; },
      }
    );

    if (!imageUrl) {
      return res.status(200).json({
        success: false,
        message: 'No suitable image found',
        data: { blockKey, candidates: blockCandidates }
      });
    }

    content[field] = imageUrl;
    await prisma.article.update({
      where: { id: articleId },
      data: { content: content as any, updatedAt: new Date() }
    });

    console.log(`✅ Found and saved image for block "${blockKey}": ${imageUrl}`);
    res.json({ success: true, data: { blockKey, imageUrl, candidates: blockCandidates } });
  } catch (error) {
    next(error);
  }
});

// Manually set an image for a block (candidate-pick gallery)
articlesRouter.post('/:id/blocks/:blockKey/set-image', async (req, res, next) => {
  try {
    const { id: articleId, blockKey } = req.params;
    const field = BLOCK_IMAGE_FIELD[blockKey];
    if (!field) {
      return res.status(400).json({ success: false, message: `Unknown block: ${blockKey}` });
    }

    const { imageUrl, thumbnailUrl } = req.body || {};
    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).json({ success: false, message: 'imageUrl is required' });
    }

    const article = await prisma.article.findUnique({ where: { id: articleId } });
    if (!article || !article.content) {
      return res.status(404).json({ success: false, message: 'Article or content not found' });
    }

    const content = article.content as any;
    const finalUrl = imageUrl.startsWith('/images/')
      ? imageUrl
      : await downloadAndCacheImage(imageUrl, thumbnailUrl);

    content[field] = finalUrl;
    await prisma.article.update({
      where: { id: articleId },
      data: { content: content as any, updatedAt: new Date() }
    });

    console.log(`✅ Manually set image for block "${blockKey}": ${finalUrl}`);
    res.json({ success: true, data: { blockKey, imageUrl: finalUrl } });
  } catch (error) {
    next(error);
  }
});

// Update a quote
articlesRouter.put('/:id/quotes/:quoteId', async (req, res, next) => {
  try {
    const { id, quoteId } = req.params;
    const { text, source, year } = req.body;
    
    const article = await prisma.article.findUnique({
      where: { id }
    });
    
    if (!article || !article.researchData) {
      res.status(404).json({ success: false, message: 'Article not found' });
      return;
    }
    
    const researchData = article.researchData as any;
    const quotes = researchData.quotes || [];
    const quoteIndex = quotes.findIndex((q: any) => q.id === quoteId);
    
    if (quoteIndex === -1) {
      res.status(404).json({ success: false, message: 'Quote not found' });
      return;
    }
    
    quotes[quoteIndex] = {
      ...quotes[quoteIndex],
      text,
      source,
      year,
      isEdited: true
    };
    
    await prisma.article.update({
      where: { id },
      data: {
        researchData: {
          ...researchData,
          quotes
        }
      }
    });
    
    res.json({ success: true, data: quotes[quoteIndex] });
  } catch (error) {
    next(error);
  }
});

// Delete a quote (soft delete)
articlesRouter.delete('/:id/quotes/:quoteId', async (req, res, next) => {
  try {
    const { id, quoteId } = req.params;
    
    const article = await prisma.article.findUnique({
      where: { id }
    });
    
    if (!article || !article.researchData) {
      res.status(404).json({ success: false, message: 'Article not found' });
      return;
    }
    
    const researchData = article.researchData as any;
    const quotes = researchData.quotes || [];
    const quoteIndex = quotes.findIndex((q: any) => q.id === quoteId);
    
    if (quoteIndex === -1) {
      res.status(404).json({ success: false, message: 'Quote not found' });
      return;
    }
    
    quotes[quoteIndex] = {
      ...quotes[quoteIndex],
      isDeleted: true
    };
    
    await prisma.article.update({
      where: { id },
      data: {
        researchData: {
          ...researchData,
          quotes
        }
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Search for a new real quote via Perplexity
articlesRouter.post('/:id/quotes/generate', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { existingQuotes = [] } = req.body;
    
    const article = await prisma.article.findUnique({
      where: { id }
    });
    
    if (!article) {
      res.status(404).json({ success: false, message: 'Article not found' });
      return;
    }
    
    console.log(`🔍 Searching for new quote for ${article.celebrityName} via Perplexity...`);
    console.log(`📋 Existing quotes to exclude: ${existingQuotes.length}`);
    
    // Use Perplexity to search for real quotes
    const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
    if (!PERPLEXITY_API_KEY) {
      throw new Error('PERPLEXITY_API_KEY not configured');
    }
    
    const existingQuotesText = existingQuotes.length > 0 
      ? `\n\nУже найденные цитаты (НЕ повторяй их):\n${existingQuotes.map((q: string, i: number) => `${i + 1}. "${q}"`).join('\n')}`
      : '';
    
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: `Ты исследователь цитат. Твоя задача - найти РЕАЛЬНУЮ, ЗАДОКУМЕНТИРОВАННУЮ цитату известной личности. 
Цитата должна быть из проверенного источника (интервью, книга, выступление, официальное заявление).
НЕ выдумывай цитаты. Если не можешь найти реальную цитату - так и скажи.
Верни ТОЛЬКО JSON без markdown.`
          },
          {
            role: 'user',
            content: `Найди реальную цитату ${article.celebrityName} из достоверного источника.${existingQuotesText}

Верни JSON:
{
  "text": "точный текст цитаты",
  "source": "источник (название интервью/книги/издания)",
  "year": год (число или null),
  "found": true/false (нашлась ли реальная цитата)
}`
          }
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Perplexity API error:', errorText);
      throw new Error(`Perplexity API error: ${response.status}`);
    }
    
    const data = await response.json() as any;
    const responseText = data.choices?.[0]?.message?.content || '';
    
    console.log('📝 Perplexity response:', responseText);
    
    // Parse JSON from response
    let quoteData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        quoteData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Failed to parse quote response:', responseText);
      res.status(500).json({ success: false, message: 'Не удалось распознать ответ Perplexity' });
      return;
    }
    
    if (!quoteData.found || !quoteData.text) {
      res.status(404).json({ success: false, message: 'Не удалось найти новую реальную цитату' });
      return;
    }
    
    const newQuote = {
      id: `quote-${Date.now()}`,
      text: quoteData.text,
      source: quoteData.source || 'Неизвестный источник',
      year: quoteData.year,
      isSearched: true // Mark as searched, not generated
    };
    
    // Update article with new quote
    const researchData = (article.researchData as any) || {};
    const quotes = researchData.quotes || [];
    quotes.push(newQuote);
    
    await prisma.article.update({
      where: { id },
      data: {
        researchData: {
          ...researchData,
          quotes
        }
      }
    });
    
    console.log(`✅ Found new quote: "${newQuote.text.substring(0, 50)}..."`);
    
    res.json({ success: true, data: { quote: newQuote } });
  } catch (error) {
    console.error('Quote generation error:', error);
    next(error);
  }
});
