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

const SESSIONS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-sessions') : path.resolve(__dirname, './sessions');
const SCREENSHOTS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-screenshots') : '/tmp/dzen-screenshots';
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
// Screenshot helper for debugging
async function takeScreenshot(page: Page, name: string): Promise<string | null> {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${name}_${timestamp}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`📸 Screenshot saved: ${filename}`);
    return filename;
  } catch (error) {
    console.log('Could not take screenshot:', error);
    return null;
  }
}

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
 * Scroll to and focus the editor to ensure it's visible
 * This is critical when adding many sections - page scrolls down
 */
async function focusEditor(page: Page): Promise<void> {
  try {
    const editor = await page.$('.public-DraftEditor-content[contenteditable="true"]');
    if (editor) {
      await editor.scrollIntoViewIfNeeded();
      await editor.click();
      await page.waitForTimeout(200);
    }
  } catch {}
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
    
    // CRITICAL: Cursor starts on paragraph line by default
    // Title line is the FIRST .public-DraftStyleDefault-block element
    // We need to click directly on it (ArrowUp doesn't work)
    
    // Take screenshot before attempting title
    await takeScreenshot(page, 'before-title');
    
    // From user: <span data-offset-key="72jdf-0-0"><br data-text="true"></span>
    // Key: click on span[data-offset-key] inside first block
    const titleLineSelectors = [
      '.public-DraftStyleDefault-block:first-child span[data-offset-key]',
      '.public-DraftStyleDefault-block:first-child span',
      '[data-contents="true"] > div:first-child span[data-offset-key]',
      '[data-contents="true"] > div:first-child span',
      '.public-DraftStyleDefault-block:first-child',
    ];
    
    let titleLineClicked = false;
    for (const selector of titleLineSelectors) {
      const titleLine = await page.$(selector);
      if (titleLine) {
        console.log(`   ✓ Found title element: ${selector}`);
        await titleLine.scrollIntoViewIfNeeded();
        await titleLine.click({ force: true });
        await page.waitForTimeout(300);
        
        // Verify focus is in editor
        const activeElement = await page.evaluate('document.activeElement?.tagName');
        console.log(`   Active element after click: ${activeElement}`);
        
        titleLineClicked = true;
        break;
      }
    }
    
    // If selectors didn't work, try focusing the contenteditable directly
    if (!titleLineClicked) {
      console.log('   ⚠️ Selectors failed, trying direct focus...');
      const editor = await page.$('[contenteditable="true"]');
      if (editor) {
        await editor.focus();
        await page.waitForTimeout(200);
        // Move to beginning
        await page.keyboard.down('Control');
        await page.keyboard.press('Home');
        await page.keyboard.up('Control');
        await page.waitForTimeout(200);
        titleLineClicked = true;
        console.log('   ✓ Focused editor directly');
      }
    }
    
    if (!titleLineClicked) {
      // Fallback: click on editor and try ArrowUp
      console.log('   ⚠️ Title line not found, trying fallback...');
      const editor = await page.$('[contenteditable="true"]');
      if (editor) {
        await editor.click();
        await page.waitForTimeout(200);
        // Try clicking at top of editor
        await page.keyboard.press('Home');
        await page.keyboard.down('Control');
        await page.keyboard.press('Home');
        await page.keyboard.up('Control');
        await page.waitForTimeout(200);
      }
    }
    
    // Now we're on the title line - just type the title
    // It will automatically be formatted as H1 (title)
    console.log('   Typing title text...');
    await insertText(page, title);
    await page.waitForTimeout(500);
    
    // Verify title was typed by checking blocks count
    const blocksAfterTitle = await page.$$eval('.public-DraftStyleDefault-block', els => els.length);
    console.log('   Blocks after title: ' + blocksAfterTitle);
    await takeScreenshot(page, 'after-title');
    
    // Take screenshot to verify
    await takeScreenshot(page, 'after-title');
    
    console.log('✅ Title set');
    
    // Press Enter to move to next line (for cover image)
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    
    return true;
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
    // Scroll to editor first
    await focusEditor(page);
    
    // Note: caller already pressed Enter, we're on new line
    // Press Enter first
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    // Type the text
    console.log('   Adding paragraph: ' + text.substring(0, 40) + '...');
    await insertText(page, text);
    await page.waitForTimeout(200);
    
    // Press Enter to move to next line
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
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
  console.log(`📝 Adding H${level} heading: "${text.substring(0, 40)}..."`);
  
  try {
    // CRITICAL: Scroll editor into view first
    await focusEditor(page);
    
    // Note: caller already pressed Enter, we're on new line
    // Press Enter first to ensure new line
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    // Type the heading text
    console.log('   Typing heading text...');
    await insertText(page, text);
    await page.waitForTimeout(500);
    
    // Count blocks for diagnostics
    const blocksCount = await page.$$eval('.public-DraftStyleDefault-block', els => els.length);
    console.log('   Editor has ' + blocksCount + ' blocks');
    
    // Select all text in current line using End then Shift+Home
    // In Draft.js, End+Shift+Home selects the current line content when focus is in a block
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.waitForTimeout(500);
    
    // Wait for toolbar to appear (it shows up when text is selected)
    const toolbarSelector = '[class*="editorToolbar"]';
    try {
      await page.waitForSelector(toolbarSelector, { timeout: 2000, state: 'visible' });
      console.log('   ✓ Toolbar appeared');
    } catch {
      console.log('   ⚠️ Toolbar not visible, trying anyway...');
      await takeScreenshot(page, 'toolbar-not-visible');
      await takeScreenshot(page, 'toolbar-not-visible');
      await takeScreenshot(page, 'toolbar-not-visible');
    }
    
    // Click H2 or H3 button in toolbar
    const headingSelector = level === 2 
      ? '[aria-label="Heading 2"]' 
      : '[aria-label="Heading 3"]';
    
    const headingBtn = await page.$(headingSelector);
    if (headingBtn) {
      await headingBtn.click();
      await page.waitForTimeout(300);
      console.log(`   ✅ Applied H${level} formatting`);
    } else {
      console.log(`   ⚠️ H${level} button not found, text added as paragraph`);
      await takeScreenshot(page, 'heading-btn-missing');
      await takeScreenshot(page, 'heading-btn-missing');
    }
    
    // CRITICAL: Remove selection BEFORE pressing Enter (otherwise text gets deleted!)
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    
    // Press Enter to move to next line
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
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
    // CRITICAL: Scroll editor into view first
    await focusEditor(page);
    
    // Note: caller already pressed Enter, we're on new line
    // Press Enter first
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    // Type the quote text
    console.log('   Typing blockquote...');
    await insertText(page, text);
    await page.waitForTimeout(500);
    
    // Select all text in current line using End then Shift+Home
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.waitForTimeout(500);
    
    // Wait for toolbar to appear
    const toolbarSelector = '[class*="editorToolbar"]';
    try {
      await page.waitForSelector(toolbarSelector, { timeout: 2000, state: 'visible' });
      console.log('   ✓ Toolbar appeared');
    } catch {
      console.log('   ⚠️ Toolbar not visible, trying anyway...');
    }
    
    // Click blockquote button (from user's HTML: aria-label="Blockquote")
    const quoteBtn = await page.$('[aria-label="Blockquote"]');
    if (quoteBtn) {
      await quoteBtn.click();
      await page.waitForTimeout(300);
      console.log('   ✅ Applied blockquote formatting');
    } else {
      console.log('   ⚠️ Blockquote button not found');
    }
    
    // CRITICAL: Remove selection BEFORE any further action
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    
    // Press Enter to move to next line
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
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
    // Scroll to editor first - critical for visibility
    await focusEditor(page);
    
    // Create new line for image
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    // From user's exact HTML:
    // <button class="article-editor-desktop--side-button__sideButton-1z" data-tip="Вставить изображение">
    // The side button appears when cursor is on an empty line
    const imageButtonSelectors = [
      // Exact selectors from user's HTML
      '[data-tip="Вставить изображение"]',
      'button[class*="sideButton"]',
      '.article-editor-desktop--side-button__sideButton-1z',
      // Fallbacks
      '[class*="side-button"] button',
      'button[class*="side-button"]'
    ];
    
    let clicked = false;
    for (const selector of imageButtonSelectors) {
      try {
        const imageBtn = await page.$(selector);
        if (imageBtn) {
          console.log(`   ✓ Found image button: ${selector}`);
          // Scroll into view and click
          await imageBtn.scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
          await imageBtn.click({ force: true });
          await page.waitForTimeout(1000);
          clicked = true;
          break;
        }
      } catch (e) {
        console.log(`   ⚠️ Could not click ${selector}`);
      }
    }
    
    if (!clicked) {
      console.log('⚠️ Image button not found or not clickable');
    }
    
    if (clicked) {
      // Wait for image popup to appear
      await page.waitForTimeout(800);
      
      // The popup may have tabs - try to click "По ссылке" (By URL) tab first
      const urlTabSelectors = [
        'button:has-text("По ссылке")',
        'span:has-text("По ссылке")',
        '[class*="tab"]:has-text("ссылк")',
        'div:has-text("По ссылке")'
      ];
      
      for (const tabSelector of urlTabSelectors) {
        try {
          const urlTab = await page.$(tabSelector);
          if (urlTab) {
            console.log(`   ✓ Found URL tab: ${tabSelector}`);
            await urlTab.click();
            await page.waitForTimeout(500);
            break;
          }
        } catch {}
      }
      
      // From user's HTML: <div class="article-editor-desktop--image-popup__urlInput-25">
      // <input type="text" placeholder="Ссылка" value="">
      const urlInputSelectors = [
        // Exact selector from user's HTML
        '.article-editor-desktop--image-popup__urlInput-25 input',
        'input[placeholder="Ссылка"]',
        // Fallbacks
        '[class*="image-popup"] input',
        '[class*="urlInput"] input',
        'input[placeholder*="ссылк"]',
        'input[type="text"]'  // Last resort - any text input in popup
      ];
      
      for (const selector of urlInputSelectors) {
        const urlInput = await page.$(selector);
        if (urlInput) {
          console.log(`   ✓ Found URL input: ${selector}`);
          
          // Click and paste URL
          await urlInput.click();
          await page.waitForTimeout(200);
          await insertText(page, imageUrl);
          await page.waitForTimeout(300);
          
          // Press Enter to confirm the URL (required!)
          console.log('   Pressing Enter to confirm URL...');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2000);
          
          console.log('✅ Image added via URL');
          return true;
        }
      }
      
      console.log('⚠️ URL input not found in popup');
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
  
  console.log(`�� Uploading cover image...`);
  
  // Note: setTitle already pressed Enter to move to new line
  // Now we need to add the cover image
  
  // If it's a base64 image, we need to upload as file
  if (imageUrl.startsWith('data:')) {
    console.log('   Cover is base64, uploading as file...');
    return await uploadImageAsFile(page, imageUrl);
  }
  
  // For URL images, use the standard method
  // But DON'T press Enter first (setTitle already did)
  return await addImageFromUrlNoPressEnter(page, imageUrl);
}

/**
 * Upload image as file (for base64 images)
 */
async function uploadImageAsFile(page: Page, base64Data: string): Promise<boolean> {
  try {
    // Click image button
    const imageBtn = await page.$('[data-tip="Вставить изображение"]');
    if (!imageBtn) {
      console.log('⚠️ Image button not found');
      return false;
    }
    
    await imageBtn.scrollIntoViewIfNeeded();
    await imageBtn.click({ force: true });
    await page.waitForTimeout(1000);
    
    // Click "Загрузите файл" button (from user's HTML)
    const uploadBtnSelectors = [
      'button:has-text("Загрузите файл")',
      '.article-editor-desktop--image-popup__fileButton-Ye',
      'button[class*="fileButton"]',
      'button:has-text("файл")'
    ];
    
    for (const selector of uploadBtnSelectors) {
      const uploadBtn = await page.$(selector);
      if (uploadBtn) {
        console.log(`   ✓ Found upload button: ${selector}`);
        
        // Set up file chooser listener before clicking
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          uploadBtn.click()
        ]);
        
        // Convert base64 to buffer
        const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Content, 'base64');
        
        // Create temp file path
        const tempPath = '/tmp/cover_image.jpg';
        const fs = await import('fs');
        fs.writeFileSync(tempPath, buffer);
        
        // Upload the file
        await fileChooser.setFiles(tempPath);
        await page.waitForTimeout(3000);
        
        console.log('✅ Cover image uploaded as file');
        return true;
      }
    }
    
    console.log('⚠️ Upload file button not found');
    return false;
  } catch (error) {
    console.error('❌ Error uploading image as file:', error);
    return false;
  }
}

