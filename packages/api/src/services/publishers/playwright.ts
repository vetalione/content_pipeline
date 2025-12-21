import { chromium, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import { Platform } from '@content-pipeline/shared';

const SESSIONS_DIR = path.resolve(__dirname, './sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

async function loadContext(browser: any, platform: string): Promise<BrowserContext> {
  const statePath = path.join(SESSIONS_DIR, `${platform}-state.json`);
  if (fs.existsSync(statePath)) {
    return await browser.newContext({ storageState: statePath });
  }
  // no saved state — create new context and instruct user to login manually
  return await browser.newContext();
}

// Basic publish switch — each platform implementation should be expanded for reliability
export async function publishWithPlaywright(platform: Platform, article: any) {
  const browser = await chromium.launch({ headless: true });

  try {
    switch (platform) {
      case Platform.TELEGRAM:
        return await publishToTelegram(browser, article);
      case Platform.VK:
        return await publishToVK(browser, article);
      case Platform.INSTAGRAM:
        return await publishToInstagram(browser, article);
      case Platform.YOUTUBE:
        return await publishToYouTube(browser, article);
      case Platform.THREADS:
        return await publishToThreads(browser, article);
      case (Platform as any).DZEN:
        return await publishToDzen(browser, article);
      default:
        throw new Error(`Platform ${platform} not implemented in Playwright publisher`);
    }
  } finally {
    await browser.close();
  }
}

async function publishToTelegram(browser: any, article: any) {
  const context = await loadContext(browser, 'telegram');
  const page = await context.newPage();
  // For Telegram we recommend using Bot API, but browser automation can post to web.telegram.org
  await page.goto('https://web.telegram.org/');
  // TODO: robust selectors and flows
  // Placeholder: return fake URL
  return { url: `https://t.me/your_channel/${Date.now()}` };
}

async function publishToVK(browser: any, article: any) {
  const context = await loadContext(browser, 'vk');
  const page = await context.newPage();
  await page.goto('https://vk.com/');
  // TODO: implement upload and post
  return { url: `https://vk.com/wall-123456_${Date.now()}` };
}

async function publishToInstagram(browser: any, article: any) {
  const context = await loadContext(browser, 'instagram');
  const page = await context.newPage();
  await page.goto('https://www.instagram.com/');
  // TODO: implement composer (web flow supports upload on desktop via new UI)
  return { url: `https://instagram.com/p/${Date.now()}` };
}

async function publishToYouTube(browser: any, article: any) {
  const context = await loadContext(browser, 'youtube');
  const page = await context.newPage();
  // For YouTube we assume text-to-video already created and file path exists in article
  await page.goto('https://studio.youtube.com/');
  // TODO: implement upload
  return { url: `https://youtube.com/watch?v=${Date.now()}` };
}

async function publishToThreads(browser: any, article: any) {
  const context = await loadContext(browser, 'threads');
  const page = await context.newPage();
  await page.goto('https://www.threads.net/');
  // TODO: implement posting via web UI
  return { url: `https://www.threads.net/post/${Date.now()}` };
}

async function publishToDzen(browser: any, article: any) {
  const context = await loadContext(browser, 'dzen');
  const page = await context.newPage();
  await page.goto('https://dzen.ru/');
  // TODO: implement editor flow: fill title, upload cover, create blocks with formatting
  return { url: `https://dzen.ru/posts/${Date.now()}` };
}

// One-time helper to create and save session state after manual login
export async function setupAuthInteractive(platform: string) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  // Open platform home and wait for manual login
  const urlMap: Record<string, string> = {
    telegram: 'https://web.telegram.org/',
    vk: 'https://vk.com/',
    instagram: 'https://www.instagram.com/',
    youtube: 'https://studio.youtube.com/',
    threads: 'https://www.threads.net/',
    dzen: 'https://dzen.ru/'
  };
  await page.goto(urlMap[platform] || 'https://example.com');
  console.log(`Please log in to ${platform} in the opened browser window. After login press ENTER here.`);
  await new Promise((resolve) => process.stdin.once('data', resolve));
  const statePath = path.join(SESSIONS_DIR, `${platform}-state.json`);
  await context.storageState({ path: statePath });
  await browser.close();
  console.log(`Saved session to ${statePath}`);
}

export default publishWithPlaywright;
