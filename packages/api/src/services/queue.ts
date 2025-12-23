import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

// Railway provides REDIS_URL, fallback to separate host/port for local dev
const connection = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null
    })
  : new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      maxRetriesPerRequest: null
    });

export const researchQueue = new Queue('research', { connection });
export const generationQueue = new Queue('generation', { connection });
export const coverQueue = new Queue('cover', { connection });
export const publishQueue = new Queue('publish', { connection });

// Research Worker - using Perplexity for deep web search
const researchWorker = new Worker('research', async (job) => {
  const { articleId } = job.data;
  console.log(`Starting deep research for article ${articleId} with Perplexity`);
  
  try {
    // Use Perplexity for web-enabled research, fallback to OpenAI
    const usePerplexity = !!process.env.PERPLEXITY_API_KEY;
    
    if (usePerplexity) {
      console.log('Using Perplexity AI with web search');
      const { performPerplexityResearch } = await import('./ai/perplexity-research');
      const result = await performPerplexityResearch(articleId);
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
}, { connection });

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
}, { connection });

generationWorker.on('failed', (job, err) => {
  console.error(`Generation job ${job?.id} failed:`, err);
});

// Cover Worker
const coverWorker = new Worker('cover', async (job) => {
  const { articleId, template } = job.data;
  console.log(`Starting cover generation for article ${articleId}`);
  
  try {
    const { generateCover } = await import('./media/cover');
    const result = await generateCover(articleId, template);
    
    console.log(`Cover generated for article ${articleId}`);
    return result;
  } catch (error) {
    console.error(`Cover generation failed for article ${articleId}:`, error);
    throw error;
  }
}, { connection });

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
}, { connection });

publishWorker.on('failed', (job, err) => {
  console.error(`Publish job ${job?.id} failed:`, err);
});
