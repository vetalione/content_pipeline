import { Router } from 'express';
import { publishToTelegram } from '../services/publishers/telegram';
import { publishToVK } from '../services/publishers/vk';
import {
  startVkLogin,
  submitVkLoginStep,
  cancelVkLogin,
  listActiveSessions,
  startVkLoginQr,
  pollVkLogin,
} from '../services/publishers/vk-login';
import { setupDzenAuth } from '../services/publishers/dzen';
import { publishToDzenApi } from '../services/publishers/dzen-api';
import publishWithPlaywright from '../services/publishers/playwright';
import { Platform } from '@content-pipeline/shared';
import { prisma } from '../lib/db';

export const publishingRouter = Router();

// Publish to platforms
publishingRouter.post('/:articleId/publish', async (req, res, next) => {
  try {
    const { articleId } = req.params;
    const { platforms, scheduledAt } = req.body;
    
    const article = await prisma.article.findUnique({
      where: { id: articleId },
      include: { coverImages: true }
    });
    
    if (!article) {
      return res.status(404).json({
        success: false,
        error: 'Article not found'
      });
    }
    
    // Create publication records
    const publications = await Promise.all(
      (platforms as Platform[]).map(platform =>
        prisma.publication.create({
          data: {
            articleId,
            platform,
            status: scheduledAt ? 'pending' : 'publishing'
          }
        })
      )
    );
    
    // If not scheduled, publish immediately
    if (!scheduledAt) {
      for (const pub of publications) {
        try {
          let result;
          switch (pub.platform) {
            case Platform.TELEGRAM:
              result = await publishToTelegram(article as any);
              break;
            case Platform.VK:
              result = await publishToVK(article as any);
              break;
            case Platform.DZEN: {
              const dzenResult = await publishToDzenApi(article as any);
              result = { url: dzenResult.url || '' };
              if (!dzenResult.success) {
                throw new Error(dzenResult.error || 'Dzen publish failed');
              }
              break;
            }
            case Platform.INSTAGRAM:
            case Platform.YOUTUBE:
            case Platform.THREADS:
            case Platform.MEDIUM:
            case Platform.FACEBOOK:
            case Platform.TWITTER:
            case Platform.LINKEDIN:
              result = await publishWithPlaywright(pub.platform as Platform, article);
              break;
            default:
              throw new Error(`Platform ${pub.platform} not implemented`);
          }
          
          await prisma.publication.update({
            where: { id: pub.id },
            data: {
              status: 'published',
              publishedUrl: result.url,
              publishedAt: new Date()
            }
          });
        } catch (error: any) {
          await prisma.publication.update({
            where: { id: pub.id },
            data: {
              status: 'failed',
              error: error.message
            }
          });
        }
      }
    }
    
    res.json({
      success: true,
      data: publications
    });
  } catch (error) {
    next(error);
  }
});

// Reset publication status for republishing
publishingRouter.post('/:articleId/reset/:platform', async (req, res, next) => {
  try {
    const { articleId, platform } = req.params;
    
    // Delete existing publication records for this platform (case insensitive)
    await prisma.publication.deleteMany({
      where: { 
        articleId,
        platform: {
          in: [platform.toLowerCase(), platform.toUpperCase(), platform]
        }
      }
    });
    
    res.json({ 
      success: true, 
      message: `Publication status reset for ${platform}. You can now republish.`
    });
  } catch (error) {
    next(error);
  }
});

// Get publications for article
publishingRouter.get('/:articleId/publications', async (req, res, next) => {
  try {
    const publications = await prisma.publication.findMany({
      where: { articleId: req.params.articleId },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ success: true, data: publications });
  } catch (error) {
    next(error);
  }
});

// Setup Dzen authentication (opens browser for manual login)
// NOTE: Only works locally with display, not on server!
publishingRouter.post('/auth/dzen/setup', async (req, res, next) => {
  try {
    // This will open a browser window for manual login
    // Should only be called from local environment
    await setupDzenAuth();
    res.json({ 
      success: true, 
      message: 'Dzen authentication saved successfully' 
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message,
      hint: 'Run setupDzenAuth locally and upload session via POST /auth/dzen/session'
    });
  }
});

// Helper to convert sameSite from browser extension format to Playwright format
function convertSameSite(sameSite: string | undefined): 'Strict' | 'Lax' | 'None' {
  if (!sameSite) return 'Lax';
  const lower = sameSite.toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'none') return 'None';
  // 'no_restriction' means "unspecified" in EditThisCookie — browser default is Lax.
  // Mapping to "None" caused redirect loops in Playwright (cross-site-only semantics).
  // 'lax', 'no_restriction', 'unspecified', or anything else -> Lax
  return 'Lax';
}

