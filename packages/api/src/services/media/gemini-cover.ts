import { GoogleGenAI } from '@google/genai';
import { promises as fs } from 'fs';
import path from 'path';

// Lazy initialization - will be created on first use with actual env var value
let genAI: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    console.log('🔑 Initializing Gemini client with API key:', apiKey.substring(0, 10) + '...');
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

// Profession to icons mapping
const PROFESSION_ICONS: Record<string, string[]> = {
  // Music
  'певец': ['musical notes', 'microphone', 'vinyl record'],
  'певица': ['musical notes', 'microphone', 'heart'],
  'музыкант': ['guitar', 'musical notes', 'piano keys'],
  'рэпер': ['microphone', 'headphones', 'chain necklace'],
  'композитор': ['treble clef', 'piano', 'sheet music'],
  'диджей': ['turntable', 'headphones', 'sound waves'],
  
  // Acting
  'актер': ['film reel', 'theater masks', 'Oscar statue'],
  'актриса': ['film reel', 'theater masks', 'star'],
  'режиссер': ['film clapper', 'director chair', 'camera'],
  'комик': ['laughing face', 'microphone', 'spotlight'],
  
  // Sports
  'боксер': ['boxing gloves', 'championship belt', 'punching bag'],
  'футболист': ['soccer ball', 'goal net', 'trophy'],
  'баскетболист': ['basketball', 'hoop', 'sneakers'],
  'теннисист': ['tennis racket', 'tennis ball', 'net'],
  'гонщик': ['racing car', 'checkered flag', 'helmet'],
  'боец': ['fist', 'octagon', 'championship belt'],
  
  // Science & Tech
  'ученый': ['atom', 'test tube', 'microscope'],
  'физик': ['E=mc²', 'atom', 'equations'],
  'изобретатель': ['light bulb', 'gears', 'blueprint'],
  'программист': ['code brackets', 'laptop', 'binary code'],
  'предприниматель': ['rocket', 'chart', 'light bulb'],
  
  // Literature & Art
  'писатель': ['book', 'quill pen', 'inkwell'],
  'художник': ['paint brush', 'palette', 'canvas'],
  'поэт': ['feather', 'scroll', 'rose'],
  
  // Politics & Leadership
  'политик': ['podium', 'flag', 'dove'],
  'президент': ['seal', 'flag', 'podium'],
  'революционер': ['raised fist', 'flag', 'broken chain'],
  
  // Fashion & Lifestyle
  'модель': ['runway', 'camera flash', 'high heels'],
  'дизайнер': ['scissors', 'mannequin', 'fabric'],
  
  // Famous people specific icons
  'павел дуров': ['paper airplane (Telegram icon)', 'phone', 'lock'],
  'илон маск': ['rocket', 'Tesla logo', 'Mars planet'],
  'стив джобс': ['bitten apple', 'iPhone', 'infinity'],
  'эйнштейн': ['E=mc²', 'brain', 'atom'],
  'альберт эйнштейн': ['E=mc²', 'brain', 'atom'],
  'конор макгрегор': ['boxing gloves', 'UFC octagon', 'Irish flag'],
  'майк тайсон': ['boxing gloves', 'pigeon', 'championship belt'],
  'мохаммед али': ['boxing gloves', 'bee', 'butterfly'],
  'уилл смит': ['Oscar statue', 'microphone', 'crown'],
  'мэрилин монро': ['red lips', 'diamond', 'wind-blown dress'],
  'чарли чаплин': ['bowler hat', 'cane', 'silent film reel'],
  'никола тесла': ['lightning bolt', 'coil', 'AC current symbol'],
  'леонардо да винчи': ['Vitruvian man', 'paint brush', 'gears'],
  'мария кюри': ['radiation symbol', 'test tube', 'Nobel medal'],
  'стивен хокинг': ['black hole', 'wheelchair', 'stars'],
  'фрида кало': ['flower crown', 'unibrow', 'heart'],
  'пабло пикассо': ['cubist eye', 'paint brush', 'bull'],
  'сальвадор дали': ['melting clock', 'mustache', 'elephant'],
  'курт кобейн': ['guitar', 'grunge star', 'broken heart'],
  'эми уайнхаус': ['beehive hair', 'microphone', 'broken heart'],
  'адель': ['microphone', 'vinyl record', 'tears'],
};

// Color palette for random selection
const COLOR_COMBINATIONS = [
  'vibrant orange and yellow',
  'electric blue and purple',
  'fiery red and orange',
  'neon green and cyan',
  'golden yellow and amber',
  'deep purple and magenta',
  'sunset pink and coral',
  'ocean blue and turquoise',
  'emerald green and gold',
  'crimson red and black',
  'royal purple and silver',
  'tropical teal and lime',
];

export interface CoverGenerationOptions {
  heroName: string;
  title: string;
  colorScheme?: string;
  icons?: string[];
  sharpFact?: string;
  articleContent?: any;
}

/**
 * Extract sharp fact from article content
 */
