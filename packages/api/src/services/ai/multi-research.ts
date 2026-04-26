/**
 * Multi-model fact research orchestrator.
 *
 * Runs Perplexity AND optional GPT / Claude / Gemini IN PARALLEL, all
 * doing the SAME job: searching the web for biographical failures.
 * Each model uses the IDENTICAL prompt that Perplexity uses
 * (`createDeepResearchPrompt`) and has its provider's native web-search
 * tool enabled — so they are interchangeable redundant searchers.
 *
 * Why duplicate the work:
 * - Different search indexes (Perplexity's, OpenAI's, Google's, Anthropic's
 *   Brave-based crawler) surface different sources for the same query
 * - Fault tolerance: if one provider fails, others still produce material
 * - More raw facts → user picks the strongest 8–12 in the curation step
 *
 * Each model returns the SAME JSON shape Perplexity does, so the existing
 * `convertToResearchData` logic absorbs them with a tiny post-processing
 * step (sourceModel tagging).
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { prisma } from '../../lib/db';
import { ResearchData, BiographyFact, PipelineStage } from '@content-pipeline/shared';
import { emitResearchProgress, emitResearchComplete } from '../../lib/socket';
import { createDeepResearchPrompt } from './perplexity-research';

export type FactSource = 'perplexity' | 'gpt' | 'claude' | 'gemini';

export interface FactResearchConfig {
  sources: Record<FactSource, boolean>;
}

const DEFAULT_CONFIG: FactResearchConfig = {
  sources: { perplexity: true, gpt: false, claude: false, gemini: false },
};

/* ─────────────────────────────────────────────────────────────────────
 * Shared prompt
 *
 * All four models (Perplexity, GPT, Claude, Gemini) use the EXACT same
 * prompt — `createDeepResearchPrompt` imported from perplexity-research.
 * The secondary models are intentionally redundant duplicates of
 * Perplexity, hitting the same task with different web-search backends,
 * so we maximise coverage and fault tolerance.
 *
 * Each provider has its native web-search tool enabled below so they
 * actually search the live web (not just rely on training memory).
 * ───────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────
 * Per-model callers
 * Each one returns parsed rawData (same JSON shape as Perplexity output)
 * or throws.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Extract a JSON object from a free-form model response.
 * Handles markdown fences and surrounding prose (common when web_search
 * tools are enabled and the model adds citation prefaces).
 */
function extractJsonBlock(text: string): any {
  let json = text.trim();
  if (json.startsWith('```json')) json = json.replace(/^```json\s*/, '').replace(/```\s*$/, '');
  else if (json.startsWith('```')) json = json.replace(/^```\s*/, '').replace(/```\s*$/, '');
  const match = json.match(/\{[\s\S]*\}/);
  if (match) json = match[0];
  return JSON.parse(json);
}

/**
 * GPT via OpenAI Responses API with the native `web_search` tool.
 * We use raw fetch (same pattern as openai-images.ts) because the v4
 * SDK pinned in this repo predates the Responses API.
 */
