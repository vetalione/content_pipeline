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
const NAVIGATION_TIMEOUT = 60000;  // 60 seconds for slow pages
const ACTION_TIMEOUT = 15000;      // 15 seconds for actions
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
    
    // Log session info for debugging
    try {
      const sessionData = JSON.parse(fs.readFileSync(DZEN_STATE_FILE, 'utf-8'));
      const cookieCount = sessionData.cookies?.length || 0;
      const authCookies = (sessionData.cookies || []).filter((c: any) => 
        ['yandex_login', 'Session_id', 'dzen_sess_id', 'zen_session_id'].includes(c.name)
      );
      console.log(`   📊 Session has ${cookieCount} cookies, ${authCookies.length} auth cookies`);
      if (authCookies.length > 0) {
        console.log(`   🔑 Auth cookies: ${authCookies.map((c: any) => c.name).join(', ')}`);
      }
    } catch (e) {
      console.log('   ⚠️ Could not parse session file for debugging');
    }
    
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
    // First check: do we have auth cookies?
    const cookies = await page.context().cookies();
    const authCookies = cookies.filter(c => 
      c.name === 'yandex_login' || 
      c.name === 'Session_id' || 
      c.name === 'dzen_sess_id' ||
      c.name === 'zen_session_id'
    );
    console.log(`🍪 Found ${authCookies.length} auth cookies: ${authCookies.map(c => c.name).join(', ')}`);
    
    // If we have yandex_login cookie, we're likely logged in
    const hasYandexLogin = cookies.some(c => c.name === 'yandex_login' && c.value);
    if (hasYandexLogin) {
      console.log('✅ Found yandex_login cookie - session is valid');
      return true;
    }
    
    // Visual check: Look for user menu or profile elements
    const userMenu = await page.$('[data-testid="user-menu"], .user-menu, .user-pic, [class*="UserPic"], [class*="avatar"], .Avatar');
    if (userMenu) {
      console.log('✅ Found user menu element');
      return true;
    }
    
    // Alternative: check for "Write" or "Create" button (only visible when logged in)
    const createButton = await page.$('a[href*="/editor"], a[href*="/profile"], button:has-text("Написать"), button:has-text("Создать")');
    if (createButton) {
      console.log('✅ Found create/profile button');
      return true;
    }
    
    // Check URL for zen studio or profile
    const url = page.url();
    if (url.includes('dzen.ru/profile') || url.includes('dzen.ru/id') || url.includes('/a/')) {
      console.log('✅ URL indicates logged in state');
      return true;
    }
    
    console.log('❌ No login indicators found');
    return false;
  } catch (error) {
    console.error('Error checking login status:', error);
    return false;
  }
}

/**
 * Navigate to Dzen editor and create new article
 */
async function navigateToEditor(page: Page): Promise<boolean> {
  console.log('📝 Navigating to Dzen editor...');
  
  // First, go to profile to find the channel ID and create button
  try {
    console.log('   Going to profile page...');
    await page.goto('https://dzen.ru/profile', { 
      waitUntil: 'load',
      timeout: NAVIGATION_TIMEOUT 
    });
    await page.waitForTimeout(3000);
    
    console.log(`   Current URL: ${page.url()}`);
    
    // Look for "Write" or "Create" button
    const createSelectors = [
      'a[href*="/editor"]',
      'button:has-text("Написать")',
      'button:has-text("Создать")',
      'a:has-text("Написать")',
      'a:has-text("Создать статью")',
      '[data-testid="create-article"]',
      '.zen-ui-button:has-text("Написать")'
    ];
    
    for (const selector of createSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        console.log(`   Found create button: ${selector}`);
        await btn.click();
        await page.waitForTimeout(3000);
        console.log(`   Redirected to: ${page.url()}`);
        break;
      }
    }
    
    // Check if we're in an editor now
    const currentUrl = page.url();
    if (currentUrl.includes('/editor')) {
      console.log('✅ Reached editor page');
      
      // Wait for Draft.js editor to load
      await page.waitForSelector('.public-DraftEditor-content[contenteditable="true"]', {
        timeout: ACTION_TIMEOUT
      });
      console.log('✅ Draft.js editor loaded');
      return true;
    }
    
    // Try direct URL patterns
    const editorUrls = [
      'https://dzen.ru/profile/editor/new',
      'https://dzen.ru/editor/new',
      'https://dzen.ru/media/zen/editor'
    ];
    
    for (const url of editorUrls) {
      try {
        console.log(`   Trying direct URL: ${url}`);
        await page.goto(url, { 
          waitUntil: 'load',
          timeout: NAVIGATION_TIMEOUT 
        });
        await page.waitForTimeout(3000);
        
        // Check for Draft.js editor
        const editor = await page.$('.public-DraftEditor-content[contenteditable="true"]');
        if (editor) {
          console.log('✅ Draft.js editor found');
          return true;
        }
        
        // Check for any contenteditable
        const contentEditable = await page.$('[contenteditable="true"]');
        if (contentEditable) {
          console.log('✅ Found contenteditable editor');
          return true;
        }
      } catch (e: any) {
        console.log(`   Failed: ${e.message?.substring(0, 50)}`);
      }
    }
    
  } catch (error: any) {
    console.error('❌ Navigation error:', error.message);
  }
  
  console.error('❌ Could not find Dzen editor');
  return false;
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
  
  // Check if session exists first
  ensureSessionsDir();
  if (!fs.existsSync(DZEN_STATE_FILE)) {
    console.error('❌ No Dzen session found. Please upload cookies via Settings page first.');
    return {
      success: false,
      error: 'Не авторизован в Дзен. Перейдите в Настройки и загрузите cookies из браузера.'
    };
  }
  
  const content = article.content as ArticleContent | null;
  
  if (!content) {
    return {
      success: false,
      error: 'Article has no content'
    };
  }
  
  // Use headless mode on server (no X display), headed mode locally for debugging
  const isServer = !process.env.DISPLAY && process.env.NODE_ENV === 'production';
  
  const browser = await chromium.launch({ 
    headless: true,  // Always headless for automation
    slowMo: isServer ? 50 : 100  // Faster on server
  });
  
  try {
    const context = await loadContext(browser);
    const page = await context.newPage();
    
    // Set default timeout
    page.setDefaultTimeout(NAVIGATION_TIMEOUT);
    
    // Navigate to Dzen - use 'load' instead of 'networkidle' which can timeout
    console.log('🌐 Navigating to dzen.ru...');
    await page.goto('https://dzen.ru/', { 
      waitUntil: 'load',
      timeout: NAVIGATION_TIMEOUT 
    });
    
    // Wait a bit for JavaScript to initialize
    await page.waitForTimeout(2000);
    
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
 * NOTE: This requires a display (X server) - run locally, not on server!
 */
export async function setupDzenAuth(): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log('🔐 Dzen Authentication Setup');
  console.log(`${'='.repeat(60)}\n`);
  
  // Check if we have a display
  if (!process.env.DISPLAY && process.platform === 'linux') {
    throw new Error(
      'setupDzenAuth requires a display (X server). ' +
      'Run this locally on your machine, then copy the session file to the server. ' +
      'Session file: packages/api/src/services/publishers/sessions/dzen-state.json'
    );
  }
  
  ensureSessionsDir();
  
  const browser = await chromium.launch({ 
    headless: false,  // Must be headed for manual login
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
