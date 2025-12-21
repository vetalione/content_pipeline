import { Router } from 'express';
import { researchQueue } from '../services/queue';
import { PipelineStage } from '@content-pipeline/shared';

export const pipelineRouter = Router();

// Start research stage
pipelineRouter.post('/:articleId/research', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    
    await researchQueue.add('research', {
      articleId,
      stage: PipelineStage.RESEARCH
    });
    
    res.json({
      success: true,
      message: 'Research job queued'
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
    
    await researchQueue.add('generate', {
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

// Start cover generation
pipelineRouter.post('/:articleId/cover', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { template } = req.body;
    
    await researchQueue.add('cover', {
      articleId,
      stage: PipelineStage.COVER,
      template
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