/**
 * Add image from URL without pressing Enter first (for cover after title)
 */
async function addImageFromUrlNoPressEnter(page: Page, imageUrl: string): Promise<boolean> {
  console.log(`🖼️ Adding image (no Enter): ${imageUrl.substring(0, 60)}...`);
  
  try {
    await focusEditor(page);
    
    // DON'T press Enter - cursor is already on new line from setTitle
    
    const imageBtn = await page.$('[data-tip="Вставить изображение"]');
    if (!imageBtn) {
      console.log('⚠️ Image button not found');
      return false;
    }
    
    await imageBtn.scrollIntoViewIfNeeded();
    await imageBtn.click({ force: true });
    await page.waitForTimeout(1000);
    
    // Try URL tab first
    const urlTab = await page.$('button:has-text("По ссылке"), span:has-text("По ссылке")');
    if (urlTab) {
      await urlTab.click();
      await page.waitForTimeout(500);
    }
    
    // Find URL input
    const urlInput = await page.$('input[placeholder="Ссылка"], [class*="urlInput"] input');
    if (urlInput) {
      await urlInput.click();
      await page.waitForTimeout(200);
      await insertText(page, imageUrl);
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
      
      // CRITICAL: Click back into editor after image is added
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const editorAfter = await page.$('[contenteditable="true"]');
      if (editorAfter) {
        await editorAfter.click();
        await page.waitForTimeout(200);
      }
      
      console.log('✅ Image added via URL');
      return true;
    }
    
    console.log('⚠️ URL input not found');
    return false;
  } catch (error) {
    console.error('❌ Error:', error);
    return false;
  }
}

