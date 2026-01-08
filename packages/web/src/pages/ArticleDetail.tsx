import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Trash2 } from 'lucide-react';
import { io } from 'socket.io-client';
import { api } from '../lib/api';
import { PipelineStage, type Article } from '../types';
import PipelineProgress from '../components/PipelineProgress';
import ResearchView from '../components/ResearchView';
import ContentView from '../components/ContentView';
import CoverView from '../components/CoverView';
import PublishingView from '../components/PublishingView';

interface ResearchProgress {
  status: 'idle' | 'searching' | 'parsing' | 'completed' | 'failed' | 'stopped';
  currentFact: number;
  totalFacts: number;
  percentage: number;
  message?: string;
}

export default function ArticleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [researchProgress, setResearchProgress] = useState<ResearchProgress | null>(null);

  useEffect(() => {
    loadArticle();
    const interval = setInterval(loadArticle, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, [id]);

  // Socket.IO for research progress (independent of ResearchView)
  useEffect(() => {
    if (!id) return;
    
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    console.log('📡 ArticleDetail: Connecting to Socket.IO for progress...');
    
    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
    });

    socket.on('connect', () => {
      console.log('✅ ArticleDetail: Socket connected');
    });

    socket.on(`research:progress:${id}`, (progress: ResearchProgress) => {
      console.log('📡 ArticleDetail: Progress update:', progress);
      setResearchProgress(progress);
    });

    socket.on(`research:complete:${id}`, () => {
      console.log('✅ ArticleDetail: Research complete');
      setResearchProgress({
        status: 'completed',
        currentFact: 12,
        totalFacts: 12,
        percentage: 100,
        message: 'Исследование завершено!'
      });
      loadArticle(); // Reload to get research data
    });

    socket.on(`research:error:${id}`, ({ error }: { error: string }) => {
      console.error('❌ ArticleDetail: Research error:', error);
      setResearchProgress({
        status: 'failed',
        currentFact: 0,
        totalFacts: 0,
        percentage: 0,
        message: `Ошибка: ${error}`
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [id]);

  const loadArticle = async () => {
    try {
      const response = await api.get(`/articles/${id}`);
      setArticle(response.data.data);
    } catch (error) {
      console.error('Failed to load article:', error);
    } finally {
      setLoading(false);
    }
  };

  const startGeneration = async () => {
    try {
      await api.post(`/pipeline/${id}/generate`);
      alert('Генерация запущена!');
      loadArticle();
    } catch (error) {
      alert('Ошибка при запуске генерации');
    }
  };

  const deleteArticle = async () => {
    if (!confirm('Удалить статью полностью? Это действие нельзя отменить.')) return;
    
    try {
      await api.delete(`/articles/${id}`);
      alert('Статья удалена');
      navigate('/');
    } catch (error) {
      console.error('Failed to delete article:', error);
      alert('Ошибка при удалении статьи');
    }
  };

  if (loading) {
    return <div className="flex justify-center items-center h-64">Загрузка...</div>;
  }

  if (!article) {
    return <div className="text-center text-gray-500">Статья не найдена</div>;
  }

  // Determine if we should show cover generation
  const showCoverSection = article.content && (
    article.currentStage === PipelineStage.GENERATION || 
    article.currentStage === PipelineStage.COVER ||
    article.currentStage === PipelineStage.PUBLISHING ||
    article.currentStage === PipelineStage.COMPLETED ||
    ((article as any).coverImages && (article as any).coverImages.length > 0)
  );

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <div className="flex justify-between items-start mb-4">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft size={20} />
            Назад к статьям
          </button>
          
          <button
            onClick={deleteArticle}
            className="flex items-center gap-2 text-red-600 hover:text-red-800 hover:bg-red-50 px-3 py-2 rounded transition"
            title="Удалить статью"
          >
            <Trash2 size={18} />
            Удалить
          </button>
        </div>
        
        <h1 className="text-3xl font-bold mb-2">{article.celebrityName}</h1>
        <p className="text-gray-600">ID: {article.id}</p>
      </div>

      {/* Pipeline Progress */}
      <div className="mb-8">
        <PipelineProgress currentStage={article.currentStage as PipelineStage} />
      </div>

      {/* Stage Content */}
      <div className="space-y-6">
        {/* Research Progress (shown when no research data yet) */}
        {!article.researchData && researchProgress && researchProgress.status !== 'idle' && (
          <div className="card">
            <h2 className="text-xl font-semibold mb-4">🔬 Исследование</h2>
            <div className="p-4 bg-blue-50 rounded-lg">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium">
                  {researchProgress.status === 'searching' && '🔍 Поиск данных...'}
                  {researchProgress.status === 'parsing' && '📋 Обработка...'}
                  {researchProgress.status === 'completed' && '✅ Завершено!'}
                  {researchProgress.status === 'failed' && '❌ Ошибка'}
                  {researchProgress.status === 'stopped' && '⏸️ Остановлено'}
                </span>
                <span className="text-sm font-bold">{researchProgress.percentage}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3 mb-2">
                <div
                  className={`h-3 rounded-full transition-all duration-300 ${
                    researchProgress.status === 'failed' ? 'bg-red-500' :
                    researchProgress.status === 'completed' ? 'bg-green-500' :
                    'bg-blue-500 animate-pulse'
                  }`}
                  style={{ width: `${researchProgress.percentage}%` }}
                />
              </div>
              {researchProgress.message && (
                <p className="text-sm text-gray-600">{researchProgress.message}</p>
              )}
            </div>
          </div>
        )}

        {/* Research Results */}
        {article.researchData && (
          <ResearchView 
            data={article.researchData}
            articleId={article.id}
            onUpdate={loadArticle}
          />
        )}

        {/* Generation Controls */}
        {article.currentStage === PipelineStage.RESEARCH && article.researchData && (
          <div className="card">
            <h2 className="text-xl font-semibold mb-4">Следующий шаг: Генерация статьи</h2>
            <button onClick={startGeneration} className="btn btn-primary flex items-center gap-2">
              <Play size={20} />
              Сгенерировать статью
            </button>
          </div>
        )}

        {/* Generated Content */}
        {article.content && (
          <ContentView content={article.content} researchData={article.researchData} />
        )}

        {/* Cover Generation */}
        {showCoverSection && (
          <CoverView 
            articleId={article.id}
            celebrityName={article.celebrityName}
            coverImages={(article as any).coverImages || []}
            onCoverGenerated={loadArticle}
          />
        )}

        {/* Publishing */}
        {(article as any).coverImages && (article as any).coverImages.length > 0 && (
          <PublishingView articleId={article.id} publications={article.publications || []} />
        )}
      </div>
    </div>
  );
}
