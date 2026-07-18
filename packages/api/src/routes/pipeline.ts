import { Router } from 'express';
import { researchQueue, generationQueue, coverQueue, autopilotQueue } from '../services/queue';
import { PipelineStage } from '@content-pipeline/shared';
import { getCoverOptionsPreview } from '../services/media/cover';
import { prisma } from '../lib/db';

export const pipelineRouter = Router();

// Start research stage
pipelineRouter.post('/:articleId/research', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { action, factSources } = req.body; // 'start', 'restart', 'deep_dive'
    
    console.log(`🎮 Research control for ${articleId}: ${action || 'start'}, sources:`, factSources);
    
    await researchQueue.add('research', {
      articleId,
      stage: PipelineStage.RESEARCH,
      mode: action === 'deep_dive' ? 'deep_dive' : action === 'restart' ? 'restart' : 'normal',
      factSources,
    });
    
    res.json({
      success: true,
      message: `Research job queued (${action || 'start'})`
    });
  } catch (error) {
    next(error);
  }
});

// Start AUTOPILOT - full automated pipeline
pipelineRouter.post('/:articleId/autopilot', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { factSources, coverModel } = req.body || {};

    console.log(`🚀 Starting AUTOPILOT for article ${articleId}, sources:`, factSources, `cover: ${coverModel || 'gemini'}`);
    
    // Update article status
    await prisma.article.update({
      where: { id: articleId },
      data: { 
        status: 'PROCESSING',
        currentStage: PipelineStage.RESEARCH
      }
    });
    
    await autopilotQueue.add('autopilot', {
      articleId,
      startedAt: new Date().toISOString(),
      factSources,
      coverModel,
    });
    
    res.json({
      success: true,
      message: 'Autopilot started - full pipeline will run automatically'
    });
  } catch (error) {
    next(error);
  }
});

// Start generation stage
pipelineRouter.post('/:articleId/generate', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { styleConfig } = req.body;
    
    await generationQueue.add('generate', {
      articleId,
      stage: PipelineStage.GENERATION,
      styleConfig
    });
    
    res.json({
      success: true,
      message: 'Generation job queued'
    });
  } catch (error) {
    next(error);
  }
});

// Get cover options preview (before generating)
pipelineRouter.get('/:articleId/cover/preview', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const preview = await getCoverOptionsPreview(articleId);
    
    res.json({
      success: true,
      data: preview
    });
  } catch (error) {
    next(error);
  }
});

// Start cover generation with optional custom parameters
pipelineRouter.post('/:articleId/cover', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { template, heroName, title, colorScheme, icons, sharpFact, model } = req.body;
    
    await coverQueue.add('cover', {
      articleId,
      stage: PipelineStage.COVER,
      template: template || 'default',
      options: {
        heroName,
        title,
        colorScheme,
        icons,
        sharpFact,
        model: model === 'openai' ? 'openai' : model === 'gemini-pro' ? 'gemini-pro' : 'gemini',
      }
    });
    
    res.json({
      success: true,
      message: 'Cover generation job queued'
    });
  } catch (error) {
    next(error);
  }
});

// Get pipeline status
pipelineRouter.get('/:articleId/status', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    
    // Get job status from queue
    const jobs = await researchQueue.getJobs(['active', 'waiting', 'completed', 'failed']);
    const articleJobs = jobs.filter(job => job.data.articleId === articleId);
    
    const jobsWithState = await Promise.all(
      articleJobs.map(async (job) => ({
        id: job.id,
        stage: job.data.stage,
        state: await job.getState(),
        progress: job.progress,
        timestamp: job.timestamp
      }))
    );
    
    res.json({
      success: true,
      data: {
        jobs: jobsWithState
      }
    });
  } catch (error) {
    next(error);
  }
});

// Select a specific cover version as the main one
pipelineRouter.post('/:articleId/cover/:coverId/select', async (req, res, next) => {
  try {
    const { articleId, coverId } = req.params;
    
    // Deselect all other covers for this article
    await prisma.coverImage.updateMany({
      where: { articleId },
      data: { isSelected: false }
    });
    
    // Select this cover
    const selectedCover = await prisma.coverImage.update({
      where: { id: coverId },
      data: { isSelected: true }
    });
    
    res.json({
      success: true,
      message: 'Cover selected',
      data: selectedCover
    });
  } catch (error) {
    next(error);
  }
});

// Delete a specific cover version
pipelineRouter.delete('/:articleId/cover/:coverId', async (req, res, next) => {
  try {
    const { coverId } = req.params;
    
    const cover = await prisma.coverImage.findUnique({
      where: { id: coverId }
    });
    
    if (!cover) {
      return res.status(404).json({
        success: false,
        error: 'Cover not found'
      });
    }
    
    // Delete file from disk
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const filePath = cover.localPath.startsWith('/') 
        ? cover.localPath 
        : path.join(process.cwd(), cover.localPath);
      
      await fs.unlink(filePath);
      console.log(`🗑️ Deleted cover file: ${filePath}`);
    } catch (err) {
      console.warn(`⚠️ Could not delete cover file ${cover.localPath}:`, err);
    }
    
    // Delete from database
    await prisma.coverImage.delete({
      where: { id: coverId }
    });
    
    res.json({
      success: true,
      message: 'Cover deleted'
    });
  } catch (error) {
    next(error);
  }
});
