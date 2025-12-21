import OpenAI from 'openai';
import { prisma } from '../../lib/db';
import { PipelineStage, ResearchData, BiographyFact } from '@content-pipeline/shared';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Perform research on a celebrity
 */
export async function performResearch(articleId: string): Promise<ResearchData> {
  const article = await prisma.article.findUnique({
    where: { id: articleId }
  });
  
  if (!article) {
    throw new Error('Article not found');
  }
  
  console.log(`Researching ${article.celebrityName}...`);
  
  // Create research prompt
  const prompt = createResearchPrompt(article.celebrityName);
  
  // Call OpenAI
  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [
      {
        role: 'system',
        content: 'You are an expert biographer and researcher specializing in finding dramatic, tragic, and controversial stories about celebrities. Focus on failures, struggles, and dark periods that preceded success.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.7,
    max_tokens: 4000,
    response_format: { type: 'json_object' }
  });
  
  const researchData = JSON.parse(completion.choices[0].message.content || '{}');
  
  // Save to database
  await prisma.article.update({
    where: { id: articleId },
    data: {
      researchData,
      currentStage: PipelineStage.RESEARCH,
      updatedAt: new Date()
    }
  });
  
  return researchData;
}

function createResearchPrompt(celebrityName: string): string {
  return `
Research ${celebrityName} and provide a comprehensive JSON response with the following structure:

{
  "facts": [
    {
      "id": "unique_id",
      "title": "Short title",
      "description": "Detailed description of the failure/tragedy/struggle",
      "category": "failure|tragedy|controversy|struggle|success",
      "year": 2020,
      "severity": 1-5,
      "sources": ["source1", "source2"]
    }
  ],
  "quotes": [
    {
      "id": "unique_id",
      "text": "Exact quote",
      "context": "Context of the quote",
      "source": "Interview name or book title",
      "year": 2020
    }
  ],
  "images": [
    {
      "id": "unique_id",
      "url": "image_search_query",
      "description": "Description of the image",
      "source": "Where to find it",
      "isRare": true/false,
      "year": 2020
    }
  ],
  "sources": ["source1", "source2", "source3"]
}

Find 8-9 of the most dramatic failures, tragedies, controversies, or struggles. Include:
- Career failures and rejections
- Personal tragedies
- Public controversies
- Financial problems
- Health struggles
- Relationship issues
- Dark periods before success

Focus on lesser-known, rare facts that aren't widely publicized. Include exact quotes from interviews, autobiographies, and personal letters. Suggest rare photo opportunities.

The story should have a redemption arc - show how they eventually succeeded despite everything.
`;
}
