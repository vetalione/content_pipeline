import { useState } from 'react';
import { Settings, ChevronDown, ChevronUp } from 'lucide-react';

export interface ImageSearchConfig {
  sources: {
    google: boolean;
    brave: boolean;
  };
  confidenceThreshold: 75 | 85 | 95 | 99;
  resultsPerSource: 3 | 5 | 10 | 15;
}

interface Props {
  config: ImageSearchConfig;
  onChange: (config: ImageSearchConfig) => void;
}

export default function ImageSearchSettings({ config, onChange }: Props) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border border-gray-700 rounded-lg bg-gray-800/50 mb-4">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-800/70 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-purple-400" />
          <span className="font-medium text-white">Настройки поиска изображений</span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        )}
      </button>

      {/* Expanded Settings */}
      {isExpanded && (
        <div className="px-4 py-3 space-y-4 border-t border-gray-700">
          {/* Search Sources */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Поисковики (параллельный поиск)
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={config.sources.google}
                  onChange={(e) => onChange({
                    ...config,
                    sources: { ...config.sources, google: e.target.checked }
                  })}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-800"
                />
                <span className="text-sm text-gray-300">
                  Google Custom Search 
                  <span className="text-gray-500 text-xs ml-1">(EN + RU для русских персонажей)</span>
                </span>
              </label>
              
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={config.sources.brave}
                  onChange={(e) => onChange({
                    ...config,
                    sources: { ...config.sources, brave: e.target.checked }
                  })}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-orange-500 focus:ring-orange-500 focus:ring-offset-gray-800"
                />
                <span className="text-sm text-gray-300">
                  Brave Search 
                  <span className="text-gray-500 text-xs ml-1">(для редких изображений)</span>
                </span>
              </label>
            </div>
            {!config.sources.google && !config.sources.brave && (
              <p className="text-xs text-red-400 mt-1">⚠️ Выберите хотя бы один поисковик</p>
            )}
          </div>

          {/* Confidence Threshold */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Уровень уверенности (early-exit)
            </label>
            <div className="grid grid-cols-4 gap-2">
              {([75, 85, 95, 99] as const).map((threshold) => (
                <button
                  key={threshold}
                  onClick={() => onChange({ ...config, confidenceThreshold: threshold })}
                  className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                    config.confidenceThreshold === threshold
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {threshold}%
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Gemini остановит поиск при достижении этого уровня
            </p>
          </div>

          {/* Results Per Source */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Результатов с каждого поисковика
            </label>
            <div className="grid grid-cols-4 gap-2">
              {([3, 5, 10, 15] as const).map((count) => (
                <button
                  key={count}
                  onClick={() => onChange({ ...config, resultsPerSource: count })}
                  className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                    config.resultsPerSource === count
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Больше = дольше, но выше шанс найти идеальное фото
            </p>
          </div>

          {/* Summary */}
          <div className="pt-3 border-t border-gray-700">
            <p className="text-xs text-gray-400">
              <span className="font-medium text-gray-300">Итого кандидатов:</span>{' '}
              {(() => {
                let total = 0;
                if (config.sources.google) total += config.resultsPerSource * 2; // EN + RU
                if (config.sources.brave) total += config.resultsPerSource;
                return total;
              })()} 
              {' '}изображений · {' '}
              <span className="font-medium text-gray-300">Early-exit:</span> {config.confidenceThreshold}%
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
