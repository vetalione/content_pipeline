import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { articlesRouter } from './routes/articles';
import { pipelineRouter } from './routes/pipeline';
import { publishingRouter } from './routes/publishing';
import { configRouter } from './routes/config';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || process.env.API_PORT || 3001);

// Middleware
const allowedOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',')
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/articles', articlesRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/publishing', publishingRouter);
app.use('/api/config', configRouter);

// Error handling
app.use(errorHandler);

// Start server
const HOST = '0.0.0.0'; // Listen on all interfaces for Railway
app.listen(PORT, HOST, () => {
  console.log(`🚀 API server running on port ${PORT}`);
  console.log(`📊 Health check: /health`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
