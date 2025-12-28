import { Router } from 'express';
import { prisma } from '../lib/db';
import { Article, ArticleStatus, PipelineStage } from '@content-pipeline/shared';
import { searchGoogleImages } from '../services/media/google-images';

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
          coverImage: true,
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
        coverImage: true,
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
        coverImage: true,
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
    await prisma.article.delete({
      where: { id: req.params.id }
    });
    
    res.json({ success: true, message: 'Article deleted' });
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
    
    // Get up to 5 alternative images
    const imageResults = await searchGoogleImages(query, 5);
    
    if (imageResults.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No alternative images found' 
      });
    }
    
    // Find first image that's different from current one
    const newImageUrl = imageResults.find(url => url !== currentImageUrl) || imageResults[0];
    
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

