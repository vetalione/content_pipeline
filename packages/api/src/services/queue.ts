import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null
});

export const researchQueue = new Queue('research', { connection });
export const generationQueue = new Queue('generation', { connection });
export const coverQueue = new Queue('cover', { connection });
export const publishQueue = new Queue('publish', { connection });

// Research Worker
new Worker('research', async (job) => {
  const { articleId } = job.data;
  console.log(`Starting research for article ${articleId}`);
  
  // Import research service
  const { performResearch } = await import('./ai/research');
  const result = await performResearch(articleId);
  
  return result;
}, { connection });

// Generation Worker
new Worker('generation', async (job) => {
  const { articleId, styleConfig } = job.data;
  console.log(`Starting content generation for article ${articleId}`);
  
  const { generateContent } = await import('./ai/generator');
  const result = await generateContent(articleId, styleConfig);
  
  return result;
}, { connection });

// Cover Worker
new Worker('cover', async (job) => {
  const { articleId, template } = job.data;
  console.log(`Starting cover generation for article ${articleId}`);
  
  const { generateCover } = await import('./media/cover');
  const result = await generateCover(articleId, template);
  
  return result;
}, { connection });

// Publish Worker
new Worker('publish', async (job) => {
  const { articleId, platform } = job.data;
  console.log(`Publishing article ${articleId} to ${platform}`);
  
  const { publishArticle } = await import('./publishers');
  const result = await publishArticle(articleId, platform);
  
  return result;
}, { connection });