/**
 * Add a complete section (heading + paragraphs + optional quote + optional image)
 */
async function addSection(page: Page, section: DzenSection): Promise<boolean> {
  console.log(`📝 Adding section ${section.number}: "${section.heading.substring(0, 40)}..."`);
  
  try {
    // Add section heading (ends with Enter)
    await addHeading(page, `${section.number}. ${section.heading}`);
    
    // Add image after heading (heading already pressed Enter)
    if (section.imageUrl) {
      await addImageFromUrl(page, section.imageUrl);
      // addImageFromUrl doesn't press Enter, do it here
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
    }
    
    // Add first paragraph (ends with Enter)
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
    console.log('   Closing any blocking modals...');
    await closeModals(page);
    await page.waitForTimeout(500);
    
    // Step 1: Click first publish button to open publish dialog
    // From user's HTML: [data-testid="article-publish-btn"]
    const firstPublishSelectors = [
      '[data-testid="article-publish-btn"]',
      'button:has-text("Опубликовать")',
      '[class*="publishBtnContainer"] button'
    ];
    
    let dialogOpened = false;
    for (const selector of firstPublishSelectors) {
      const publishBtn = await page.$(selector);
      if (publishBtn) {
        console.log(`   ✓ Found first publish button: ${selector}`);
        await publishBtn.scrollIntoViewIfNeeded();
        await publishBtn.click({ force: true });
        await page.waitForTimeout(2000);
        dialogOpened = true;
        break;
      }
    }
    
    if (!dialogOpened) {
      console.error('❌ First publish button not found');
      return null;
    }
    
    // Step 2: In the publish dialog, click on comment selector to ensure "Все пользователи"
    // From user's HTML: [data-testid="select-trigger-button-comment"]
    const commentSelector = await page.$('[data-testid="select-trigger-button-comment"]');
    if (commentSelector) {
      console.log('   ✓ Found comment selector, checking value...');
      const currentValue = await commentSelector.textContent();
      console.log(`   Current comment setting: ${currentValue}`);
      
      // If not already "Все пользователи", click to open dropdown
      if (!currentValue?.includes('Все пользователи')) {
        await commentSelector.click();
        await page.waitForTimeout(500);
        
        // Select "Все пользователи" from dropdown
        const allUsersOption = await page.$('text="Все пользователи"');
        if (allUsersOption) {
          await allUsersOption.click();
          await page.waitForTimeout(500);
        }
      }
    }
    
    // Step 3: Click final publish button in dialog
    // From user's HTML: [data-testid="publish-btn"] (different from article-publish-btn!)
    const finalPublishSelectors = [
      '[data-testid="publish-btn"]',  // Exact from user's HTML
      'button[type="submit"]:has-text("Опубликовать")',
      '.article-editor-desktop--base-button__primary-1Y:has-text("Опубликовать")'
    ];
    
    for (const selector of finalPublishSelectors) {
      const finalBtn = await page.$(selector);
      if (finalBtn) {
        console.log(`   ✓ Found final publish button: ${selector}`);
        await finalBtn.click({ force: true });
        await page.waitForTimeout(3000);
        break;
      }
    }
    
    // Wait for navigation
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
    
    // Check for success on editor page
    if (url.includes('/editor')) {
      console.log('   Still on editor page, article may be published');
    }
    
    return url;
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
      // CRITICAL: After image upload, focus is lost!
      // Need to click back into editor first
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      
      // Click on the LAST block in editor to restore cursor position
      const lastBlock = await page.$('.public-DraftStyleDefault-block:last-child');
      if (lastBlock) {
        await lastBlock.scrollIntoViewIfNeeded();
        await lastBlock.click();
        console.log('   ✓ Clicked back into editor (last block)');
      } else {
        // Fallback: click on editor itself
        const editor = await page.$('[contenteditable="true"]');
        if (editor) {
          await editor.click();
          console.log('   ✓ Clicked back into editor');
        }
      }
      await page.waitForTimeout(300);
      
      // Now press Enter to move to next line
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      // Take screenshot to verify cover and cursor
      await takeScreenshot(page, 'after-cover');
      // Take screenshot to verify cover and cursor
      await takeScreenshot(page, 'after-cover');
      console.log('   Cover uploaded, cursor restored');
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
