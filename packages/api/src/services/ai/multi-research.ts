/**
 * Multi-model fact research orchestrator.
 *
 * Runs Perplexity (web search) AND optional GPT/Claude/Gemini (parametric)
 * in parallel, merges all facts into one combined ResearchData blob,
 * tagging each fact with its source model so the user can see provenance.
 *
 * Why three direct-LLM models on top of Perplexity:
 * - Perplexity excels at fresh web evidence + citations
 * - GPT-4o, Claude, Gemini have different training cuts and complementary
 *   recall — between them they catch facts Perplexity's web crawl missed
 * - User-driven curation: more raw material → more interesting article
 *
 * Each non-Perplexity model returns the SAME JSON shape Perplexity does, so
 * the existing `convertToResearchData` logic can absorb them with a tiny
 * post-processing step (sourceModel tagging).
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { prisma } from '../../lib/db';
import { PipelineStage, ResearchData, BiographyFact } from '@content-pipeline/shared';
import { emitResearchProgress, emitResearchComplete, emitResearchError } from '../../lib/socket';

export type FactSource = 'perplexity' | 'gpt' | 'claude' | 'gemini';

export interface FactResearchConfig {
  sources: Record<FactSource, boolean>;
}

const DEFAULT_CONFIG: FactResearchConfig = {
  sources: { perplexity: true, gpt: false, claude: false, gemini: false },
};

/**
 * Build a compact research prompt that any model can answer with the same
 * JSON shape. This is intentionally simpler than the Perplexity prompt
 * (no framing variants, no thin-response retry) because the secondary
 * models are supplementary and only need to produce CONTRIBUTING facts —
 * Perplexity (or whichever model is primary) already covered the
 * baseline.
 */
function buildResearchPrompt(celebrityName: string, language: 'ru' | 'en' | 'both'): string {
  const langDirective = language === 'ru'
    ? 'ВСЕ поля JSON должны быть на русском языке (включая заголовки, описания, цитаты).'
    : language === 'both'
      ? 'Основной язык — русский. Цитаты можно дублировать в скобках на оригинале.'
      : 'All JSON fields must be in clear English.';

  return `You are compiling material for a biographical long-form piece about ${celebrityName}
in the "Great Losers / Великие Неудачники" series. The series shows the documented
chain of failures, humiliations, rejections, addictions, scandals, financial collapses
and personal crises that preceded a famous person's eventual success.

${langDirective}

═══════════════════════════════════════════════════════════════
🎯 WHAT TO LOOK FOR — focus exclusively on these categories
═══════════════════════════════════════════════════════════════

✅ DRAMATIC FAILURES with concrete details:
• Childhood hardship: poverty, abusive/absent parent, orphanage, bullying
• School: expulsion, dropout, social rejection, learning struggles
• Early career: rejections (named person who said no, how many times),
  failed auditions/pitches/businesses, humiliating first jobs
• Financial: bankruptcy with figures, exact debt amounts, lowest bank balance,
  homelessness, sleeping in car/couch, foreclosures
• Personal: divorces with public fallout, custody losses, estranged family,
  addictions (specific substances + clinic stays), mental health crises,
  suicide attempts, deaths of close ones and impact on career
• Public scandals: arrests, lawsuits, prison time (exact days/months),
  fired from major project, cancelled, blacklisted
• Mid-career collapses: critically panned project (review scores, box office),
  feuds with studio/label/partner, comeback that flopped
• Health: serious illness, accidents, near-death

❌ DO NOT include vague phrases like "faced challenges" or "overcame obstacles"
❌ DO NOT include generic praise or career highlights — that goes in "success" only
❌ DO NOT pad with non-dramatic biographical filler

═══════════════════════════════════════════════════════════════
📚 SOURCE QUALITY — search across ALL of these in your knowledge:
═══════════════════════════════════════════════════════════════

For maximum coverage, draw from these source TYPES (not just Wikipedia):
• Authorized & unauthorized biographies (full book titles + authors)
• Subject's own autobiography / memoir (page references if known)
• Long-form profile pieces: New Yorker, Vanity Fair, Rolling Stone,
  Guardian Long Read, Esquire, GQ, Atlantic, NYT Magazine
• Major interview transcripts: Howard Stern, Joe Rogan, Hot Ones,
  Marc Maron WTF, Fresh Air NPR, Charlie Rose, 60 Minutes,
  Jimmy Kimmel, Letterman, Oprah's Master Class
• Documentary films & series featuring the subject
• Court records, bankruptcy filings, divorce filings (publicly available)
• Industry trade press: Variety, Hollywood Reporter, Billboard, Deadline
• Russian-language sources where applicable: Коммерсантъ, Forbes Russia,
  Афиша, Esquire Russia, RBK, Lenta.ru, interviews on YouTube
  (Дудь, Собчак, Ирина Шихман, Гордеева, Осторожно, Собчак)
• Behind-the-scenes accounts from co-stars, ex-managers, ex-spouses
• Podcast deep-dives: Behind the Bastards, You Must Remember This,
  The Dollop, Last Podcast on the Left

Search MEMORY across all of these — do not stop at the first 3 facts you recall.

═══════════════════════════════════════════════════════════════
🗓️ STRUCTURE — must cover these life phases (at least 1 fact each)
═══════════════════════════════════════════════════════════════

1. CHILDHOOD (ages 5–15): family situation, hardship, school
2. EARLY ATTEMPTS (ages 15–22): first jobs, dropouts, first failures
3. STRUGGLE YEARS (ages 22–30): rejections, debts, what kept them going
4. PERSONAL CRISES (any age): relationships, addictions, mental health
5. CAREER SETBACKS (ages 30+): public flops, scandals, comebacks-that-failed
6. TURNING POINT: the specific person/film/album/decision that changed it

If you don't have a fact for a phase, leave that gap — DO NOT invent.
Better 6 verified facts than 12 with fabrications.

═══════════════════════════════════════════════════════════════
📋 OUTPUT REQUIREMENTS for EACH fact
═══════════════════════════════════════════════════════════════

- Exact age AND/OR year (numeric)
- Concrete figures: dollar amounts, durations, quantities, dates
- Named people, places, companies where applicable
- Direct quote ONLY if you are 100% certain it is real and verbatim
- Source attribution: book title / publication / show name + date

═══════════════════════════════════════════════════════════════
🛑 ANTI-FABRICATION RULES (critical)
═══════════════════════════════════════════════════════════════

• If uncertain about a number, use a range or omit it. Don't guess.
• Never transfer a fact from another celebrity (e.g. don't borrow
  Chaplin's lookalike-contest story for an unrelated person).
• If a quote is paraphrased in your memory, set quotes[].text = "" and
  describe what they said in context.
• If you cannot find a fact for a category, return an empty array
  for that category rather than padding.

Output ONLY valid JSON in this exact shape, no prose before or after:

{
  "teaser": {
    "known_for": "What they are publicly famous for (3-4 achievements with figures)",
    "hidden_drama": "The contrast — the struggle behind the fame"
  },
  "failures": [
    {
      "number": 1,
      "title": "Short punchy headline with a specific detail (4-10 words)",
      "age": "exact age at the time, e.g. '14' or 'age 22'",
      "year": "exact year, e.g. '1997'",
      "phase": "childhood | early_attempts | struggle | personal_crisis | career_setback | turning_point",
      "description": "Detailed account with figures, names, places (3-5 sentences)",
      "outcome": "What happened next / how this led somewhere",
      "severity": 4,
      "source": "Specific source: book / article / interview + publication + date",
      "visual_suggestion": "Photo description showing ${celebrityName} in this period"
    }
  ],
  "quotes": [
    {
      "text": "EXACT quote (not a paraphrase) — leave empty if uncertain",
      "context": "When and why they said it",
      "source": "Where the quote is from (book/interview/show + date)",
      "suitable_for_ending": true
    }
  ],
  "success": {
    "peak_achievement": "Top achievement with figures",
    "current_status": "Where they are now",
    "wealth": "Net worth / income with figures",
    "awards": ["awards with years"],
    "personal_life": "Family, children if public"
  },
  "bonus_fact": "One genuinely interesting little-known fact — ONLY if you are certain it is real, otherwise null",
  "sources": ["full list of sources used"]
}

CRITICAL: Do not invent facts. If you do not know something, omit the field or set it to null.
Do not embellish. Do not transfer facts from other celebrities. Concrete numbers must be exact.`;
}