// Upload Dzen session (for server deployment)
// Use this to upload session created locally
publishingRouter.post('/auth/dzen/session', async (req, res, next) => {
  try {
    const { sessionData } = req.body;
    
    if (!sessionData) {
      return res.status(400).json({
        success: false,
        error: 'sessionData is required (JSON object from dzen-state.json)'
      });
    }
    
    // Validate and fix cookie format for Playwright
    let processedData = sessionData;
    if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
      processedData = {
        ...sessionData,
        cookies: sessionData.cookies.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: c.expires ?? c.expirationDate ?? -1,
          httpOnly: c.httpOnly || false,
          secure: c.secure !== false,
          sameSite: convertSameSite(c.sameSite)
        }))
      };
    }
    
    const fs = await import('fs');
    const path = await import('path');
    const sessionsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-sessions')
      : path.resolve(__dirname, '../services/publishers/sessions');
    const sessionPath = path.join(sessionsDir, 'dzen-state.json');
    
    // Ensure directory exists
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    
    // Write session data
    fs.writeFileSync(sessionPath, JSON.stringify(processedData, null, 2));
    
    console.log(`✅ Dzen session saved with ${processedData.cookies?.length || 0} cookies`);
    
    res.json({
      success: true,
      message: 'Dzen session uploaded successfully',
      path: sessionPath,
      cookieCount: processedData.cookies?.length || 0
    });
  } catch (error) {
    next(error);
  }
});

// Check Dzen auth status
publishingRouter.get('/auth/dzen/status', async (req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  const sessionsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-sessions')
    : path.resolve(__dirname, '../services/publishers/sessions');
  const sessionPath = path.join(sessionsDir, 'dzen-state.json');
  
  const hasSession = fs.existsSync(sessionPath);
  
  res.json({
    success: true,
    data: {
      platform: 'dzen',
      authenticated: hasSession,
      sessionPath: hasSession ? sessionPath : null,
      hasFpToken: (() => {
        const fpPath = path.join(sessionsDir, 'dzen-fp-token.txt');
        return fs.existsSync(fpPath);
      })()
    }
  });
});

// Save Dzen X-FP-Token (fingerprint token from browser)
publishingRouter.post('/auth/dzen/fp-token', async (req, res, next) => {
  try {
    const { fpToken } = req.body;
    
    if (!fpToken || typeof fpToken !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'fpToken is required (string from X-FP-Token header)'
      });
    }

    const fs = await import('fs');
    const path = await import('path');
    const sessionsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-sessions')
      : path.resolve(__dirname, '../services/publishers/sessions');
    const fpPath = path.join(sessionsDir, 'dzen-fp-token.txt');

    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    fs.writeFileSync(fpPath, fpToken.trim());
    console.log(`✅ Dzen X-FP-Token saved (${fpToken.length} chars)`);

    res.json({
      success: true,
      message: 'X-FP-Token saved successfully'
    });
  } catch (error) {
    next(error);
  }
});

// ============ VK AUTH ============

// Upload VK session (cookies from Chrome extension)
publishingRouter.post('/auth/vk/session', async (req, res, next) => {
  try {
    const { sessionData } = req.body;

    if (!sessionData) {
      return res.status(400).json({
        success: false,
        error: 'sessionData is required (JSON object with cookies array)'
      });
    }

    // Validate and normalize cookie format
    let processedData = sessionData;
    if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
      processedData = {
        ...sessionData,
        cookies: sessionData.cookies.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: c.expires ?? c.expirationDate ?? -1,
          httpOnly: c.httpOnly || false,
          secure: c.secure !== false,
          sameSite: convertSameSite(c.sameSite)
        }))
      };
    }

    const fs = await import('fs');
    const path = await import('path');
    const sessionsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vk-sessions')
      : path.resolve(__dirname, '../services/publishers/sessions');
    const sessionPath = path.join(sessionsDir, 'vk-state.json');

    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    fs.writeFileSync(sessionPath, JSON.stringify(processedData, null, 2));

    const vkCookieCount = (processedData.cookies || []).filter(
      (c: any) => c.domain && (c.domain.includes('vk.com') || c.domain.includes('.vk.com'))
    ).length;

    console.log(`✅ VK session saved with ${processedData.cookies?.length || 0} cookies (${vkCookieCount} vk.com)`);

    res.json({
      success: true,
      message: 'VK session uploaded successfully',
      path: sessionPath,
      cookieCount: processedData.cookies?.length || 0,
      vkCookieCount,
    });
  } catch (error) {
    next(error);
  }
});