function extractSharpFact(content: any, heroName: string): string {
  const sharpFactPatterns = [
    /потерял|потеряла|лишился|лишилась/i,
    /жил с |жила с |спал на |спала на /i,
    /банкрот|долг|нищ|бедн/i,
    /умер|умерла|погиб|скончал/i,
    /отверг|отказ|провал|провалил/i,
    /наркотик|алкогол|зависим/i,
    /тюрьм|арест|суд|обвин/i,
    /болезн|болен|страдал|страдала/i,
    /бросил|бросила|ушел|ушла/i,
    /выгнали|уволили|исключили/i,
  ];

  let bestFact = '';
  let bestScore = 0;

  if (content.sections) {
    for (const section of content.sections) {
      const text = section.paragraph1 || section.content || '';
      for (const pattern of sharpFactPatterns) {
        if (pattern.test(text)) {
          const match = text.match(pattern);
          if (match && match.index !== undefined) {
            const start = Math.max(0, match.index - 20);
            const end = Math.min(text.length, match.index + 50);
            const snippet = text.slice(start, end).trim();
            const score = sharpFactPatterns.filter(p => p.test(snippet)).length;
            if (score > bestScore) {
              bestScore = score;
              bestFact = snippet;
            }
          }
        }
      }
    }
  }

  if (!bestFact && content.sections?.[0]) {
    const firstSection = content.sections[0];
    const heading = firstSection.heading || firstSection.title || '';
    bestFact = heading.length > 5 ? heading : 'путь к славе';
  }

  const words = bestFact.split(/\s+/).slice(0, 5);
  return words.join(' ').replace(/[.,!?;:]$/, '');
}

/**
 * Get icons based on hero name and profession
 */
function getIconsForHero(heroName: string, content?: any): string[] {
  const nameLower = heroName.toLowerCase();
  
  for (const [key, icons] of Object.entries(PROFESSION_ICONS)) {
    if (nameLower.includes(key)) {
      return icons;
    }
  }

  if (content?.sections) {
    const allText = content.sections.map((s: any) => 
      (s.paragraph1 || '') + (s.paragraph2 || '') + (s.content || '')
    ).join(' ').toLowerCase();
    
    for (const [profession, icons] of Object.entries(PROFESSION_ICONS)) {
      if (allText.includes(profession)) {
        return icons;
      }
    }
  }

  return ['star', 'spotlight', 'crown'];
}

/**
 * Get random color combination
 */
function getRandomColors(): string {
  return COLOR_COMBINATIONS[Math.floor(Math.random() * COLOR_COMBINATIONS.length)];
}

/**
 * Generate cover image using Gemini with native image generation (supports Russian text)
 */
export async function generateCoverImage(options: CoverGenerationOptions): Promise<{
  success: boolean;
  imageBase64?: string;
  imagePath?: string;
  error?: string;
}> {
  const {
    heroName,
    title,
    colorScheme = getRandomColors(),
    icons = getIconsForHero(heroName, options.articleContent),
    sharpFact = extractSharpFact(options.articleContent || {}, heroName),
  } = options;

  const iconsText = icons.join(', ');
  
  // Prompt with Russian text for title and sharp fact
  const prompt = `A realistic photo collage cover art. The central figure is a cutout portrait of ${heroName} in their prime, looking directly at the viewer with a characteristic expression. This portrait is superimposed over a dark, textured chalkboard background covered with faint chalk scratches and scrawls. Behind the figure's silhouette is a vibrant, textured ${colorScheme} cloud or aura, rendered in a style that mimics a chalk or pastel drawing, billowing outwards. Add chalk-drawn ${iconsText} related to the subject. At the top, in a chalk-written font, is the title "${title}". A chalk-drawn arrow points to the figure with the text "${sharpFact}" next to it. The overall style is a mix of photography and chalk illustration on a worn chalkboard surface.`;

  console.log('🎨 Generating cover with Gemini Nano Banana (Russian support)...');
  console.log('📝 Prompt:', prompt);

  try {
    const client = getGenAI();
    
    // Use gemini-2.0-flash-exp with generateContent for native image generation
    // This model supports Russian text in images
    const response = await client.models.generateContent({
      model: 'gemini-2.0-flash-exp',
      contents: prompt,
      config: {
        responseModalities: ['Text', 'Image'],
      },
    });

    // Find image in response parts
    let imageBase64: string | null = null;
    
    if (response.candidates && response.candidates[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
          imageBase64 = part.inlineData.data || null;
          break;
        }
      }
    }

    if (!imageBase64) {
      // Log response for debugging
      console.log('Response structure:', JSON.stringify(response, null, 2).substring(0, 1000));
      throw new Error('No image in response');
    }
    
    const coversDir = path.join(process.cwd(), 'covers');
    await fs.mkdir(coversDir, { recursive: true });
    
    const fileName = `cover_${Date.now()}.jpg`;
    const filePath = path.join(coversDir, fileName);
    
    await fs.writeFile(filePath, Buffer.from(imageBase64, 'base64'));
    
    console.log('✅ Cover image generated and saved:', filePath);

    return {
      success: true,
      imageBase64,
      imagePath: filePath,
    };
  } catch (error: any) {
    console.error('❌ Gemini Imagen error:', error);
    return {
      success: false,
      error: error.message || 'Failed to generate cover image',
    };
  }
}

/**
 * Get cover generation options preview
 */
export function getCoverPreviewOptions(heroName: string, articleContent?: any): {
  suggestedColors: string[];
  suggestedIcons: string[];
  suggestedFact: string;
} {
  return {
    suggestedColors: COLOR_COMBINATIONS.slice(0, 6),
    suggestedIcons: getIconsForHero(heroName, articleContent),
    suggestedFact: extractSharpFact(articleContent || {}, heroName),
  };
}

/**
 * Get all available color combinations
 */
export function getAllColorCombinations(): string[] {
  return COLOR_COMBINATIONS;
}
