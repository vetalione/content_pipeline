import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

// Railway provides REDIS_URL, fallback to separate host/port for local dev
const connection = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      // Limit reconnection backoff to avoid Redis CPU spikes
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
    })
  : new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
    });

// Job cleanup: keep only last 20 completed jobs (1 day) and last 10 failed (7 days)
// This prevents Redis RAM from growing indefinitely — was the main $15 Redis cost driver
const defaultJobOptions = {
  removeOnComplete: { count: 20, age: 24 * 60 * 60 },      // 24h
  removeOnFail:    { count: 10, age: 7 * 24 * 60 * 60 },   // 7 days
};

export const researchQueue   = new Queue('research',   { connection, defaultJobOptions });
export const generationQueue = new Queue('generation', { connection, defaultJobOptions });
export const coverQueue      = new Queue('cover',      { connection, defaultJobOptions });
export const publishQueue    = new Queue('publish',    { connection, defaultJobOptions });
export const autopilotQueue  = new Queue('autopilot',  { connection, defaultJobOptions });

// Research Worker - using Perplexity for deep web search
const researchWorker = new Worker('research', async (job) => {
  const { articleId, mode } = job.data;
  console.log(`Starting research for article ${articleId}, mode: ${mode || 'normal'}`);
  
  try {
    // Use Perplexity for web-enabled research, fallback to OpenAI
    const usePerplexity = !!process.env.PERPLEXITY_API_KEY;
    
    if (usePerplexity) {
      console.log('Using Perplexity AI with web search');
      const { performPerplexityResearch } = await import('./ai/perplexity-research');
      const result = await performPerplexityResearch(articleId, mode);
      console.log(`Perplexity research completed for article ${articleId}`);
      return result;
    } else {
      console.log('Perplexity not configured, using OpenAI (no web search)');
      const { performResearch } = await import('./ai/research');
      const result = await performResearch(articleId);
      console.log(`OpenAI research completed for article ${articleId}`);
      return result;
    }
  } catch (error) {
    console.error(`Research failed for article ${articleId}:`, error);
    throw error;
  }
}, { connection, ...defaultJobOptions });

researchWorker.on('failed', (job, err) => {
  console.error(`Research job ${job?.id} failed:`, err);
});

// Generation Worker
const generationWorker = new Worker('generation', async (job) => {
  const { articleId, styleConfig } = job.data;
  console.log(`Starting content generation for article ${articleId}`);
  
  try {
    const { generateContent } = await import('./ai/generator');
    const result = await generateContent(articleId, styleConfig);
    
    console.log(`Generation completed for article ${articleId}`);
    return result;
  } catch (error) {
    console.error(`Generation failed for article ${articleId}:`, error);
    throw error;
  }
}, { connection, ...defaultJobOptions });

generationWorker.on('failed', (job, err) => {
  console.error(`Generation job ${job?.id} failed:`, err);
});

// Cover Worker - now with custom options support
const coverWorker = new Worker('cover', async (job) => {
  const { articleId, template, options } = job.data;
  console.log(`Starting cover generation for article ${articleId}`);
  
  try {
    const { generateCover } = await import('./media/cover');
    const result = await generateCover(articleId, template, options);
    
    console.log(`Cover generated for article ${articleId}`);
    return result;
  } catch (error) {
    console.error(`Cover generation failed for article ${articleId}:`, error);
    throw error;
  }
}, { connection, ...defaultJobOptions });

coverWorker.on('failed', (job, err) => {
  console.error(`Cover job ${job?.id} failed:`, err);
});

// Publish Worker
const publishWorker = new Worker('publish', async (job) => {
  const { articleId, platform } = job.data;
  console.log(`Publishing article ${articleId} to ${platform}`);
  
  try {
    const { publishArticle } = await import('./publishers');
    const result = await publishArticle(articleId, platform);
    
    console.log(`Published article ${articleId} to ${platform}`);
    return result;
  } catch (error) {
    console.error(`Publishing failed for article ${articleId} to ${platform}:`, error);
    throw error;
  }
}, { connection, ...defaultJobOptions });

publishWorker.on('failed', (job, err) => {
  console.error(`Publish job ${job?.id} failed:`, err);
});

// Autopilot Worker - runs full pipeline automatically
const autopilotWorker = new Worker('autopilot', async (job) => {
  const { articleId } = job.data;
  console.log(`🚀 Starting AUTOPILOT for article ${articleId}`);
  
  try {
    const { runAutopilot } = await import('./ai/autopilot');
    const result = await runAutopilot(articleId, (stage, progress, message) => {
      // Emit progress to frontend
      try {
        const { getIO } = require('../lib/socket');
        const io = getIO();
        io.emit(`autopilot:progress:${articleId}`, { stage, progress, message });
      } catch (e) {
        console.log(`Autopilot progress: ${stage} - ${progress}% - ${message}`);
      }
    });
    
    console.log(`✅ Autopilot completed for article ${articleId}`);
    return result;
  } catch (error) {
    console.error(`❌ Autopilot failed for article ${articleId}:`, error);
    throw error;
  }
}, { connection, ...defaultJobOptions });

autopilotWorker.on('failed', (job, err) => {
  console.error(`Autopilot job ${job?.id} failed:`, err);
});
