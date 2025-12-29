import { useState, useEffect } from 'react';
import { Image, Settings, Sparkles, ChevronDown, ChevronUp, Check, Trash2 } from 'lucide-react';
import { api } from '../lib/api';

interface CoverOptions {
  heroName: string;
  title: string;
  suggestedColors: string[];
  allColors: string[];
  suggestedIcons: string[];
  suggestedFact: string;
}

interface CoverImage {
  id: string;
  originalImageUrl: string;
  localPath: string;
  template: string;
  version: number;
  isSelected: boolean;
  generatedAt: string;
}

interface Props {
  articleId: string;
  celebrityName: string;
  coverImages: CoverImage[];
  onCoverGenerated: () => void;
}

export default function CoverView({ articleId, celebrityName, coverImages = [], onCoverGenerated }: Props) {
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
      
      // Poll for new cover version
      const checkInterval = setInterval(async () => {
        try {
          const response = await api.get(`/articles/${articleId}`);
          const covers = response.data.data?.coverImages || [];
          if (covers.length > coverImages.length) {
            clearInterval(checkInterval);
            setLoading(false);
            onCoverGenerated();
          }
        } catch (e) {
          // ignore
        }
      }, 2000);

      // Timeout after 3 minutes
      setTimeout(() => {
        clearInterval(checkInterval);
        setLoading(false);
      }, 180000);
      
    } catch (error) {
      console.error('Failed to generate cover:', error);
      setLoading(false);
      alert('Ошибка при генерации обложки');
    }
  };

  const selectCover = async (coverId: string) => {
    try {
      await api.post(`/pipeline/${articleId}/cover/${coverId}/select`);
      onCoverGenerated();
    } catch (error) {
      console.error('Failed to select cover:', error);
      alert('Ошибка при выборе обложки');
    }
  };

  const deleteCover = async (coverId: string) => {
    if (!confirm('Удалить эту версию обложки?')) return;
    
    try {
      await api.delete(`/pipeline/${articleId}/cover/${coverId}`);
      onCoverGenerated();
    } catch (error) {
      console.error('Failed to delete cover:', error);
      alert('Ошибка при удалении обложки');
    }
  };

  const sortedCovers = [...coverImages].sort((a, b) => 
    new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
  );

  return (
    <div className="card">
      <div className="flex justify-between items-start mb-6">
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <Image size={24} />
          🎨 Обложка статьи
          {coverImages.length > 0 && (
            <span className="text-sm text-gray-500 font-normal">
              ({coverImages.length} {coverImages.length === 1 ? 'версия' : 'версий'})
            </span>
          )}
        </h2>
        
        <button 
          onClick={() => generateCover(showAdvanced)}
          disabled={loading}
          className="btn btn-primary flex items-center gap-2"
        >
          <Sparkles size={18} className={loading ? 'animate-pulse' : ''} />
          {loading ? 'Генерирую...' : coverImages.length > 0 ? 'Новая версия' : 'Сгенерировать'}
        </button>
      </div>

      {/* Existing Covers Grid */}
      {sortedCovers.length > 0 && (
        <div className="mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedCovers.map((cover) => (
              <div 
                key={cover.id}
                className={`relative rounded-xl overflow-hidden shadow-lg transition-all ${
                  cover.isSelected ? 'ring-4 ring-blue-500' : 'hover:ring-2 hover:ring-gray-300'
                }`}
              >
                <img 
                  src={cover.originalImageUrl} 
                  alt={`${celebrityName} v${cover.version}`}
                  className="w-full h-auto"
                />
                
                {/* Version Badge */}
                <div className="absolute top-2 left-2 bg-black/70 text-white px-2 py-1 rounded text-xs font-mono">
                  v{cover.version}
                </div>

                {/* Selected Badge */}
                {cover.isSelected && (
                  <div className="absolute top-2 right-2 bg-blue-500 text-white px-2 py-1 rounded text-xs flex items-center gap-1">
                    <Check size={12} />
                    Выбрано
                  </div>
                )}

                {/* Actions */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3 flex justify-between items-center">
                  <span className="text-white text-xs">
                    {new Date(cover.generatedAt).toLocaleString('ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                  
                  <div className="flex gap-2">
                    {!cover.isSelected && (
                      <button
                        onClick={() => selectCover(cover.id)}
                        className="bg-white/20 hover:bg-white/30 text-white px-3 py-1 rounded text-xs flex items-center gap-1 transition"
                        title="Выбрать эту версию"
                      >
                        <Check size={14} />
                        Выбрать
                      </button>
                    )}
                    
                    {coverImages.length > 1 && (
                      <button
                        onClick={() => deleteCover(cover.id)}
                        className="bg-red-500/70 hover:bg-red-500 text-white px-2 py-1 rounded text-xs transition"
                        title="Удалить эту версию"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          
          <p className="text-sm text-gray-500 mt-4 text-center">
            Выберите лучшую версию обложки или сгенерируйте новую
          </p>
        </div>
      )}

      {/* Advanced Options */}
      <div className="border-t pt-4">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-gray-700 hover:text-gray-900 mb-4"
        >
          <Settings size={18} />
          Расширенные настройки
          {showAdvanced ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {showAdvanced && (
          <div className="space-y-4">
            {loadingOptions ? (
              <div className="text-center py-8 text-gray-500">
                Загрузка параметров...
              </div>
            ) : options ? (
              <>
                {/* Hero Name */}
                <div>
                  <label className="block text-sm font-medium mb-2">Имя героя</label>
                  <input
                    type="text"
                    value={customHeroName}
                    onChange={(e) => setCustomHeroName(e.target.value)}
                    className="input"
                    placeholder={celebrityName}
                  />
                </div>

                {/* Title */}
                <div>
                  <label className="block text-sm font-medium mb-2">Заголовок</label>
                  <input
                    type="text"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    className="input"
                  />
                </div>

                {/* Color Scheme */}
                <div>
                  <label className="block text-sm font-medium mb-2">Цветовая схема</label>
                  <select
                    value={selectedColor}
                    onChange={(e) => setSelectedColor(e.target.value)}
                    className="input"
                  >
                    <optgroup label="Рекомендуемые">
                      {options.suggestedColors.map((color) => (
                        <option key={color} value={color}>{color}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Все цвета">
                      {options.allColors.filter(c => !options.suggestedColors.includes(c)).map((color) => (
                        <option key={color} value={color}>{color}</option>
                      ))}
                    </optgroup>
                  </select>
                </div>

                {/* Icons */}
                <div>
                  <label className="block text-sm font-medium mb-2">Иконки (через запятую)</label>
                  <input
                    type="text"
                    value={customIcons}
                    onChange={(e) => setCustomIcons(e.target.value)}
                    className="input"
                    placeholder="guitar, microphone, star"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Рекомендуется: {options.suggestedIcons.join(', ')}
                  </p>
                </div>

                {/* Sharp Fact */}
                <div>
                  <label className="block text-sm font-medium mb-2">Острый факт</label>
                  <input
                    type="text"
                    value={customFact}
                    onChange={(e) => setCustomFact(e.target.value)}
                    className="input"
                  />
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
