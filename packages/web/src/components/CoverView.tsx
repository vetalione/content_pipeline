import { useState, useEffect } from 'react';
import { Image, RefreshCw, Settings, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../lib/api';

interface CoverOptions {
  heroName: string;
  title: string;
  suggestedColors: string[];
  allColors: string[];
  suggestedIcons: string[];
  suggestedFact: string;
}

interface Props {
  articleId: string;
  celebrityName: string;
  coverImage?: {
    id: string;
    originalImageUrl: string;
    localPath: string;
    template: string;
  };
  onCoverGenerated: () => void;
}

export default function CoverView({ articleId, celebrityName, coverImage, onCoverGenerated }: Props) {
  const [loading, setLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [options, setOptions] = useState<CoverOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  
  // Custom values
  const [customHeroName, setCustomHeroName] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [selectedColor, setSelectedColor] = useState('');
  const [customIcons, setCustomIcons] = useState('');
  const [customFact, setCustomFact] = useState('');

  // Load preview options when showing advanced
  useEffect(() => {
    if (showAdvanced && !options) {
      loadOptions();
    }
  }, [showAdvanced]);

  const loadOptions = async () => {
    setLoadingOptions(true);
    try {
      const response = await api.get(`/pipeline/${articleId}/cover/preview`);
      if (response.data.success) {
        const opts = response.data.data;
        setOptions(opts);
        setCustomHeroName(opts.heroName);
        setCustomTitle(opts.title);
        setSelectedColor(opts.suggestedColors[0] || '');
        setCustomIcons(opts.suggestedIcons.join(', '));
        setCustomFact(opts.suggestedFact);
      }
    } catch (error) {
      console.error('Failed to load cover options:', error);
    } finally {
      setLoadingOptions(false);
    }
  };

  const generateCover = async (useCustom: boolean = false) => {
    setLoading(true);
    try {
      const payload: any = { template: 'default' };
      
      if (useCustom) {
        payload.heroName = customHeroName;
        payload.title = customTitle;
        payload.colorScheme = selectedColor;
        payload.icons = customIcons.split(',').map(s => s.trim()).filter(Boolean);
        payload.sharpFact = customFact;
      }
      
      await api.post(`/pipeline/${articleId}/cover`, payload);
      
      // Poll for completion
      const checkInterval = setInterval(async () => {
        try {
          const response = await api.get(`/articles/${articleId}`);
          if (response.data.data?.coverImage) {
            clearInterval(checkInterval);
            setLoading(false);
            onCoverGenerated();
          }
        } catch (e) {
          // ignore
        }
      }, 2000);

      // Timeout after 2 minutes
      setTimeout(() => {
        clearInterval(checkInterval);
        setLoading(false);
      }, 120000);
      
    } catch (error) {
      console.error('Failed to generate cover:', error);
      setLoading(false);
      alert('Ошибка при генерации обложки');
    }
  };

  return (
    <div className="card">
      <div className="flex justify-between items-start mb-6">
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <Image size={24} />
          🎨 Обложка статьи
        </h2>
        
        {coverImage && (
          <button 
            onClick={() => generateCover(showAdvanced)}
            disabled={loading}
            className="btn btn-secondary flex items-center gap-2"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            Перегенерировать
          </button>
        )}
      </div>

      {/* Existing Cover */}
      {coverImage && (
        <div className="mb-6">
          <div className="rounded-xl overflow-hidden shadow-lg">
            <img 
              src={coverImage.originalImageUrl} 
              alt={celebrityName}
              className="w-full h-auto"
            />
          </div>
          <p className="text-sm text-gray-500 mt-2 text-center">
            Сгенерировано через Gemini Imagen
          </p>
        </div>
      )}

      {/* Generation Controls */}
      {!coverImage && (
        <div className="space-y-4">
          {/* Quick Generate */}
          <button
            onClick={() => generateCover(false)}
            disabled={loading}
            className="w-full btn btn-primary flex items-center justify-center gap-2 py-4 text-lg"
          >
            {loading ? (
              <>
                <RefreshCw size={24} className="animate-spin" />
                Генерация обложки...
              </>
            ) : (
              <>
                <Sparkles size={24} />
                Сгенерировать обложку автоматически
              </>
            )}
          </button>

          {/* Advanced Options Toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full flex items-center justify-center gap-2 text-gray-600 hover:text-gray-900 py-2"
          >
            <Settings size={18} />
            Настроить параметры вручную
            {showAdvanced ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>

          {/* Advanced Options Panel */}
          {showAdvanced && (
            <div className="bg-gray-50 rounded-xl p-6 space-y-4">
              {loadingOptions ? (
                <div className="text-center py-4">
                  <RefreshCw size={24} className="animate-spin mx-auto mb-2" />
                  Загрузка параметров...
                </div>
              ) : (
                <>
                  {/* Hero Name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Имя героя (на английском)
                    </label>
                    <input
                      type="text"
                      value={customHeroName}
                      onChange={(e) => setCustomHeroName(e.target.value)}
                      className="input w-full"
                      placeholder="e.g., Will Smith"
                    />
                  </div>

                  {/* Title */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Заголовок для обложки
                    </label>
                    <input
                      type="text"
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      className="input w-full"
                      placeholder="Заголовок статьи"
                    />
                  </div>

                  {/* Color Scheme */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Цветовая схема
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {options?.allColors.map((color) => (
                        <button
                          key={color}
                          onClick={() => setSelectedColor(color)}
                          className={`px-3 py-2 rounded-lg text-sm transition-all ${
                            selectedColor === color
                              ? 'bg-primary text-white'
                              : 'bg-white border border-gray-200 hover:border-primary'
                          }`}
                        >
                          {color}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Icons */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Иконки (через запятую)
                    </label>
                    <input
                      type="text"
                      value={customIcons}
                      onChange={(e) => setCustomIcons(e.target.value)}
                      className="input w-full"
                      placeholder="e.g., microphone, film reel, Oscar statue"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Рекомендуемые: {options?.suggestedIcons.join(', ')}
                    </p>
                  </div>

                  {/* Sharp Fact */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Острый факт (3-5 слов)
                    </label>
                    <input
                      type="text"
                      value={customFact}
                      onChange={(e) => setCustomFact(e.target.value)}
                      className="input w-full"
                      placeholder="e.g., жил с мышами в 20 лет"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Рекомендуемый: {options?.suggestedFact}
                    </p>
                  </div>

                  {/* Generate with Custom Options */}
                  <button
                    onClick={() => generateCover(true)}
                    disabled={loading}
                    className="w-full btn btn-primary flex items-center justify-center gap-2 py-3"
                  >
                    {loading ? (
                      <>
                        <RefreshCw size={20} className="animate-spin" />
                        Генерация...
                      </>
                    ) : (
                      <>
                        <Sparkles size={20} />
                        Сгенерировать с этими параметрами
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Loading Overlay */}
      {loading && coverImage && (
        <div className="mt-4 p-4 bg-blue-50 rounded-lg text-center">
          <RefreshCw size={24} className="animate-spin mx-auto mb-2 text-blue-600" />
          <p className="text-blue-800">Генерируем новую обложку...</p>
          <p className="text-sm text-blue-600">Это может занять до 30 секунд</p>
        </div>
      )}
    </div>
  );
}
