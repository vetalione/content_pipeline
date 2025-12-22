import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play } from 'lucide-react';
import { api } from '../lib/api';
import { PipelineStage, type Article } from '../types';
import PipelineProgress from '../components/PipelineProgress';
import ResearchView from '../components/ResearchView';
import ContentView from '../components/ContentView';
import PublishingView from '../components/PublishingView';

export default function ArticleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadArticle();
    const interval = setInterval(loadArticle, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
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

  const startCoverGeneration = async () => {
    try {
      await api.post(`/pipeline/${id}/cover`, { template: 'default' });
      alert('Создание обложки запущено!');
      loadArticle();
    } catch (error) {
      alert('Ошибка при создании обложки');
    }
  };

  if (loading) {
    return <div className="flex justify-center items-center h-64">Загрузка...</div>;
  }

  if (!article) {
    return <div className="text-center text-gray-500">Статья не найдена</div>;
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft size={20} />
          Назад к статьям
        </button>
        
        <h1 className="text-3xl font-bold mb-2">{article.celebrityName}</h1>
        <p className="text-gray-600">ID: {article.id}</p>
      </div>

      {/* Pipeline Progress */}
      <div className="mb-8">
        <PipelineProgress currentStage={article.currentStage as PipelineStage} />
      </div>

      {/* Stage Content */}
      <div className="space-y-6">
        {/* Research Results */}
        {article.researchData && (
          <ResearchView data={article.researchData} />
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
          <ContentView content={article.content} />
        )}

        {/* Cover Generation */}
        {article.currentStage === PipelineStage.GENERATION && article.content && !article.coverImage && (
          <div className="card">
            <h2 className="text-xl font-semibold mb-4">Следующий шаг: Создание обложки</h2>
            <button onClick={startCoverGeneration} className="btn btn-primary flex items-center gap-2">
              <Play size={20} />
              Создать обложку
            </button>
          </div>
        )}

        {/* Publishing */}
        {article.coverImage && (
          <PublishingView articleId={article.id} publications={article.publications || []} />
        )}
      </div>
    </div>
  );
}
