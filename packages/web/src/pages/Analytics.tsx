import { BarChart3, TrendingUp, Eye, FileText, Clock } from 'lucide-react';

export default function Analytics() {
  // TODO: Fetch real analytics data
  const stats = {
    totalArticles: 0,
    publishedToday: 0,
    totalViews: 0,
    avgGenerationTime: 0
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <BarChart3 className="w-8 h-8 text-gray-600" />
        <h1 className="text-2xl font-bold">Аналитика</h1>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <FileText className="w-8 h-8 text-blue-500" />
            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">Всего</span>
          </div>
          <p className="text-3xl font-bold">{stats.totalArticles}</p>
          <p className="text-sm text-gray-500">Статей создано</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <TrendingUp className="w-8 h-8 text-green-500" />
            <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">Сегодня</span>
          </div>
          <p className="text-3xl font-bold">{stats.publishedToday}</p>
          <p className="text-sm text-gray-500">Опубликовано</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <Eye className="w-8 h-8 text-purple-500" />
            <span className="text-xs bg-purple-100 text-purple-800 px-2 py-1 rounded">Просмотры</span>
          </div>
          <p className="text-3xl font-bold">{stats.totalViews}</p>
          <p className="text-sm text-gray-500">Всего просмотров</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <Clock className="w-8 h-8 text-orange-500" />
            <span className="text-xs bg-orange-100 text-orange-800 px-2 py-1 rounded">Среднее</span>
          </div>
          <p className="text-3xl font-bold">{stats.avgGenerationTime}m</p>
          <p className="text-sm text-gray-500">Время генерации</p>
        </div>
      </div>

      {/* Coming Soon */}
      <div className="bg-white rounded-xl shadow-sm p-8 text-center">
        <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <BarChart3 className="w-8 h-8 text-gray-400" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Аналитика в разработке</h2>
        <p className="text-gray-500 max-w-md mx-auto">
          Скоро здесь появятся графики просмотров, статистика публикаций на разных платформах 
          и детальная аналитика по каждой статье.
        </p>
      </div>
    </div>
  );
}
