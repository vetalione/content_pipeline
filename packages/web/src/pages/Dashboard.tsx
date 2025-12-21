import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Clock, CheckCircle, AlertCircle, Loader } from 'lucide-react';
import { api } from '../lib/api';
import type { Article } from '@content-pipeline/shared';

export default function Dashboard() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'draft' | 'in_progress' | 'published'>('all');

  useEffect(() => {
    loadArticles();
  }, [filter]);

  const loadArticles = async () => {
    try {
      setLoading(true);
      const params = filter !== 'all' ? { status: filter } : {};
      const response = await api.get('/articles', { params });
      setArticles(response.data.data || []);
    } catch (error) {
      console.error('Failed to load articles:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'draft':
        return <Clock className="text-gray-400" size={20} />;
      case 'in_progress':
        return <Loader className="text-blue-500 animate-spin" size={20} />;
      case 'published':
        return <CheckCircle className="text-green-500" size={20} />;
      case 'failed':
        return <AlertCircle className="text-red-500" size={20} />;
      default:
        return <Clock className="text-gray-400" size={20} />;
    }
  };

  const getStageLabel = (stage: string) => {
    const labels: Record<string, string> = {
      input: 'Ввод данных',
      research: 'Исследование',
      generation: 'Генерация',
      cover: 'Обложка',
      review: 'Проверка',
      publishing: 'Публикация',
      completed: 'Завершено',
      failed: 'Ошибка'
    };
    return labels[stage] || stage;
  };

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">Статьи</h1>
          <p className="text-gray-600">Управление контентом и публикациями</p>
        </div>
        
        <Link to="/articles/new" className="btn btn-primary flex items-center gap-2">
          <Plus size={20} />
          Новая статья
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-6">
        {(['all', 'draft', 'in_progress', 'published'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg transition-colors ${
              filter === f
                ? 'bg-primary text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {f === 'all' && 'Все'}
            {f === 'draft' && 'Черновики'}
            {f === 'in_progress' && 'В работе'}
            {f === 'published' && 'Опубликовано'}
          </button>
        ))}
      </div>

      {/* Articles Grid */}
      {loading ? (
        <div className="flex justify-center items-center h-64">
          <Loader className="animate-spin text-primary" size={40} />
        </div>
      ) : articles.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500 mb-4">Нет статей</p>
          <Link to="/articles/new" className="btn btn-primary inline-flex items-center gap-2">
            <Plus size={20} />
            Создать первую статью
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {articles.map((article) => (
            <Link
              key={article.id}
              to={`/articles/${article.id}`}
              className="card hover:shadow-md transition-shadow cursor-pointer"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <h3 className="font-semibold text-lg mb-1">{article.celebrityName}</h3>
                  <p className="text-sm text-gray-500">{getStageLabel(article.currentStage)}</p>
                </div>
                {getStatusIcon(article.status)}
              </div>
              
              <div className="text-xs text-gray-400">
                Создано: {new Date(article.createdAt).toLocaleDateString('ru-RU')}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
