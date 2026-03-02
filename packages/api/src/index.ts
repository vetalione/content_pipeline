import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import { articlesRouter } from './routes/articles';
import { pipelineRouter } from './routes/pipeline';
import { publishingRouter } from './routes/publishing';
import { configRouter } from './routes/config';
import factsRouter from './routes/facts';
import { errorHandler } from './middleware/errorHandler';
import { initializeSocketIO } from './lib/socket';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || process.env.API_PORT || 3001);

// Middleware
const allowedOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    // Check exact match
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    
    // Allow all Vercel preview and production domains
    if (origin && origin.match(/^https:\/\/.*\.vercel\.app$/)) {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve generated cover images as static files.
// Covers are stored in /covers/ on the Railway Volume — serving them here avoids
// encoding them as base64 in PostgreSQL and sending MBs through the API on every request.
app.use('/covers', express.static(path.join(process.cwd(), 'covers'), {
  maxAge: '7d',   // Browser cache — reduces repeated egress for the same image
  etag: true,
}));

// Fact-images downloaded by findFactImage() to bypass hotlink protection.
// Images are cached here once; original third-party URLs may return 403 on direct embed.
app.use('/images', express.static(path.join(process.cwd(), 'images'), {
  maxAge: '7d',
  etag: true,
}));

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/articles', articlesRouter);
app.use('/api', factsRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/publishing', publishingRouter);
app.use('/api/config', configRouter);

// Error handling
app.use(errorHandler);

// Create HTTP server and initialize Socket.IO
const httpServer = createServer(app);
initializeSocketIO(httpServer);

// Start server
const HOST = '0.0.0.0'; // Listen on all interfaces for Railway
httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 API server running on port ${PORT}`);
  console.log(`📊 Health check: /health`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
