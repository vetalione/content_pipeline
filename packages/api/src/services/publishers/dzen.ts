/**
 * Яндекс Дзен (dzen.ru) Publisher
 * Автоматическая публикация статей через Playwright
 * 
 * ОСОБЕННОСТИ ДЗЕН:
 * - Блочный редактор (заголовок, текст, изображение, цитата)
 * - Обложка загружается отдельно
 * - Требует авторизации через Яндекс ID
 * - Сессия сохраняется в файл для повторного использования
 * 
 * СТРУКТУРА СТАТЬИ В ДЗЕН:
 * 1. Заголовок (title)
 * 2. Обложка (cover image)
 * 3. Тизер/подзаголовок (teaser)
 * 4. Секции: 
 *    - Подзаголовок (heading)
 *    - Параграфы (paragraph1, paragraph2)
 *    - Цитата (blockquote) - опционально
 *    - Изображение (imageUrl) - опционально
 * 5. Заключение
 * 6. CTA
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { ArticleContent, CoverImage } from '@content-pipeline/shared';

// Use 'any' for Article since Prisma returns different type than shared
type ArticleWithCover = {
  id: string;
  celebrityName: string;
  content: ArticleContent | any;
  coverImages?: CoverImage[];
  coverImage?: CoverImage;
  [key: string]: any;
};

// Section type with optional imageUrl
interface DzenSection {
  number: number;
  heading: string;
  paragraph1: string;
  paragraph2?: string;
  blockquote?: string | null;
  imageUrl?: string;
}

const SESSIONS_DIR = path.resolve(__dirname, './sessions');
const DZEN_STATE_FILE = path.join(SESSIONS_DIR, 'dzen-state.json');

// Timeouts
const NAVIGATION_TIMEOUT = 30000;
const ACTION_TIMEOUT = 10000;
const UPLOAD_TIMEOUT = 60000;

interface DzenPublishResult {
  success: boolean;
  url?: string;
  error?: string;
  articleId?: string;
}

interface DzenPublishOptions {
  draft?: boolean;  // Save as draft instead of publishing
  scheduledAt?: Date;  // Schedule for later
}

/**
 * Ensure sessions directory exists
 */
function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/**
 * Load saved browser context with cookies
 */
async function loadContext(browser: Browser): Promise<BrowserContext> {
  ensureSessionsDir();
  
  if (fs.existsSync(DZEN_STATE_FILE)) {
    console.log('📂 Loading saved Dzen session...');
    return await browser.newContext({ 
      storageState: DZEN_STATE_FILE,
      viewport: { width: 1280, height: 900 }
    });
  }
  
  console.log('⚠️ No saved Dzen session found. Run setupDzenAuth() first.');
  return await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
}

/**
 * Save browser context (cookies, localStorage)
 */
async function saveContext(context: BrowserContext) {
  ensureSessionsDir();
  await context.storageState({ path: DZEN_STATE_FILE });
  console.log('💾 Dzen session saved');
}

/**
 * Check if user is logged in to Dzen
 */
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    // Look for user menu or profile elements
    const userMenu = await page.$('[data-testid="user-menu"], .user-menu, .user-pic, [class*="UserPic"]');
    if (userMenu) return true;
    
    // Alternative: check for "Write" or "Create" button
    const createButton = await page.$('a[href*="/editor"], button:has-text("Написать"), button:has-text("Создать")');
    if (createButton) return true;
    
    // Check URL for zen studio
    const url = page.url();
    if (url.includes('dzen.ru/profile') || url.includes('dzen.ru/id')) return true;
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Navigate to Dzen editor and create new article
 */