/* ─────────────────────────────────────────────────────────────────────
 * Per-model callers
 * Each one returns parsed rawData (same JSON shape as Perplexity output)
 * or throws.
 * ───────────────────────────────────────────────────────────────────── */

async function researchWithGPT(celebrityName: string, language: 'ru' | 'en' | 'both'): Promise<any> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`  🧠 GPT-4o researching ${celebrityName}...`);
  const completion = await Promise.race([
    openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            'You are a senior biographical research consultant. You produce well-sourced, fact-checked biographical material. You never fabricate quotes, dates, or events. When uncertain, you omit the field.',
        },
        { role: 'user', content: buildResearchPrompt(celebrityName, language) },
      ],
      temperature: 0.3,
      max_tokens: 12000,
      response_format: { type: 'json_object' },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('GPT timeout after 3 minutes')), 180000)
    ),
  ]);
  const content = completion.choices[0]?.message?.content || '{}';
  return JSON.parse(content);
}

async function researchWithClaude(celebrityName: string, language: 'ru' | 'en' | 'both'): Promise<any> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`  🤖 Claude Sonnet researching ${celebrityName}...`);
  const message = await Promise.race([
    anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 12000,
      system:
        'You are a senior biographical research consultant. You produce well-sourced, fact-checked biographical material. You NEVER fabricate quotes, dates, or events. When uncertain, you omit the field. Output ONLY valid JSON, no prose, no markdown fences.',
      messages: [{ role: 'user', content: buildResearchPrompt(celebrityName, language) }],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Claude timeout after 3 minutes')), 180000)
    ),
  ]);
  const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
  // Strip possible markdown fences
  let json = text.trim();
  if (json.startsWith('```json')) json = json.replace(/^```json\s*/, '').replace(/```\s*$/, '');
  else if (json.startsWith('```')) json = json.replace(/^```\s*/, '').replace(/```\s*$/, '');
  const match = json.match(/\{[\s\S]*\}/);
  if (match) json = match[0];
  return JSON.parse(json);
}

async function researchWithGemini(celebrityName: string, language: 'ru' | 'en' | 'both'): Promise<any> {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  console.log(`  💎 Gemini researching ${celebrityName}...`);
  const result = await Promise.race([
    ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'You are a senior biographical research consultant. You never fabricate quotes, dates, or events. Output ONLY valid JSON.\n\n' +
                buildResearchPrompt(celebrityName, language),
            },
          ],
        },
      ],
      config: {
        temperature: 0.3,
        maxOutputTokens: 12000,
        responseMimeType: 'application/json',
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout after 3 minutes')), 180000)
    ),
  ]);
  const text = (result as any)?.text || (result as any)?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  let json = text.trim();
  if (json.startsWith('```json')) json = json.replace(/^```json\s*/, '').replace(/```\s*$/, '');
  else if (json.startsWith('```')) json = json.replace(/^```\s*/, '').replace(/```\s*$/, '');
  const match = json.match(/\{[\s\S]*\}/);
  if (match) json = match[0];
  return JSON.parse(json);
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
