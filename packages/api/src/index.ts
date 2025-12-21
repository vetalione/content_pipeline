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
const PORT = process.env.API_PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000'
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
app.listen(PORT, () => {
  console.log(`🚀 API server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

export default app;