// Check VK auth status
publishingRouter.get('/auth/vk/status', async (_req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  const sessionsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vk-sessions')
    : path.resolve(__dirname, '../services/publishers/sessions');
  const sessionPath = path.join(sessionsDir, 'vk-state.json');

  const hasSession = fs.existsSync(sessionPath);

  res.json({
    success: true,
    data: {
      platform: 'vk',
      authenticated: hasSession,
      sessionPath: hasSession ? sessionPath : null,
    }
  });
});

// ============ VK PLAYWRIGHT LOGIN ============
// Interactive VK login via Playwright running on the server.
// Produces cookies bound to the server's IP (required to bypass VK's IP-binding
// protection when calling internal article-editor endpoints).

publishingRouter.post('/auth/vk/login/start', async (req, res, next) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({
        success: false,
        error: 'login and password are required',
      });
    }
    const result = await startVkLogin(String(login), String(password));
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

publishingRouter.post('/auth/vk/login/qr', async (_req, res, next) => {
  try {
    const result = await startVkLoginQr();
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

publishingRouter.get('/auth/vk/login/poll/:sessionId', async (req, res, next) => {
  try {
    const result = await pollVkLogin(req.params.sessionId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error?.message?.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    next(error);
  }
});

publishingRouter.post('/auth/vk/login/submit', async (req, res, next) => {
  try {
    const { sessionId, value } = req.body || {};
    if (!sessionId || value == null) {
      return res.status(400).json({
        success: false,
        error: 'sessionId and value are required',
      });
    }
    const result = await submitVkLoginStep(String(sessionId), String(value));
    res.json({ success: true, data: result });
  } catch (error: any) {
    if (error?.message?.includes('not found')) {
      return res.status(404).json({ success: false, error: error.message });
    }
    next(error);
  }
});

publishingRouter.post('/auth/vk/login/cancel', async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }
    await cancelVkLogin(String(sessionId));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

publishingRouter.get('/auth/vk/login/sessions', async (_req, res) => {
  res.json({ success: true, data: { active: listActiveSessions() } });
});

// List VK login screenshots (saved on errors/unknown states for debugging)
publishingRouter.get('/auth/vk/login/screenshots', async (_req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vk-login-screenshots')
    : '/tmp/vk-login-screenshots';
  try {
    if (!fs.existsSync(dir)) {
      return res.json({ success: true, screenshots: [], directory: dir });
    }
    const files = fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.png'))
      .map((f: string) => {
        const stat = fs.statSync(path.join(dir, f));
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      .slice(0, 30);
    res.json({ success: true, screenshots: files, directory: dir });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve a specific VK login screenshot
publishingRouter.get('/auth/vk/login/screenshots/:filename', async (req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'vk-login-screenshots')
    : '/tmp/vk-login-screenshots';
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(dir, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Screenshot not found' });
  }
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(filepath);
});



// Get list of screenshots
publishingRouter.get('/dzen/screenshots', async (_req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  
  const screenshotsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-screenshots')
    : '/tmp/dzen-screenshots';
  
  try {
    if (!fs.existsSync(screenshotsDir)) {
      return res.json({ screenshots: [], message: 'No screenshots directory' });
    }
    
    const files = fs.readdirSync(screenshotsDir)
      .filter((f: string) => f.endsWith('.png'))
      .sort()
      .reverse()  // newest first
      .slice(0, 20);  // last 20 screenshots
    
    res.json({ 
      screenshots: files,
      count: files.length,
      directory: screenshotsDir
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific screenshot
publishingRouter.get('/dzen/screenshots/:filename', async (req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  
  const screenshotsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-screenshots')
    : '/tmp/dzen-screenshots';
  
  const filename = req.params.filename;
  
  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  const filepath = path.join(screenshotsDir, filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Screenshot not found' });
  }
  
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(filepath);
});

// Delete all screenshots
publishingRouter.delete('/dzen/screenshots', async (_req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  
  const screenshotsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'dzen-screenshots')
    : '/tmp/dzen-screenshots';
  
  try {
    if (fs.existsSync(screenshotsDir)) {
      const files = fs.readdirSync(screenshotsDir);
      for (const file of files) {
        fs.unlinkSync(path.join(screenshotsDir, file));
      }
    }
    res.json({ success: true, message: 'All screenshots deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
