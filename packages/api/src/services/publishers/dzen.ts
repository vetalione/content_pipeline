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
 * Type text using keyboard (slower but reliable fallback)
 */
async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 3 });
}

/**
 * Paste text using clipboard API
 * With proper permissions this should work in headless mode
 */
async function clipboardPaste(page: Page, text: string): Promise<boolean> {
  try {
    // Method 1: Use execCommand via evaluate
    // The function runs in browser context where document/window exist
    await page.evaluate(`
      (function(t) {
        const textarea = document.createElement('textarea');
        textarea.value = t;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      })(\`${text.replace(/`/g, '\\`').replace(/\\/g, '\\\\')}\`)
    `);
    
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(100);
    return true;
  } catch (e) {
    console.log('⚠️ Clipboard method 1 failed, trying method 2...');
  }
  
  try {
    // Method 2: Use clipboard API directly
    await page.evaluate(`navigator.clipboard.writeText(\`${text.replace(/`/g, '\\`').replace(/\\/g, '\\\\')}\`)`);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(100);
    return true;
  } catch (e) {
    console.log('⚠️ Clipboard method 2 failed, falling back to typing');
  }
  
  return false;
}

/**
 * Smart text input - tries clipboard first, falls back to typing
 */
async function insertText(page: Page, text: string): Promise<void> {
  const clipboardWorked = await clipboardPaste(page, text);
  if (!clipboardWorked) {
    await typeText(page, text);
  }
}

/**
 * Close any modal dialogs that might block interaction
 * From user's HTML: close button is svg with xlink:href="#cross_9ffc--react"
 */
