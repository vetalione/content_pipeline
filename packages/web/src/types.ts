/**
 * Pipeline stage types
 */
export enum PipelineStage {
  INPUT = 'input',
  RESEARCH = 'research',
  GENERATION = 'generation',
  COVER = 'cover',
  REVIEW = 'review',
  PUBLISHING = 'publishing',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

export enum ArticleStatus {
  DRAFT = 'draft',
  IN_PROGRESS = 'in_progress',
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  PUBLISHED = 'published',
  FAILED = 'failed'
}

/**
 * Article data structure
 */
export interface Article {
  id: string;
  celebrityName: string;
  status: ArticleStatus;
  currentStage: PipelineStage;
  createdAt: Date;
  updatedAt: Date;
  
  // Research data
  researchData?: ResearchData;
  
  // Generated content
  content?: ArticleContent;
  
  // Cover image
  coverImage?: CoverImage;
  
  // Publishing info
  publications?: Publication[];
}

/**
 * Research data from AI
 */
export interface ResearchData {
  facts: BiographyFact[];
  quotes: Quote[];
  images: ImageReference[];
  sources: string[];
  generatedAt: Date;
}

export interface BiographyFact {
  id: string;
  title: string;
  description: string;
  category: 'failure' | 'tragedy' | 'controversy' | 'struggle' | 'success';
  year?: number;
  severity: 1 | 2 | 3 | 4 | 5; // Drama level
  sources: string[];
}

export interface Quote {
  id: string;
  text: string;
  context: string;
  source: string;
  year?: number;
}

export interface ImageReference {
  id: string;
  url: string;
  description: string;
  source: string;
  isRare: boolean;
  year?: number;
}

/**
 * Generated article content
 */
export interface ArticleContent {
  title: string;
  subtitle: string;
  intro: string;
  sections: ArticleSection[];
  conclusion: string;
  motivation: string;
  generatedAt: Date;
}

export interface ArticleSection {
  id: string;
  order: number;
  title: string;
  content: string;
  quote?: Quote;
  memeText?: string;
  images: ImageReference[];
}

/**
 * Cover image
 */
export interface CoverImage {
  id: string;
  originalImageUrl: string;
  processedImageUrl: string;
  localPath: string;
  template: string;
  generatedAt: Date;
}

/**
 * Social media platforms
 */
export enum Platform {
  TELEGRAM = 'telegram',
  VK = 'vk',
  INSTAGRAM = 'instagram',
  YOUTUBE = 'youtube',
  MEDIUM = 'medium',
  FACEBOOK = 'facebook',
  TWITTER = 'twitter',
  LINKEDIN = 'linkedin',
  THREADS = 'threads',
  DZEN = 'dzen'
}

export enum Language {
  RU = 'ru',
  EN = 'en',
  BOTH = 'both'
}

/**
 * Publication record
 */
export interface Publication {
  id: string;
  articleId: string;
  platform: Platform;
  status: 'pending' | 'publishing' | 'published' | 'failed';
  publishedUrl?: string;
  publishedAt?: Date;
  error?: string;
}

/**
 * Publishing options
 */
  // language preference for generated content: 'ru' | 'en' | 'both'
  language: Language;
export interface PublishingOptions {
  platforms: Platform[];
  scheduledAt?: Date;
  customizations?: {
    [key in Platform]?: PlatformCustomization;
  };
}

export interface PlatformCustomization {
  title?: string;
  description?: string;
  hashtags?: string[];
  mentions?: string[];
}

/**
 * Pipeline job data
 */
export interface PipelineJob {
  articleId: string;
  stage: PipelineStage;
  data: any;
  priority?: number;
}

/**
 * API Response types
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Configuration types
 */
export interface AIConfig {
  provider: 'openai' | 'anthropic' | 'gemini';
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface StyleConfig {
  tone: string;
  pointsCount: number;
  includeQuotes: boolean;
  includeMemes: boolean;
  language: string;
}
