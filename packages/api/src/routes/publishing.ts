import { Router } from 'express';
import { publishToTelegram } from '../services/publishers/telegram';
import { publishToVK } from '../services/publishers/vk';
import { publishToDzen, setupDzenAuth } from '../services/publishers/dzen';
import publishWithPlaywright from '../services/publishers/playwright';
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
      include: { coverImages: true }
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
            case Platform.DZEN:
              const dzenResult = await publishToDzen(article as any);
              result = { url: dzenResult.url || '' };
              if (!dzenResult.success) {
                throw new Error(dzenResult.error || 'Dzen publish failed');
              }
              break;
            case Platform.INSTAGRAM:
            case Platform.YOUTUBE:
            case Platform.THREADS:
            case Platform.MEDIUM:
            case Platform.FACEBOOK:
            case Platform.TWITTER:
            case Platform.LINKEDIN:
              result = await publishWithPlaywright(pub.platform as Platform, article);
              break;
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

// Setup Dzen authentication (opens browser for manual login)
publishingRouter.post('/auth/dzen/setup', async (req, res, next) => {
  try {
    // This will open a browser window for manual login
    // Should only be called from local environment
    await setupDzenAuth();
    res.json({ 
      success: true, 
      message: 'Dzen authentication saved successfully' 
    });
  } catch (error) {
    next(error);
  }
});

// Check Dzen auth status
publishingRouter.get('/auth/dzen/status', async (req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  const sessionPath = path.resolve(__dirname, '../services/publishers/sessions/dzen-state.json');
  
  const hasSession = fs.existsSync(sessionPath);
  
  res.json({
    success: true,
    data: {
      platform: 'dzen',
      authenticated: hasSession,
      sessionPath: hasSession ? sessionPath : null
    }
  });
});