async function closeModals(page: Page): Promise<void> {
  console.log('🔄 Closing any blocking modals...');
  
  try {
    // First try the specific help popup close button (SVG cross icon)
    // From user's HTML: <svg viewBox="0 0 24 24"><use xlink:href="#cross_9ffc--react"></use></svg>
    const crossSelectors = [
      'svg use[*|href="#cross_9ffc--react"]',
      'svg use[xlink\\:href*="cross"]',
      '[class*="help-popup"] svg',
      '.ReactModal__Content svg',
      '[class*="close"] svg',
      'button svg use[*|href*="cross"]'
    ];
    
    for (const selector of crossSelectors) {
      try {
        const crossIcon = await page.$(selector);
        if (crossIcon) {
          // Click the parent button/div containing the SVG
          const parent = await crossIcon.evaluateHandle(el => {
            return el.closest('button') || el.closest('[class*="close"]') || el.closest('div') || el.parentElement;
          });
          if (parent) {
            console.log(`   ✓ Found close button: ${selector}`);
            await (parent as any).click();
            await page.waitForTimeout(500);
            console.log('   ✓ Clicked close button');
            return; // Successfully closed
          }
        }
      } catch {}
    }
    
    // Fallback: Try pressing Escape multiple times
    console.log('   Trying Escape key...');
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    
    // Check if modal is still there
    const modal = await page.$('.ReactModal__Overlay');
    if (modal) {
      console.log('   Modal still present, trying to click outside...');
      // Click on the overlay itself to close
      await modal.click({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(300);
    }
    
  } catch (e) {
    console.log('   ⚠️ Error closing modals:', e);
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
      viewport: { width: 1280, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write']
    });
  }
  
  console.log('⚠️ No saved Dzen session found. Run setupDzenAuth() first.');
  return await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write']
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
 * Real user flow:
 * 1. Go to dzen.ru
 * 2. Click on profile icon (avatar)
 * 3. Click "Создать публикацию" (Create publication)
 * 4. Click "Написать статью" (Write article)
 * 5. Land in editor
 */
async function navigateToEditor(page: Page): Promise<boolean> {
  console.log('📝 Navigating to Dzen editor...');
  
  try {
    // Step 1: Go to main page
    console.log('   Step 1: Going to dzen.ru...');
    await page.goto('https://dzen.ru', { 
      waitUntil: 'networkidle',
      timeout: NAVIGATION_TIMEOUT 
    });
    await page.waitForTimeout(3000);
    console.log(`   Current URL: ${page.url()}`);
    
    // Step 2: Click on profile icon (avatar in header)
    console.log('   Step 2: Looking for profile icon/avatar...');
    
    // Exact selectors from user's HTML
    const profileIconSelectors = [
      // From user's HTML - exact selectors
      '[data-testid="profile-menu-wrapper"]',
      '[aria-label="Меню профиля"]',
      '.dzen-layout--avatar__avatar-3y',
      'button.dzen-layout--avatar__avatar-3y',
      '[class*="dzen-layout--avatar__avatar"]',
      '[class*="profileMenu"]',
      // Button with avatar background image
      'button[style*="avatars"]',
      'button[style*="yapic"]',
      // Fallbacks
      '[data-testid="user-menu-trigger"]',
      '[aria-label="Меню пользователя"]'
    ];
    
    let profileIcon = null;
    for (const selector of profileIconSelectors) {
      try {
        profileIcon = await page.$(selector);
        if (profileIcon) {
          console.log(`   ✓ Found profile icon: ${selector}`);
          break;
        }
      } catch {}
    }
    
    if (profileIcon) {
      await profileIcon.click();
      await page.waitForTimeout(2000);
      console.log('   ✓ Clicked profile icon, menu should be open');
    } else {
      console.log('   ⚠ Profile icon not found with known selectors');
    }
    
    // Step 3: Click "Создать публикацию" (Create publication)
    console.log('   Step 3: Looking for "Создать публикацию"...');
    
    // Exact selectors from user's HTML
    const createPublicationSelectors = [
      // From user's HTML - exact selectors
      '[data-testid="create-button"]',
      '[aria-label="Создать публикацию"]',
      '.dzen-layout--menu-items__createPublication-JX button',
      '[class*="createPublication"] button',
      // Text-based
      'button:has-text("Создать публикацию")',
      'span:has-text("Создать публикацию")',
      // Fallbacks
      'button:has(span:has-text("Создать"))'
    ];
    
    let createPubBtn = null;
    for (const selector of createPublicationSelectors) {
      try {
        createPubBtn = await page.$(selector);
        if (createPubBtn) {
          console.log(`   ✓ Found "Создать публикацию": ${selector}`);
          await createPubBtn.click();
          await page.waitForTimeout(2000);
          console.log(`   ✓ Clicked, now at: ${page.url()}`);
          break;
        }
      } catch {}
    }
    
    if (!createPubBtn) {
      console.log('   ⚠ "Создать публикацию" not found');
    }
    
    // Step 4: Click "Написать статью" (Write article)
    console.log('   Step 4: Looking for "Написать статью"...');
    
    const writeArticleSelectors = [
      // From user's HTML - exact selector
      '[data-testid="profile-menu-create-article"]',
      // Fallbacks
      'button:has-text("Написать статью")',
      'span:has-text("Написать статью")',
      '[aria-label="Написать статью"]',
      'a[href*="/editor/"]',
      'a[href*="/profile/editor"]'
    ];
    
    let writeArticleBtn = null;
    for (const selector of writeArticleSelectors) {
      try {
        writeArticleBtn = await page.$(selector);
        if (writeArticleBtn) {
          console.log(`   ✓ Found "Написать статью": ${selector}`);
          await writeArticleBtn.click();
          await page.waitForTimeout(3000);
          console.log(`   ✓ Clicked, now at: ${page.url()}`);
          break;
        }
      } catch {}
    }
    
    // Check if we reached the editor
    const currentUrl = page.url();
    console.log(`   Final URL: ${currentUrl}`);
    
    if (currentUrl.includes('/editor')) {
      console.log('✅ Reached editor page');
      
      try {
        await page.waitForSelector('.public-DraftEditor-content[contenteditable="true"]', {
          timeout: ACTION_TIMEOUT
        });
        console.log('✅ Draft.js editor loaded');
        
        // CRITICAL: Close help popup immediately after editor loads
        // This popup blocks all interactions until closed
        await page.waitForTimeout(1000); // Wait for popup to appear
        await closeModals(page);
        await page.waitForTimeout(500);
        
        return true;
      } catch {
        const editor = await page.$('[contenteditable="true"]');
        if (editor) {
          console.log('✅ Found contenteditable editor');
          await page.waitForTimeout(1000);
          await closeModals(page);
          return true;
        }
      }
    }
    
    // Fallback: Try known direct URLs
    console.log('   ⚠ Editor not found via menu, trying direct URLs...');
    const editorUrls = [
      'https://dzen.ru/profile/editor/new',
      'https://dzen.ru/editor/new'
    ];
    
    for (const url of editorUrls) {
      try {
        console.log(`   Trying: ${url}`);
        await page.goto(url, { 
          waitUntil: 'networkidle',
          timeout: NAVIGATION_TIMEOUT 
        });
        await page.waitForTimeout(2000);
        
        const editor = await page.$('.public-DraftEditor-content, [contenteditable="true"]');
        if (editor) {
          console.log('✅ Editor found via direct URL');
          return true;
        }
        
        console.log(`   Redirected to: ${page.url()}`);
      } catch (e: any) {
        console.log(`   Failed: ${e.message?.substring(0, 50)}`);
      }
    }
    
  } catch (error: any) {
    console.error('❌ Navigation error:', error.message);
  }
  
  // Take final screenshot for debugging
  try {
    await page.screenshot({ path: '/tmp/dzen-editor-debug.png', fullPage: true });
    console.log('📸 Debug screenshot saved');
  } catch {}
  
  console.error('❌ Could not find Dzen editor');
  return false;
}

/**
 * Set article title using Draft.js editor
 */
async function setTitle(page: Page, title: string): Promise<boolean> {
  console.log(`📰 Setting title: "${title.substring(0, 50)}..."`);
  
  try {
    // Close any modals first
    await closeModals(page);
    
    // Dzen uses Draft.js - title is in the first editor block
    const titleSelectors = [
      '.public-DraftEditor-content .public-DraftStyleDefault-block:first-child',
      '.public-DraftEditor-content [data-offset-key]:first-child',
      '.article-editor-desktop--editable-input__editableInput-oN .public-DraftEditor-content',
      '[class*="editableInput"] .public-DraftEditor-content',
      '.public-DraftEditor-content'
    ];
    
    for (const selector of titleSelectors) {
      const titleInput = await page.$(selector);
      if (titleInput) {
        await titleInput.click();
        await page.waitForTimeout(300);
        
        // Select all existing text and replace with new title
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(100);
        
        // Use clipboard paste with typing fallback
        await insertText(page, title);
        
        console.log('✅ Title set');
        return true;
      }
    }
    
    // Fallback: click on editor area and type
    const editor = await page.$('[contenteditable="true"]');
    if (editor) {
      await editor.click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+a');
      await insertText(page, title);
      console.log('✅ Title set via fallback');
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
 * Add text block to editor using clipboard paste
 * This is faster and more reliable than keyboard.type()
 */
async function addTextBlock(page: Page, text: string): Promise<boolean> {
  try {
    // Press Enter to create new block
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    // Use clipboard paste with typing fallback
    await insertText(page, text);
    await page.waitForTimeout(100);
    
    return true;
  } catch (error) {
    console.error('❌ Error adding text block:', error);
    return false;
  }
}

/**
 * Add heading block (H2/H3)
 * Dzen uses H3 for section headers, visible in toolbar as "Heading 3"
 */
async function addHeading(page: Page, text: string, level: 2 | 3 = 2): Promise<boolean> {
  console.log(`�� Adding H${level} heading: "${text.substring(0, 40)}..."`);
  
  try {
    // Press Enter for new block
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    
    // Use clipboard paste with typing fallback
    await insertText(page, text);
    await page.waitForTimeout(200);
    
    // Select all text in this block (Ctrl+A in Draft.js selects current block content)
    // Use Shift+Home to select from cursor to beginning of line
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(100);
    
    // Click H2 or H3 button in toolbar (from user's HTML: aria-label="Heading 2")
    const headingSelector = level === 2 
      ? '[aria-label="Heading 2"]' 
      : '[aria-label="Heading 3"]';
    
    const headingBtn = await page.$(headingSelector);
    if (headingBtn) {
      await headingBtn.click();
      await page.waitForTimeout(200);
      console.log(`✅ Applied H${level} formatting`);
    } else {
      console.log(`⚠️ H${level} button not found, text added as paragraph`);
    }
    
    // Move to end of line
    await page.keyboard.press('End');
    
    return true;
  } catch (error) {
    console.error('❌ Error adding heading:', error);
    return false;
  }
}

/**
 * Add blockquote using toolbar button
 * According to user: need to first clear formatting, then apply blockquote
 */
async function addBlockquote(page: Page, text: string): Promise<boolean> {
  console.log(`💬 Adding blockquote: "${text.substring(0, 40)}..."`);
  
  try {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    
    // Use clipboard paste with typing fallback
    await insertText(page, text);
    await page.waitForTimeout(200);
    
    // Select all text in this line (use Shift+Home/End for current line)
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(100);
    
    // Click blockquote button in toolbar (from user's HTML: aria-label="Blockquote")
    const quoteBtn = await page.$('[aria-label="Blockquote"]');
    if (quoteBtn) {
      await quoteBtn.click();
      await page.waitForTimeout(200);
      console.log('✅ Applied blockquote formatting');
    } else {
      console.log('⚠️ Blockquote button not found');
    }
    
    // Move to end
    await page.keyboard.press('End');
    
    return true;
  } catch (error) {
    console.error('❌ Error adding blockquote:', error);
    return false;
  }
}

/**
 * Validate image before upload
 * Dzen requirements: max 10MB, min 300px width
 */
async function validateImage(imageUrl: string): Promise<{valid: boolean, reason?: string}> {
  try {
    console.log(`🔍 Validating image: ${imageUrl.substring(0, 50)}...`);
    
    // Try to get image info via HEAD request
    const response = await fetch(imageUrl, { method: 'HEAD' });
    
    if (!response.ok) {
      return { valid: false, reason: `Image not accessible: ${response.status}` };
    }
    
    // Check file size
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const sizeBytes = parseInt(contentLength, 10);
      const sizeMB = sizeBytes / (1024 * 1024);
      
      if (sizeMB > 10) {
        return { valid: false, reason: `Image too large: ${sizeMB.toFixed(1)}MB (max 10MB)` };
      }
      
      console.log(`   Size: ${sizeMB.toFixed(2)}MB ✅`);
    }
    
    // Note: Cannot easily check dimensions without downloading image
    // Could add image-size library if needed
    
    return { valid: true };
  } catch (error: any) {
    console.warn(`⚠️ Could not validate image: ${error.message}`);
    // Allow upload even if validation fails - Dzen will reject if invalid
    return { valid: true };
  }
}

/**
 * Upload image from URL using toolbar button
 * Dzen limits: max 10MB, min 300px width
 */
async function addImageFromUrl(page: Page, imageUrl: string): Promise<boolean> {
  console.log(`🖼️ Adding image: ${imageUrl.substring(0, 60)}...`);
  
  // Skip base64 images - they're too large and not supported for URL insert
  if (imageUrl.startsWith('data:')) {
    console.log('⚠️ Skipping base64 image (not supported for URL insert)');
    return false;
  }
  
  // Validate image first
  const validation = await validateImage(imageUrl);
  if (!validation.valid) {
    console.warn(`⚠️ Image validation failed: ${validation.reason}`);
    return false;
  }
  
  try {
    // Create new line for image
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    // From user's HTML: Look for side button with gallery icon
    // svg class="article-editor-desktop--side-button__sideIcon-Lg"
    // use xlink:href="#add_gallery_e477--react"
    const imageButtonSelectors = [
      // Side button with gallery icon (from user's HTML)
      '[class*="side-button"] svg[class*="sideIcon"]',
      '[class*="sideButton"] svg',
      'svg[class*="sideIcon"]',
      // Alternative toolbar selectors
      '[aria-label="Image"]',
      '[aria-label="Картинка"]',
      '[aria-label="Изображение"]'
    ];
    
    let imageBtn = null;
    for (const selector of imageButtonSelectors) {
      try {
        imageBtn = await page.$(selector);
        if (imageBtn) {
          console.log(`   ✓ Found image button: ${selector}`);
          // For SVG elements, click the parent container
          const parent = await imageBtn.evaluateHandle(el => {
            const div = el.closest('[class*="side-button"]') || el.closest('div') || el.parentElement;
            return div;
          });
          if (parent) {
            await (parent as any).click();
          } else {
            await imageBtn.click();
          }
          await page.waitForTimeout(500);
          break;
        }
      } catch {}
    }
    
    if (imageBtn) {
      // Look for image popup/dialog
      await page.waitForTimeout(500);
      
      // Look for "По ссылке" (By URL) tab/button
      const urlTabSelectors = [
        'button:has-text("По ссылке")',
        'span:has-text("По ссылке")',
        '[data-tab="url"]',
        'button:has-text("URL")'
      ];
      
      for (const selector of urlTabSelectors) {
        try {
          const urlTab = await page.$(selector);
          if (urlTab) {
            console.log(`   ✓ Found URL tab: ${selector}`);
            await urlTab.click();
            await page.waitForTimeout(300);
            break;
          }
        } catch {}
      }
      
      // Find URL input field
      const urlInputSelectors = [
        'input[placeholder*="http"]',
        'input[placeholder*="URL"]',
        'input[placeholder*="ссылк"]',
        'input[type="url"]',
        'input[type="text"]'
      ];
      
      for (const selector of urlInputSelectors) {
        const urlInput = await page.$(selector);
        if (urlInput) {
          console.log(`   ✓ Found URL input: ${selector}`);
          
          // Use clipboard to paste URL (faster and more reliable)
          await urlInput.click();
          await page.waitForTimeout(200);
          await insertText(page, imageUrl);
          await page.waitForTimeout(300);
          
          // ALWAYS press Enter to confirm the URL (user confirmed this is required)
          console.log('   Pressing Enter to confirm URL...');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2000);
          
          // Also try clicking submit button if exists
          const submitBtn = await page.$('button:has-text("Добавить"), button:has-text("Add"), button[type="submit"]');
          if (submitBtn) {
            await submitBtn.click();
            await page.waitForTimeout(1000);
          }
          
          console.log('✅ Image added via URL');
          return true;
        }
      }
    }
    
    // Fallback: Just paste URL as text - Dzen might auto-embed it
    console.log('⚠️ Image dialog not found, trying direct URL...');
    await insertText(page, imageUrl);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    
    return false;
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
    
    // Add image IMMEDIATELY after heading (per Dzen editor logic)
    if (section.imageUrl) {
      await addImageFromUrl(page, section.imageUrl);
    }
    
    // Add first paragraph
    await addTextBlock(page, section.paragraph1);
    
    // Add second paragraph if exists
    if (section.paragraph2) {
      await addTextBlock(page, section.paragraph2);
    }
    
    // Add blockquote/quote if exists
    if (section.blockquote) {
      await addBlockquote(page, section.blockquote);
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
    // First, close any modal dialogs that might block the publish button
    // From Railway logs: ReactModal__Overlay was blocking clicks
    console.log('   Closing any blocking modals...');
    await closeModals(page);
    await page.waitForTimeout(500);
    
    // Try Escape multiple times to close help popup
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    
    // From user's HTML: [data-testid="article-publish-btn"]
    const publishSelectors = [
      '[data-testid="article-publish-btn"]',  // Exact selector from user's HTML
      'button:has-text("Опубликовать")',
      '[class*="publishBtnContainer"] button',
      'button[type="submit"]:has-text("Опубликовать")',
      '[data-testid="publish-button"]'
    ];
    
    for (const selector of publishSelectors) {
      const publishBtn = await page.$(selector);
      if (publishBtn) {
        console.log(`   ✓ Found publish button: ${selector}`);
        
        // Make sure no modal is blocking - close again
        await closeModals(page);
        await page.waitForTimeout(300);
        
        // Use force click to bypass any overlay issues
        await publishBtn.click({ force: true });
        await page.waitForTimeout(3000);
        
        // Wait for navigation or confirmation
        try {
          await page.waitForNavigation({ 
            waitUntil: 'networkidle',
            timeout: 30000 
          });
        } catch {}
        
        // Get the published URL
        const url = page.url();
        console.log(`   Final URL: ${url}`);
        
        if (url.includes('/a/') || url.includes('/media/')) {
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
        
        // If we're still on editor but button was clicked, might be success
        if (url.includes('/editor')) {
          console.log('   Still on editor page, checking for success indicators...');
          const successIndicators = await page.$('[class*="success"], [class*="published"], .notification-success');
          if (successIndicators) {
            console.log('✅ Publication appears successful');
            return url;
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
    
    // Step 1: Set title (first action)
    await setTitle(page, content.title);
    
    // Step 2: Upload cover IMMEDIATELY after title (per Dzen editor logic)
    const coverImage = article.coverImages?.[0] || article.coverImage;
    if (coverImage) {
      await uploadCover(page, coverImage);
    }
    
    // Step 3: Add teaser/intro
    if (content.teaser) {
      await addTextBlock(page, content.teaser);
    }
    
    // Step 4+: Add sections (each: heading -> image -> paragraphs -> quote)
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
