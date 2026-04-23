import { Router } from 'express';
import { prisma } from '../lib/db';
import { Article, ArticleStatus, PipelineStage } from '@content-pipeline/shared';
import { searchGoogleImages, findFactImage } from '../services/media/google-images';
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
    const { celebrityName, language } = req.body;
    
    if (!celebrityName) {
      return res.status(400).json({
        success: false,
        error: 'Celebrity name is required'
      });
    }
    
    const article = await prisma.article.create({
      data: {
        celebrityName,
        status: ArticleStatus.DRAFT,
        currentStage: PipelineStage.INPUT,
        language: language || 'ru'
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
    const { useGoogle = true, useBrave = true, usePerplexity = true, confidenceThreshold = 85, resultsPerSource = 5 } = req.body || {};
    
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
        confidenceThreshold,
        resultsPerSource,
        excludeLocalPaths: usedPaths,
      }
    );
    
    if (!imageUrl) {
      io.emit('image-search-progress', {
        articleId,
        factId,
        status: 'not-found',
        progress: 100,
        message: 'Изображение не найдено'
      });
      
      return res.status(404).json({ 
        success: false, 
        message: 'No suitable image found' 
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
        imageUrl 
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
    const { useGoogle = true, useBrave = true, usePerplexity = true, confidenceThreshold = 70, resultsPerSource = 5 } = req.body || {};
    
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
      { useGoogle, useBrave, usePerplexity, confidenceThreshold, resultsPerSource, excludeLocalPaths: usedPaths }
    );
    
    if (!imageUrl) {
      io.emit('section-image-search-progress', {
        articleId,
        sectionIndex: sectionIdx,
        status: 'not-found',
        progress: 100,
        message: 'Изображение не найдено'
      });
      
      return res.status(404).json({ 
        success: false, 
        message: 'No suitable image found' 
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
        imageUrl 
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
