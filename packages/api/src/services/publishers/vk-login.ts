/**
 * VK Interactive Login via Playwright
 *
 * Logs into VK from the server (so cookies are IP-bound to the server's IP).
 * Handles multi-step flows: password → SMS → captcha → success.
 *
 * Session lifecycle:
 *   1. startVkLogin(login, password) launches headless Chromium,
 *      fills the form, submits, returns { sessionId, status, screenshot? }
 *   2. If status is 'awaiting_sms' or 'awaiting_captcha', the caller
 *      displays the screenshot and asks the user to submit the value
 *   3. submitVkLoginStep(sessionId, value) types the value and advances
 *   4. Once status is 'done', cookies are saved to vk-state.json and
 *      the browser is closed
 *
 * Sessions auto-expire after 10 minutes.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

// ── Config ─────────────────────────────────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

const SESSIONS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vk-sessions')
  : path.resolve(__dirname, 'sessions');

const SCREENSHOTS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vk-login-screenshots')
  : '/tmp/vk-login-screenshots';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Types ──────────────────────────────────────────────────────────────────────

export type LoginStatus =
  | 'awaiting_password'
  | 'awaiting_sms'
  | 'awaiting_captcha'
  | 'awaiting_2fa'
  | 'awaiting_qr'
  | 'done'
  | 'error';

interface LoginSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  status: LoginStatus;
  message?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoginStepResult {
  sessionId: string;
  status: LoginStatus;
  message?: string;
  screenshot?: string; // base64 data URI
  qrImage?: string; // base64 data URI — isolated QR canvas/img
  currentUrl?: string;
}

// ── In-memory session store ────────────────────────────────────────────────────

const sessions = new Map<string, LoginSession>();

function newSessionId(): string {
  return crypto.randomBytes(12).toString('hex');
}

async function cleanupSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  try {
    await s.page.close().catch(() => {});
    await s.context.close().catch(() => {});
    await s.browser.close().catch(() => {});
  } catch {
    /* ignore */
  }
}

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.updatedAt > SESSION_TTL_MS) {
      console.log(`🧹 VK login session ${id} expired, cleaning up`);
      cleanupSession(id);
    }
  }
}, 60_000).unref();

// ── Helpers ────────────────────────────────────────────────────────────────────