async function navigateToEditor(page: Page): Promise<boolean> {
  console.log('📝 Navigating to Dzen editor...');
  
  try {
    // Go to Dzen Studio / Editor
    await page.goto('https://dzen.ru/editor/new', { 
      waitUntil: 'networkidle',
      timeout: NAVIGATION_TIMEOUT 
    });
    
    // Wait for editor to load
    await page.waitForSelector('[contenteditable="true"], .editor-content, [class*="Editor"]', {
      timeout: ACTION_TIMEOUT
    });
    
    console.log('✅ Editor loaded');
    return true;
  } catch (error) {
    console.error('❌ Failed to load editor:', error);
    
    // Try alternative paths
    try {
      await page.goto('https://dzen.ru/profile', { timeout: NAVIGATION_TIMEOUT });
      
      // Click "Create" or "Write" button
      const createBtn = await page.$('a[href*="/editor"], button:has-text("Написать"), button:has-text("Создать"), [data-testid="create-button"]');
      if (createBtn) {
        await createBtn.click();
        await page.waitForNavigation({ waitUntil: 'networkidle' });
        return true;
      }
    } catch (e) {
      console.error('❌ Alternative path also failed:', e);
    }
    
    return false;
  }
}

/**
 * Set article title
 */
async function setTitle(page: Page, title: string): Promise<boolean> {
  console.log(`📰 Setting title: "${title.substring(0, 50)}..."`);
  
  try {
    // Find title input (usually first contenteditable or specific title field)
    const titleSelectors = [
      '[data-testid="title-input"]',
      'h1[contenteditable="true"]',
      '.article-title[contenteditable="true"]',
      '[class*="Title"][contenteditable="true"]',
      '[placeholder*="Заголовок"]',
      '[placeholder*="Title"]'
    ];
    
    for (const selector of titleSelectors) {
      const titleInput = await page.$(selector);
      if (titleInput) {
        await titleInput.click();
        await titleInput.fill(title);
        console.log('✅ Title set');
        return true;
      }
    }
    
    // Fallback: try first contenteditable
    const firstEditable = await page.$('[contenteditable="true"]');
    if (firstEditable) {
      await firstEditable.click();
      await firstEditable.fill(title);
      return true;
    }
    
    console.error('❌ Could not find title input');
    return false;
  } catch (error) {
    console.error('❌ Error setting title:', error);
    return false;
  }
}

/**
 * Add text block to editor
 */
async function addTextBlock(page: Page, text: string): Promise<boolean> {
  try {
    // Press Enter to create new block
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    // Type the text
    await page.keyboard.type(text, { delay: 5 });
    
    return true;
  } catch (error) {
    console.error('❌ Error adding text block:', error);
    return false;
  }
}

/**
 * Add heading block (H2/H3)
 */
async function addHeading(page: Page, text: string, level: 2 | 3 = 2): Promise<boolean> {
  console.log(`📌 Adding heading: "${text.substring(0, 40)}..."`);
  
  try {
    // Press Enter for new block
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    // Try markdown shortcut (## for H2, ### for H3)
    const prefix = level === 2 ? '## ' : '### ';
    await page.keyboard.type(prefix + text);
    await page.keyboard.press('Enter');
    
    return true;
  } catch (error) {
    console.error('❌ Error adding heading:', error);
    return false;
  }
}

/**
 * Add blockquote
 */
async function addBlockquote(page: Page, text: string): Promise<boolean> {
  console.log(`💬 Adding blockquote: "${text.substring(0, 40)}..."`);
  
  try {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    // Try markdown shortcut for quote
    await page.keyboard.type('> ' + text);
    await page.keyboard.press('Enter');
    
    return true;
  } catch (error) {
    console.error('❌ Error adding blockquote:', error);
    return false;
  }
}

/**
 * Upload image from URL
 */
async function addImageFromUrl(page: Page, imageUrl: string): Promise<boolean> {
  console.log(`🖼️ Adding image: ${imageUrl.substring(0, 60)}...`);
  
  try {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    // Try to find image upload button or use keyboard shortcut
    // Dzen editor usually has /image or similar command
    
    // Method 1: Try slash command
    await page.keyboard.type('/image');
    await page.waitForTimeout(500);
    
    // Press Enter to select image block
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    // Look for URL input in image dialog
    const urlInput = await page.$('input[placeholder*="URL"], input[placeholder*="ссылк"], input[type="url"]');
    if (urlInput) {
      await urlInput.fill(imageUrl);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      return true;
    }
    
    // Method 2: Try paste URL directly (some editors support this)
    await page.keyboard.type(imageUrl);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    
    return true;
  } catch (error) {
    console.error('❌ Error adding image:', error);
    return false;
  }
}

