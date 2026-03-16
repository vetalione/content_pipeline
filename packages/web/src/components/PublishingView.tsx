import { useState } from 'react';
import { Platform, Publication } from '../types';
import { Send, CheckCircle, XCircle, Clock } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  articleId: string;
  publications: Publication[];
}

const platformLabels: Record<Platform, string> = {
  [Platform.TELEGRAM]: 'Telegram',
  [Platform.VK]: 'ВКонтакте',
  [Platform.INSTAGRAM]: 'Instagram',
  [Platform.YOUTUBE]: 'YouTube',
  [Platform.MEDIUM]: 'Medium',
  [Platform.FACEBOOK]: 'Facebook',
  [Platform.TWITTER]: 'Twitter/X',
  [Platform.LINKEDIN]: 'LinkedIn',
  [Platform.THREADS]: 'Threads',
  [Platform.DZEN]: 'Яндекс.Дзен',
};

export default function PublishingView({ articleId, publications }: Props) {
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([]);
  const [publishing, setPublishing] = useState(false);

  const handlePublish = async () => {
    if (selectedPlatforms.length === 0) {
      alert('Выберите хотя бы одну платформу');
      return;
    }

    try {
      setPublishing(true);
      await api.post(`/publishing/${articleId}/publish`, {
        platforms: selectedPlatforms,
      });
      alert('Публикация запущена!');
      window.location.reload();
    } catch (error) {
      alert('Ошибка при публикации');
    } finally {
      setPublishing(false);
    }
  };

  const togglePlatform = (platform: Platform) => {
    setSelectedPlatforms(prev =>
      prev.includes(platform)
        ? prev.filter(p => p !== platform)
        : [...prev, platform]
    );
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'published':
        return <CheckCircle className="text-green-500" size={20} />;
      case 'failed':
        return <XCircle className="text-red-500" size={20} />;
      default:
        return <Clock className="text-gray-400" size={20} />;
    }
  };

  return (
    <div className="card">
      <h2 className="text-2xl font-semibold mb-6">📱 Публикация</h2>

      {/* Platform selection */}
      <div className="mb-8">
        <h3 className="text-lg font-semibold mb-4">Выберите платформы</h3>
        <div className="grid grid-cols-3 gap-3">
          {Object.entries(platformLabels).map(([platform, label]) => {
            const isPublished = publications.some(
              p => p.platform === platform && p.status === 'published'
            );
            const isSelected = selectedPlatforms.includes(platform as Platform);

            return (
              <button
                key={platform}
                onClick={() => togglePlatform(platform as Platform)}
                className={`p-4 rounded-lg border-2 transition-all ${
                  isSelected
                    ? 'bg-primary text-white border-primary'
                    : isPublished
                    ? 'bg-green-50 border-green-500 hover:border-primary'
                    : 'bg-white border-gray-300 hover:border-primary'
                }`}
              >
                <div className="font-semibold">{label}</div>
                {isPublished && !isSelected && (
                  <div className="text-xs mt-1">✓ Опубликовано</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Publish button */}
      <div className="mb-8">
        <button
          onClick={handlePublish}
          disabled={publishing || selectedPlatforms.length === 0}
          className="btn btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <Send size={20} />
          {publishing ? 'Публикуем...' : 'Опубликовать сейчас'}
        </button>
      </div>

      {/* Publication history */}
      {publications.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-4">История публикаций</h3>
          <div className="space-y-3">
            {publications.map((pub) => (
              <div key={pub.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg overflow-hidden">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {getStatusIcon(pub.status)}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {platformLabels[pub.platform as Platform]}
                    </div>
                    <div className="text-sm text-gray-600 break-words overflow-hidden" style={{ wordBreak: 'break-word' }}>
                      {pub.status === 'published' && pub.publishedAt
                        ? new Date(pub.publishedAt).toLocaleString('ru-RU')
                        : pub.error 
                          ? (pub.error.length > 100 ? pub.error.substring(0, 100) + '...' : pub.error)
                          : 'В процессе...'}
                    </div>
                    {/* Show full error in tooltip if truncated */}
                    {pub.error && pub.error.length > 100 && (
                      <details className="mt-1">
                        <summary className="text-xs text-blue-600 cursor-pointer hover:underline">Показать полную ошибку</summary>
                        <pre className="mt-2 text-xs bg-red-50 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{pub.error}</pre>
                      </details>
                    )}
                  </div>
                </div>
                {pub.publishedUrl && (
                  <a
                    href={pub.publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline text-sm flex-shrink-0 ml-2"
                  >
                    Открыть →
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