async function researchWithGPT(celebrityName: string, language: 'ru' | 'en' | 'both'): Promise<any> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  console.log(`  🧠 GPT-5 (web_search) researching ${celebrityName}...`);

  const userPrompt = createDeepResearchPrompt(celebrityName, 'documentary', language);
  const systemPrompt =
    'You are a senior biographical research consultant. Use the web_search tool aggressively to find authoritative sources (biographies, interview transcripts, court records, long-form journalism). You NEVER fabricate quotes, dates, or events. When uncertain, omit the field. Output ONLY valid JSON matching the schema requested by the user — no prose, no markdown fences.';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180_000);

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5',
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI Responses API ${response.status}: ${errText.substring(0, 300)}`);
  }

  const data: any = await response.json();
  let fullText = '';
  if (typeof data?.output_text === 'string') {
    fullText = data.output_text;
  } else if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      const contents = item?.content;
      if (Array.isArray(contents)) {
        for (const c of contents) {
          if (typeof c?.text === 'string') fullText += c.text + '\n';
        }
      }
    }
  }
  if (!fullText.trim()) throw new Error('GPT returned empty response');
  return extractJsonBlock(fullText);
}

/**
 * Claude with the native `web_search_20260209` tool (dynamic filtering
 * via code execution). $10 per 1000 searches + token cost.
 */
async function researchWithClaude(celebrityName: string, language: 'ru' | 'en' | 'both'): Promise<any> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`  🤖 Claude Sonnet 4.5 (web_search) researching ${celebrityName}...`);
  const message = await Promise.race([
    anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 12000,
      system:
        'You are a senior biographical research consultant. Use the web_search tool aggressively to find authoritative sources (biographies, interview transcripts, court records, long-form journalism). You NEVER fabricate quotes, dates, or events. When uncertain, omit the field. Output ONLY valid JSON matching the schema requested by the user, no prose before or after, no markdown fences.',
      messages: [{ role: 'user', content: createDeepResearchPrompt(celebrityName, 'documentary', language) }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 } as any],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Claude timeout after 3 minutes')), 180_000)
    ),
  ]);

  // With tools enabled, the response can have multiple text blocks
  // interleaved with server_tool_use / web_search_tool_result blocks.
  // The final assistant text holds the JSON.
  let combined = '';
  for (const block of (message as any).content || []) {
    if (block?.type === 'text' && typeof block.text === 'string') combined += block.text + '\n';
  }
  if (!combined.trim()) throw new Error('Claude returned empty response');
  return extractJsonBlock(combined);
}

/**
 * Gemini with the `google_search` grounding tool.
 * Note: when grounding is enabled, `responseMimeType: application/json`
 * cannot be used (mutually exclusive in the API), so we rely on the
 * prompt's "JSON only" instruction and parse defensively.
 */
async function researchWithGemini(celebrityName: string, language: 'ru' | 'en' | 'both'): Promise<any> {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log(`  💎 Gemini 3 Flash (google_search) researching ${celebrityName}...`);
  const result = await Promise.race([
    ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'You are a senior biographical research consultant. Use the google_search tool aggressively to find authoritative sources (biographies, interview transcripts, court records, long-form journalism). You NEVER fabricate quotes, dates, or events. When uncertain, omit the field. Output ONLY valid JSON matching the schema below — no prose, no markdown fences.\n\n' +
                createDeepResearchPrompt(celebrityName, 'documentary', language),
            },
          ],
        },
      ],
      config: {
        temperature: 0.3,
        maxOutputTokens: 12000,
        tools: [{ googleSearch: {} } as any],
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout after 3 minutes')), 180_000)
    ),
  ]);
  const text =
    (result as any)?.text ||
    (result as any)?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join('\n') ||
    '';
  if (!text.trim()) throw new Error('Gemini returned empty response');
  return extractJsonBlock(text);
}

/* ─────────────────────────────────────────────────────────────────────
 * Conversion: rawData → BiographyFact[]
 * Same logic as in perplexity-research.ts but tags each fact with source.
 * ───────────────────────────────────────────────────────────────────── */
function rawToFacts(rawData: any, sourceModel: FactSource, idPrefix: string): {
  facts: BiographyFact[];
  quotes: any[];
  sources: string[];
} {
  const facts: BiographyFact[] = [];

  if (rawData?.failures && Array.isArray(rawData.failures)) {
    rawData.failures.forEach((failure: any, index: number) => {
      facts.push({
        id: `${idPrefix}-${index + 1}`,
        title: failure.title || `Факт ${failure.number || index + 1}`,
        description: `${failure.description || ''}${failure.outcome ? '\n\n' + failure.outcome : ''}`.trim(),
        category: 'failure',
        year: failure.year ? parseInt(String(failure.year)) : undefined,
        severity: failure.severity || 3,
        sources: failure.source ? [failure.source] : [],
        visualSuggestion: failure.visual_suggestion || undefined,
        sourceModel,
      });
    });
  }

  const quotes = (rawData?.quotes || []).map((q: any, i: number) => ({
    id: `${idPrefix}-q${i + 1}`,
    text: q.text || '',
    context: q.context || '',
    source: q.source || 'Неизвестный источник',
    year: q.year ? parseInt(String(q.year)) : undefined,
  }));

  const sources = rawData?.sources || [];
  return { facts, quotes, sources };
}

/* ─────────────────────────────────────────────────────────────────────
 * Main entry point
 * ───────────────────────────────────────────────────────────────────── */

export async function performMultiResearch(
  articleId: string,
  mode: 'normal' | 'deep_dive' | 'restart' = 'normal',
  config: FactResearchConfig = DEFAULT_CONFIG
): Promise<ResearchData> {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) throw new Error('Article not found');

  // Filter sources to only those that have API keys configured.
  const enabled: FactSource[] = (Object.keys(config.sources) as FactSource[]).filter((s) => {
    if (!config.sources[s]) return false;
    if (s === 'perplexity') return !!process.env.PERPLEXITY_API_KEY;
    if (s === 'gpt') return !!process.env.OPENAI_API_KEY;
    if (s === 'claude') return !!process.env.ANTHROPIC_API_KEY;
    if (s === 'gemini') return !!process.env.GEMINI_API_KEY;
    return false;
  });

  if (enabled.length === 0) {
    throw new Error('Не выбрано ни одной модели для поиска фактов или нет соответствующих API-ключей.');
  }

  const language: 'ru' | 'en' | 'both' = (article as any).language === 'en'
    ? 'en'
    : (article as any).language === 'both'
      ? 'both'
      : 'ru';

  console.log(`📚 Multi-research for ${article.celebrityName}: sources=[${enabled.join(', ')}], lang=${language}`);

  emitResearchProgress(articleId, {
    status: 'searching',
    currentFact: 0,
    totalFacts: 12,
    percentage: 5,
    message: `Запускаем ${enabled.length} модель(ей) параллельно: ${enabled.join(', ')}...`,
    startedAt: new Date().toISOString(),
  });

  // ────────────────────────────────────────────────────────────
  // Step 1: Perplexity (kept separate because it has its own
  // sophisticated retry logic, framing variants, and DB save)
  // ────────────────────────────────────────────────────────────
  let primaryData: ResearchData | null = null;
  if (enabled.includes('perplexity')) {
    try {
      const { performPerplexityResearch } = await import('./perplexity-research');
      primaryData = await performPerplexityResearch(articleId, mode);
      // Tag perplexity facts
      primaryData.facts = primaryData.facts.map((f) => ({ ...f, sourceModel: 'perplexity' as const }));
    } catch (err: any) {
      console.warn(`Perplexity failed: ${err.message}. Continuing with other models.`);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Step 2: Secondary models in parallel
  // ────────────────────────────────────────────────────────────
  const secondary = enabled.filter((s) => s !== 'perplexity');
  const results = await Promise.allSettled(
    secondary.map(async (source) => {
      emitResearchProgress(articleId, {
        status: 'searching',
        currentFact: 0,
        totalFacts: 12,
        percentage: 30,
        message: `Опрашиваем ${source}...`,
        startedAt: new Date().toISOString(),
      });
      if (source === 'gpt') return { source, raw: await researchWithGPT(article.celebrityName, language) };
      if (source === 'claude') return { source, raw: await researchWithClaude(article.celebrityName, language) };
      if (source === 'gemini') return { source, raw: await researchWithGemini(article.celebrityName, language) };
      throw new Error(`Unknown source: ${source}`);
    })
  );

  // Collect facts/quotes from secondary models
  const extraFacts: BiographyFact[] = [];
  const extraQuotes: any[] = [];
  const extraSources: string[] = [];

  results.forEach((r, idx) => {
    const src = secondary[idx];
    if (r.status === 'fulfilled') {
      const { facts, quotes, sources } = rawToFacts(r.value.raw, src, `${src}-${Date.now().toString(36)}`);
      console.log(`  ✅ ${src}: ${facts.length} facts, ${quotes.length} quotes`);
      extraFacts.push(...facts);
      extraQuotes.push(...quotes);
      extraSources.push(...sources);
    } else {
      console.warn(`  ⚠️ ${src} failed: ${r.reason?.message || r.reason}`);
    }
  });

  // ────────────────────────────────────────────────────────────
  // Step 3: Merge with primary (Perplexity) data
  // ────────────────────────────────────────────────────────────
  let merged: ResearchData;

  if (primaryData) {
    merged = {
      ...primaryData,
      facts: [...primaryData.facts, ...extraFacts],
      quotes: [...primaryData.quotes, ...extraQuotes],
      sources: Array.from(new Set([...primaryData.sources, ...extraSources])),
    };
  } else {
    // No primary — build from scratch
    merged = {
      facts: extraFacts,
      quotes: extraQuotes,
      images: [],
      sources: Array.from(new Set(extraSources)),
      generatedAt: new Date(),
    };
  }

  // ────────────────────────────────────────────────────────────
  // Step 4: Save to DB
  // ────────────────────────────────────────────────────────────
  await prisma.article.update({
    where: { id: articleId },
    data: {
      researchData: merged as any,
      currentStage: PipelineStage.RESEARCH,
      updatedAt: new Date(),
    },
  });

  emitResearchProgress(articleId, {
    status: 'completed',
    currentFact: merged.facts.length,
    totalFacts: merged.facts.length,
    percentage: 100,
    message: `Найдено ${merged.facts.length} фактов из ${enabled.length} источника(ов)`,
    startedAt: new Date().toISOString(),
  });
  emitResearchComplete(articleId, merged);

  return merged;
}

/**
 * Convenience: parse FactResearchConfig from a possibly partial input,
 * defaulting any missing source to false (except perplexity → true).
 */
export function normalizeFactConfig(input: any): FactResearchConfig {
  const sources = input?.sources || {};
  return {
    sources: {
      perplexity: sources.perplexity !== false, // default true
      gpt: !!sources.gpt,
      claude: !!sources.claude,
      gemini: !!sources.gemini,
    },
  };
}