/**
 * Upload cover image
 */
async function uploadCover(page: Page, coverImage: CoverImage | string): Promise<boolean> {
  const imageUrl = typeof coverImage === 'string' 
    ? coverImage 
    : (coverImage.processedImageUrl || coverImage.originalImageUrl);
  
  console.log(`🎨 Uploading cover: ${imageUrl.substring(0, 60)}...`);
  
  try {
    // Look for cover upload button
    const coverSelectors = [
      '[data-testid="cover-upload"]',
      'button:has-text("Обложка")',
      'button:has-text("Cover")',
      '[class*="Cover"] button',
      '.cover-upload'
    ];
    
    for (const selector of coverSelectors) {
      const coverBtn = await page.$(selector);
      if (coverBtn) {
        await coverBtn.click();
        await page.waitForTimeout(500);
        
        // Look for URL input
        const urlInput = await page.$('input[placeholder*="URL"], input[type="url"]');
        if (urlInput) {
          await urlInput.fill(imageUrl);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2000);
          return true;
        }
      }
    }
    
    console.log('⚠️ Cover upload button not found, skipping');
    return false;
  } catch (error) {
    console.error('❌ Error uploading cover:', error);
    return false;
  }
}

/**
 * Add a complete section (heading + paragraphs + optional quote + optional image)
 */
async function addSection(page: Page, section: DzenSection): Promise<boolean> {
  console.log(`📝 Adding section ${section.number}: "${section.heading.substring(0, 40)}..."`);
  
  try {
    // Add section heading
    await addHeading(page, `${section.number}. ${section.heading}`);
    
    // Add first paragraph
    await addTextBlock(page, section.paragraph1);
    
    // Add second paragraph if exists
    if (section.paragraph2) {
      await addTextBlock(page, section.paragraph2);
    }
    
    // Add blockquote if exists
    if (section.blockquote) {
      await addBlockquote(page, section.blockquote);
    }
    
    // Add image if exists
    if (section.imageUrl) {
      await addImageFromUrl(page, section.imageUrl);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Error adding section ${section.number}:`, error);
    return false;
  }
}

/**
 * Publish the article
 */
async function clickPublish(page: Page, options: DzenPublishOptions = {}): Promise<string | null> {
  console.log('🚀 Publishing article...');
  
  try {
    // Find publish button
    const publishSelectors = [
      'button:has-text("Опубликовать")',
      'button:has-text("Publish")',
      '[data-testid="publish-button"]',
      'button[type="submit"]:has-text("Готово")',
      '.publish-button'
    ];
    
    for (const selector of publishSelectors) {
      const publishBtn = await page.$(selector);
      if (publishBtn) {
        await publishBtn.click();
        await page.waitForTimeout(2000);
        
        // Wait for confirmation or redirect
        await page.waitForNavigation({ 
          waitUntil: 'networkidle',
          timeout: NAVIGATION_TIMEOUT 
        }).catch(() => {});
        
        // Get the published URL
        const url = page.url();
        if (url.includes('/a/') || url.includes('/media/') || url.includes('dzen.ru')) {
          console.log(`✅ Published: ${url}`);
          return url;
        }
        
        // Look for success message with link
        const successLink = await page.$('a[href*="/a/"], a[href*="/media/"]');
        if (successLink) {
          const href = await successLink.getAttribute('href');
          if (href) {
            const fullUrl = href.startsWith('http') ? href : `https://dzen.ru${href}`;
            console.log(`✅ Published: ${fullUrl}`);
            return fullUrl;
          }
        }
        
        return url;
      }
    }
    
    console.error('❌ Publish button not found');
    return null;
  } catch (error) {
    console.error('❌ Error publishing:', error);
    return null;
  }
}

