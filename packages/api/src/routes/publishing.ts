import { Router } from 'express';
import { publishToTelegram } from '../services/publishers/telegram';
import { publishToVK } from '../services/publishers/vk';
import { Platform } from '@content-pipeline/shared';
import { prisma } from '../lib/db';

export const publishingRouter = Router();

// Publish to platforms
publishingRouter.post('/:articleId/publish', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { platforms, scheduledAt } = req.body;
    
    const article = await prisma.article.findUnique({
      where: { id: articleId },
      include: { coverImage: true }
    });
    
    if (!article) {
      return res.status(404).json({
        success: false,
        error: 'Article not found'
      });
    }
    
    // Create publication records
    const publications = await Promise.all(
      (platforms as Platform[]).map(platform =>
        prisma.publication.create({
          data: {
            articleId,
            platform,
            status: scheduledAt ? 'pending' : 'publishing'
          }
        })
      )
    );
    
    // If not scheduled, publish immediately
    if (!scheduledAt) {
      for (const pub of publications) {
        try {
          let result;
          switch (pub.platform) {
            case Platform.TELEGRAM:
              result = await publishToTelegram(article);
              break;
            case Platform.VK:
              result = await publishToVK(article);
              break;
            // Add other platforms...
            default:
              throw new Error(`Platform ${pub.platform} not implemented`);
          }
          
          await prisma.publication.update({
            where: { id: pub.id },
            data: {
              status: 'published',
              publishedUrl: result.url,
              publishedAt: new Date()
            }
          });
        } catch (error: any) {
          await prisma.publication.update({
            where: { id: pub.id },
            data: {
              status: 'failed',
              error: error.message
            }
          });
        }
      }
    }
    
    res.json({
      success: true,
      data: publications
    });
  } catch (error) {
    next(error);
  }
});

// Get publications for article
publishingRouter.get('/:articleId/publications', async (req, res, next) => {
  try {
    const publications = await prisma.publication.findMany({
      where: { articleId: req.params.articleId },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ success: true, data: publications });
  } catch (error) {
    next(error);
  }
});