async function takeScreenshot(page: Page): Promise<string> {
  try {
    const buf = await page.screenshot({ fullPage: false, type: 'png' });
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/** Save screenshot to disk for debugging. */
async function savePageScreenshot(page: Page, label: string): Promise<string | null> {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const p = path.join(SCREENSHOTS_DIR, `${label}_${ts}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`   📸 Saved screenshot: ${p}`);
    return p;
  } catch {
    return null;
  }
}

/** Apply stealth patches to the browser context. */
async function applyStealth(context: BrowserContext) {
  await context.addInitScript(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ru-RU', 'ru', 'en-US', 'en'],
    });

    // Chrome object
    (window as any).chrome = { runtime: {} };

    // Permissions mock
    const origQuery = (window.navigator as any).permissions?.query;
    if (origQuery) {
      (window.navigator as any).permissions.query = (params: any) =>
        params?.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(params);
    }
  });
}

/** Try to grab the QR code image from the page as a base64 data URI. */
async function grabQrImage(page: Page): Promise<string | null> {
  // VK renders the QR as either <canvas> or <img> inside a container with
  // data-testid containing "qr" or class name "qr". Try several selectors.
  const selectors = [
    'canvas[data-testid*="qr" i]',
    'img[data-testid*="qr" i]',
    '[data-testid*="qr" i] canvas',
    '[data-testid*="qr" i] img',
    '[class*="qr" i] canvas',
    '[class*="qr" i] img',
    'canvas',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;
      // For canvas, screenshot the element directly (it's reliable).
      // For <img>, screenshot also works and captures as-rendered.
      const buf = await el.screenshot({ type: 'png' }).catch(() => null);
      if (buf && buf.length > 200) {
        return `data:image/png;base64,${buf.toString('base64')}`;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Detect the current state of the VK login flow by inspecting the page. */
async function detectLoginState(page: Page): Promise<{
  status: LoginStatus;
  message?: string;
}> {
  const url = page.url();
  console.log(`   🔍 Detecting state on: ${url}`);

  // Logged in successfully
  if (
    url.startsWith('https://vk.com/feed') ||
    url.match(/^https:\/\/vk\.com\/?(\?.*)?$/) ||
    url.startsWith('https://vk.com/id')
  ) {
    // Confirm we're actually logged in (not on landing page)
    const hasTopMenu = await page
      .locator('[data-testid="TopMenu"], .TopNavBtn, #top_nav')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (hasTopMenu || url.includes('/feed') || url.includes('/id')) {
      return { status: 'done' };
    }
  }

  // id.vk.com flows
  if (url.includes('id.vk.com')) {
    // QR code — VK's default login method on id.vk.com
    const qrVisible = await page
      .locator('canvas, [data-testid*="qr" i], [class*="qr" i]')
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (qrVisible) {
      // Confirm it's actually a QR (not some random canvas) by checking
      // for accompanying text or the canvas size
      const hasQrHint = await page
        .locator(
          ':text-matches("QR", "i"), :text-matches("Отсканируйте", "i"), :text-matches("камер", "i")',
        )
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      const canvasBox = await page
        .locator('canvas')
        .first()
        .boundingBox()
        .catch(() => null);
      const isLargeCanvas = canvasBox && canvasBox.width > 100 && canvasBox.height > 100;
      if (hasQrHint || isLargeCanvas) {
        return {
          status: 'awaiting_qr',
          message: 'Отсканируйте QR-код мобильным приложением VK',
        };
      }
    }

    // SMS / OTP entry — look for verification code input
    const smsInput = await page
      .locator('input[type="tel"], input[name="code"], input[data-testid*="code"]')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (smsInput) {
      return { status: 'awaiting_sms', message: 'Введите код из SMS/письма' };
    }

    // Password field (for accounts that still use password)
    const pwdInput = await page
      .locator('input[type="password"]')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (pwdInput) {
      return { status: 'awaiting_password', message: 'Требуется пароль' };
    }

    // Captcha
    const captchaImg = await page
      .locator('img[src*="captcha"], [data-testid*="captcha"]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (captchaImg) {
      return { status: 'awaiting_captcha', message: 'Введите символы с картинки' };
    }

    return {
      status: 'error',
      message: `Неизвестное состояние на id.vk.com. URL: ${url}`,
    };
  }

  // Old vk.com/login with captcha
  if (url.includes('vk.com/login')) {
    const captcha = await page
      .locator('img.captcha_img, img[id^="captcha"]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (captcha) {
      return { status: 'awaiting_captcha', message: 'Введите символы с картинки' };
    }

    // Error on login page
    const errorBox = await page
      .locator('.service_msg_warning, .login_error')
      .first()
      .textContent()
      .catch(() => null);
    if (errorBox) {
      return { status: 'error', message: errorBox.trim() };
    }
  }

  // Challenge / security check page
  if (url.includes('challenge.html') || url.includes('security_check')) {
    return {
      status: 'error',
      message:
        'VK требует верификацию через браузер (возможно, нужен номер телефона). ' +
        'URL: ' + url,
    };
  }

  return {
    status: 'error',
    message: `Неизвестное состояние. URL: ${url}`,
  };
}

/** Save cookies from Playwright context to vk-state.json (the format vk-articles.ts expects). */
async function saveCookies(context: BrowserContext): Promise<{ path: string; count: number }> {
  const cookies = await context.cookies();

  // Filter and convert to the format expected by vk-articles.ts
  const vkCookies = cookies
    .filter(c => c.domain.includes('vk.com') || c.domain.includes('.vk.com'))
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expires ?? -1,
      httpOnly: c.httpOnly || false,
      secure: c.secure !== false,
      sameSite: c.sameSite || 'Lax',
    }));

  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  const sessionPath = path.join(SESSIONS_DIR, 'vk-state.json');
  fs.writeFileSync(
    sessionPath,
    JSON.stringify({ cookies: vkCookies, savedAt: Date.now(), source: 'playwright-login' }, null, 2),
  );

  console.log(`✅ VK cookies saved: ${vkCookies.length} entries → ${sessionPath}`);
  return { path: sessionPath, count: vkCookies.length };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start a QR-code login flow: navigates to id.vk.com and returns the QR image
 * to be scanned by the user's mobile VK app. No credentials are required.
 */
export async function startVkLoginQr(): Promise<LoginStepResult> {
  const id = newSessionId();
  console.log(`\n🔐 Starting VK QR login session ${id}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: USER_AGENT,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  });

  await applyStealth(context);
  const page = await context.newPage();

  try {
    // id.vk.com shows QR by default; fallback to vk.com/login which redirects
    console.log(`   🌐 Navigating to https://id.vk.com/`);
    await page.goto('https://id.vk.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await sleep(2500);

    // Try to find a "Log in with QR" button if not shown by default
    const qrButton = page
      .locator(
        'button:has-text("QR"), [data-testid*="qr" i], a:has-text("QR")',
      )
      .first();
    const qrButtonVisible = await qrButton
      .isVisible({ timeout: 1500 })
      .catch(() => false);
    if (qrButtonVisible) {
      console.log(`   👆 Clicking QR login button`);
      await qrButton.click().catch(() => {});
      await sleep(2000);
    }

    const state = await detectLoginState(page);
    console.log(`   📊 Initial QR state: ${state.status} — ${state.message || ''}`);

    const qrImage =
      state.status === 'awaiting_qr' ? await grabQrImage(page) : null;
    const screenshot = await takeScreenshot(page);

    const session: LoginSession = {
      id,
      browser,
      context,
      page,
      status: state.status,
      message: state.message,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sessions.set(id, session);

    if (state.status === 'done') {
      await saveCookies(context);
      await cleanupSession(id);
      return {
        sessionId: id,
        status: 'done',
        message: 'Успешный вход. Cookies сохранены.',
      };
    }

    if (state.status === 'error') {
      await savePageScreenshot(page, `vk-qr_error_${id}`);
      await cleanupSession(id);
      return {
        sessionId: id,
        status: 'error',
        message: state.message,
        screenshot,
        currentUrl: page.url(),
      };
    }

    return {
      sessionId: id,
      status: state.status,
      message: state.message,
      screenshot,
      qrImage: qrImage || undefined,
      currentUrl: page.url(),
    };
  } catch (err: any) {
    console.error(`   ❌ VK QR login error: ${err.message}`);
    await savePageScreenshot(page, `vk-qr_exception_${id}`);
    const screenshot = await takeScreenshot(page).catch(() => '');
    await cleanupSession(id);
    return {
      sessionId: id,
      status: 'error',
      message: err.message || 'Ошибка при открытии QR',
      screenshot,
    };
  }
}

/**
 * Poll the state of an existing login session. Used by the UI to check whether
 * a QR code has been scanned, or whether the page has advanced on its own.
 */
export async function pollVkLogin(sessionId: string): Promise<LoginStepResult> {
  const s = sessions.get(sessionId);
  if (!s) {
    throw new Error(`Session ${sessionId} not found or expired`);
  }
  s.updatedAt = Date.now();

  const state = await detectLoginState(s.page);
  s.status = state.status;
  s.message = state.message;

  if (state.status === 'done') {
    await saveCookies(s.context);
    await cleanupSession(sessionId);
    return {
      sessionId,
      status: 'done',
      message: 'Успешный вход. Cookies сохранены.',
    };
  }

  if (state.status === 'error') {
    const screenshot = await takeScreenshot(s.page);
    await cleanupSession(sessionId);
    return {
      sessionId,
      status: 'error',
      message: state.message,
      screenshot,
      currentUrl: s.page.url(),
    };
  }

  // For QR — include refreshed qrImage (VK rotates it every ~30s)
  const qrImage =
    state.status === 'awaiting_qr' ? await grabQrImage(s.page) : null;
  const screenshot = await takeScreenshot(s.page);

  return {
    sessionId,
    status: state.status,
    message: state.message,
    screenshot,
    qrImage: qrImage || undefined,
    currentUrl: s.page.url(),
  };
}

/**
 * Start a new login flow by navigating to VK, filling credentials, and submitting.
 */
export async function startVkLogin(
  login: string,
  password: string,
): Promise<LoginStepResult> {
  if (!login || !password) {
    throw new Error('Login and password are required');
  }

  const id = newSessionId();
  console.log(`\n🔐 Starting VK login session ${id} for "${login.substring(0, 3)}***"`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: USER_AGENT,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  });

  await applyStealth(context);

  const page = await context.newPage();

  try {
    console.log(`   🌐 Navigating to https://vk.com/login`);
    await page.goto('https://vk.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Wait for the login form to appear
    await sleep(1500);

    const currentUrl = page.url();
    console.log(`   📍 Landed on: ${currentUrl}`);

    // Two possible entry points:
    // 1. vk.com/login — classic form with email + password
    // 2. id.vk.com — redirects here, usually phone-only with SMS
    if (currentUrl.includes('id.vk.com')) {
      // id.vk.com flow: phone/email input first
      const identInput = page
        .locator('input[type="tel"], input[type="email"], input[name="login"], input[data-testid*="login"]')
        .first();
      await identInput.waitFor({ state: 'visible', timeout: 10_000 });
      await identInput.click();
      await identInput.fill(login);
      await sleep(300);

      // Click continue/next button
      const continueBtn = page
        .locator('button[type="submit"], button[data-testid*="continue"], button:has-text("Продолжить")')
        .first();
      await continueBtn.click();
      await sleep(2500);

      // Now could be: password / sms / captcha
      const afterIdent = page.url();
      console.log(`   📍 After identifier: ${afterIdent}`);

      // Try password field
      const pwdField = page.locator('input[type="password"]').first();
      const hasPwd = await pwdField
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (hasPwd) {
        console.log(`   🔑 Password field visible, filling...`);
        await pwdField.click();
        await pwdField.fill(password);
        await sleep(300);

        const submitBtn = page
          .locator('button[type="submit"], button:has-text("Войти"), button:has-text("Продолжить")')
          .first();
        await submitBtn.click();
        await sleep(3000);
      }
    } else {
      // Old vk.com/login flow
      const emailInput = page.locator('#email, input[name="email"]').first();
      const pwdInput = page.locator('#pass, input[name="pass"], input[type="password"]').first();

      const hasEmailInput = await emailInput
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      if (hasEmailInput) {
        await emailInput.click();
        await emailInput.fill(login);
        await sleep(200);
        await pwdInput.click();
        await pwdInput.fill(password);
        await sleep(200);

        const submitBtn = page
          .locator('button[type="submit"], button[id="install_allow"], button:has-text("Войти")')
          .first();
        await submitBtn.click();
        await sleep(3000);
      } else {
        // Page didn't match either flow — dump state
        await savePageScreenshot(page, `vk-login_unknown_${id}`);
      }
    }

    // Detect state after submit
    await sleep(1500);
    const state = await detectLoginState(page);
    console.log(`   📊 State after submit: ${state.status} — ${state.message || ''}`);

    const session: LoginSession = {
      id,
      browser,
      context,
      page,
      status: state.status,
      message: state.message,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    sessions.set(id, session);

    // If done immediately (no SMS/captcha), save cookies and cleanup
    if (state.status === 'done') {
      await saveCookies(context);
      await cleanupSession(id);
      return {
        sessionId: id,
        status: 'done',
        message: 'Успешный вход. Cookies сохранены.',
      };
    }

    if (state.status === 'error') {
      await savePageScreenshot(page, `vk-login_error_${id}`);
      const screenshot = await takeScreenshot(page);
      await cleanupSession(id);
      return {
        sessionId: id,
        status: 'error',
        message: state.message,
        screenshot,
        currentUrl: page.url(),
      };
    }

    // Awaiting further input
    const screenshot = await takeScreenshot(page);
    const qrImage =
      state.status === 'awaiting_qr' ? await grabQrImage(page) : null;
    return {
      sessionId: id,
      status: state.status,
      message: state.message,
      screenshot,
      qrImage: qrImage || undefined,
      currentUrl: page.url(),
    };
  } catch (err: any) {
    console.error(`   ❌ VK login error: ${err.message}`);
    await savePageScreenshot(page, `vk-login_exception_${id}`);
    const screenshot = await takeScreenshot(page).catch(() => '');
    await cleanupSession(id);
    return {
      sessionId: id,
      status: 'error',
      message: err.message || 'Ошибка при входе',
      screenshot,
    };
  }
}

/**
 * Submit the next step (SMS code, captcha text, or password) for an existing session.
 */
export async function submitVkLoginStep(
  sessionId: string,
  value: string,
): Promise<LoginStepResult> {
  const s = sessions.get(sessionId);
  if (!s) {
    throw new Error(`Session ${sessionId} not found or expired`);
  }

  s.updatedAt = Date.now();
  const { page, context } = s;

  console.log(`   🔐 Submitting step for session ${sessionId} (status: ${s.status})`);

  try {
    if (s.status === 'awaiting_sms') {
      const smsInput = page
        .locator('input[type="tel"], input[name="code"], input[data-testid*="code"]')
        .first();
      await smsInput.click();
      await smsInput.fill(value);
      await sleep(300);

      const submitBtn = page
        .locator('button[type="submit"], button:has-text("Продолжить"), button:has-text("Войти")')
        .first();
      await submitBtn.click();
      await sleep(3000);
    } else if (s.status === 'awaiting_captcha') {
      const captchaInput = page
        .locator('#captcha_key, input[name="captcha_key"], input[data-testid*="captcha"]')
        .first();
      await captchaInput.click();
      await captchaInput.fill(value);
      await sleep(300);

      const submitBtn = page
        .locator('button[type="submit"], button:has-text("Войти"), button:has-text("Продолжить")')
        .first();
      await submitBtn.click();
      await sleep(3000);
    } else if (s.status === 'awaiting_password') {
      const pwdInput = page.locator('input[type="password"]').first();
      await pwdInput.click();
      await pwdInput.fill(value);
      await sleep(300);

      const submitBtn = page
        .locator('button[type="submit"], button:has-text("Войти"), button:has-text("Продолжить")')
        .first();
      await submitBtn.click();
      await sleep(3000);
    } else {
      throw new Error(`Cannot submit value in status: ${s.status}`);
    }

    // Detect new state
    await sleep(1500);
    const state = await detectLoginState(page);
    console.log(`   📊 State after step: ${state.status} — ${state.message || ''}`);

    s.status = state.status;
    s.message = state.message;

    if (state.status === 'done') {
      await saveCookies(context);
      await cleanupSession(sessionId);
      return {
        sessionId,
        status: 'done',
        message: 'Успешный вход. Cookies сохранены.',
      };
    }

    if (state.status === 'error') {
      await savePageScreenshot(page, `vk-login_step_error_${sessionId}`);
      const screenshot = await takeScreenshot(page);
      await cleanupSession(sessionId);
      return {
        sessionId,
        status: 'error',
        message: state.message,
        screenshot,
        currentUrl: page.url(),
      };
    }

    const screenshot = await takeScreenshot(page);
    return {
      sessionId,
      status: state.status,
      message: state.message,
      screenshot,
      currentUrl: page.url(),
    };
  } catch (err: any) {
    console.error(`   ❌ VK step error: ${err.message}`);
    await savePageScreenshot(page, `vk-login_step_exception_${sessionId}`);
    const screenshot = await takeScreenshot(page).catch(() => '');
    await cleanupSession(sessionId);
    return {
      sessionId,
      status: 'error',
      message: err.message || 'Ошибка при вводе',
      screenshot,
    };
  }
}

/** Cancel an in-progress login session and close the browser. */
export async function cancelVkLogin(sessionId: string): Promise<void> {
  console.log(`   🚫 Cancelling VK login session ${sessionId}`);
  await cleanupSession(sessionId);
}

/** Get list of active session IDs (for debugging). */
export function listActiveSessions(): string[] {
  return Array.from(sessions.keys());
}