/**
 * Main publish function
 */
export async function publishToDzen(
  article: ArticleWithCover,
  options: DzenPublishOptions = {}
): Promise<DzenPublishResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📰 Publishing to Dzen: "${article.celebrityName}"`);
  console.log(`${'='.repeat(60)}\n`);
  
  const content = article.content as ArticleContent | null;
  
  if (!content) {
    return {
      success: false,
      error: 'Article has no content'
    };
  }
  
  const browser = await chromium.launch({ 
    headless: false,  // Set to true for production
    slowMo: 100  // Slow down for visibility
  });
  
  try {
    const context = await loadContext(browser);
    const page = await context.newPage();
    
    // Navigate to Dzen
    await page.goto('https://dzen.ru/', { 
      waitUntil: 'networkidle',
      timeout: NAVIGATION_TIMEOUT 
    });
    
    // Check if logged in
    if (!await isLoggedIn(page)) {
      await saveContext(context);
      return {
        success: false,
        error: 'Not logged in to Dzen. Run setupDzenAuth() first.'
      };
    }
    
    console.log('✅ Logged in to Dzen');
    
    // Navigate to editor
    if (!await navigateToEditor(page)) {
      return {
        success: false,
        error: 'Failed to open Dzen editor'
      };
    }
    
    // Set title
    await setTitle(page, content.title);
    
    // Add teaser/intro
    if (content.teaser) {
      await addTextBlock(page, content.teaser);
    }
    
    // Add sections
    for (const section of content.sections) {
      await addSection(page, section);
    }
    
    // Add conclusion
    if (content.conclusion) {
      await addHeading(page, content.conclusion.heading);
      await addTextBlock(page, content.conclusion.text);
    }
    
    // Add hero quote if exists
    if (content.heroQuote) {
      await addBlockquote(page, `"${content.heroQuote.text}" — ${content.heroQuote.author}`);
    }
    
    // Add CTA
    if (content.cta) {
      await addTextBlock(page, content.cta);
    }
    
    // Add brand ending
    if (content.brandEnding) {
      await addTextBlock(page, content.brandEnding);
    }
    
    // Upload cover if exists
    const coverImage = article.coverImages?.[0] || article.coverImage;
    if (coverImage) {
      await uploadCover(page, coverImage);
    }
    
    // Publish (or save as draft)
    if (options.draft) {
      console.log('💾 Saving as draft (not publishing)');
      // Save context for later
      await saveContext(context);
      return {
        success: true,
        url: page.url()
      };
    }
    
    const publishedUrl = await clickPublish(page, options);
    
    // Save session for future use
    await saveContext(context);
    
    if (publishedUrl) {
      return {
        success: true,
        url: publishedUrl
      };
    } else {
      return {
        success: false,
        error: 'Failed to get published URL'
      };
    }
    
  } catch (error: any) {
    console.error('❌ Dzen publish error:', error);
    return {
      success: false,
      error: error.message
    };
  } finally {
    await browser.close();
  }
}

/**
 * Interactive auth setup - opens browser for manual login
 */
export async function setupDzenAuth(): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log('🔐 Dzen Authentication Setup');
  console.log(`${'='.repeat(60)}\n`);
  
  ensureSessionsDir();
  
  const browser = await chromium.launch({ 
    headless: false,
    slowMo: 50
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
  
  const page = await context.newPage();
  
  await page.goto('https://dzen.ru/');
  
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Please log in to Dzen in the opened browser window.       ║
║                                                            ║
║  After successful login, press ENTER in this terminal      ║
║  to save your session.                                     ║
╚════════════════════════════════════════════════════════════╝
`);
  
  // Wait for user to press Enter
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });
  
  // Verify login
  if (await isLoggedIn(page)) {
    await saveContext(context);
    console.log('\n✅ Successfully saved Dzen session!');
    console.log(`📁 Session file: ${DZEN_STATE_FILE}`);
  } else {
    console.log('\n⚠️ Login not detected. Please try again.');
  }
  
  await browser.close();
}

export default publishToDzen;
