import { Router } from 'express';
import { prisma } from '../lib/db';
import { Article, ArticleStatus, PipelineStage } from '@content-pipeline/shared';

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
