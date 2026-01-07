import { Server as SocketServer } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { ResearchProgress } from '@content-pipeline/shared';

let io: SocketServer | null = null;

/**
 * Initialize Socket.io server
 */
export function initializeSocketIO(httpServer: HTTPServer) {
  const allowedOrigins = process.env.CORS_ORIGIN 
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://localhost:5173'];

  io = new SocketServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        // Allow requests with no origin
        if (!origin) return callback(null, true);
        
        // Check exact match
        if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          return callback(null, true);
        }
        
        // Allow all Vercel domains
        if (origin && origin.match(/^https:\/\/.*\.vercel\.app$/)) {
          return callback(null, true);
        }
        
        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);

    socket.on('disconnect', () => {
      console.log('❌ Client disconnected:', socket.id);
    });

    // Listen for research control actions
    socket.on('research:control', async (data: { articleId: string; action: string }) => {
      console.log(`🎮 Research control: ${data.action} for article ${data.articleId}`);
      // This will be handled by the research worker
    });
  });

  console.log('🔌 Socket.IO initialized');
  return io;
}

/**
 * Emit research progress update
 */
export function emitResearchProgress(articleId: string, progress: ResearchProgress) {
  if (!io) {
    console.warn('⚠️ Socket.IO not initialized');
    return;
  }

  io.emit(`research:progress:${articleId}`, progress);
  console.log(`📡 Emitted progress for ${articleId}:`, progress.status, `${progress.percentage}%`);
}

/**
 * Emit research completed
 */
export function emitResearchComplete(articleId: string, data: any) {
  if (!io) {
    console.warn('⚠️ Socket.IO not initialized');
    return;
  }

  io.emit(`research:complete:${articleId}`, data);
  console.log(`✅ Research complete for ${articleId}`);
}

/**
 * Emit research error
 */
export function emitResearchError(articleId: string, error: string) {
  if (!io) {
    console.warn('⚠️ Socket.IO not initialized');
    return;
  }

  io.emit(`research:error:${articleId}`, { error });
  console.log(`❌ Research error for ${articleId}:`, error);
}

/**
 * Get Socket.IO instance
 */
export function getIO(): SocketServer {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
}

export { io };
