import { useState } from 'react';
import { Settings, ChevronDown, ChevronUp } from 'lucide-react';

export interface ImageSearchConfig {
  sources: {
    google: boolean;
    brave: boolean;
    perplexity: boolean;
    openai: boolean;
  };
  confidenceThreshold: 75 | 85 | 95 | 99;
  resultsPerSource: 3 | 5 | 10 | 15;
}

interface Props {
  config: ImageSearchConfig;
  onChange: (config: ImageSearchConfig) => void;
}

export default function ImageSearchSettings({ config, onChange }: Props) {
  const [isExpanded, setIsExpanded] = useState(true);

  // Ensure sources object has all required properties
  const sources = {
    google: config.sources?.google ?? true,
    brave: config.sources?.brave ?? true,
    perplexity: config.sources?.perplexity ?? true,
    openai: config.sources?.openai ?? false,
  };

  return (
    <div className="border border-gray-200 rounded-lg bg-white shadow-sm mb-4">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-purple-600" />
          <span className="font-medium text-gray-900">⚙️ Настройки поиска изображений</span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 text-gray-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-500" />
        )}
      </button>

      {/* Expanded Settings */}
      {isExpanded && (
        <div className="px-4 py-3 space-y-4 border-t border-gray-200">
          {/* Search Sources */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              🔍 Поисковики (параллельный поиск)
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sources.google}
                  onChange={(e) => onChange({
                    ...config,
                    sources: { ...sources, google: e.target.checked }
                  })}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  🔵 Google Custom Search 
                  <span className="text-gray-400 text-xs ml-1">(EN + RU для русских)</span>
                </span>
              </label>
              
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sources.brave}
                  onChange={(e) => onChange({
                    ...config,
                    sources: { ...sources, brave: e.target.checked }
                  })}
                  className="w-4 h-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                />
                <span className="text-sm text-gray-700">
                  🦁 Brave Search
                  <span className="text-gray-400 text-xs ml-1">(для редких фото)</span>
                </span>
              </label>
              
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sources.perplexity}
                  onChange={(e) => onChange({
                    ...config,
                    sources: { ...sources, perplexity: e.target.checked }
                  })}
                  className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
                <span className="text-sm text-gray-700">
                  🟣 Perplexity Sonar Pro
                  <span className="text-gray-400 text-xs ml-1">(AI-подбор)</span>
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sources.openai}
                  onChange={(e) => onChange({
                    ...config,
                    sources: { ...sources, openai: e.target.checked }
                  })}
                  className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span className="text-sm text-gray-700">
                  🧠 ChatGPT (GPT-5 web_search)
                  <span className="text-gray-400 text-xs ml-1">(дороже, медленнее)</span>
                </span>
              </label>
            </div>
            {!sources.google && !sources.brave && !sources.perplexity && !sources.openai && (
              <p className="text-xs text-red-500 mt-1">⚠️ Выберите хотя бы один поисковик</p>
            )}
          </div>

          {/* Confidence Threshold */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              🎯 Уровень уверенности Gemini (early-exit)
            </label>
            <div className="grid grid-cols-4 gap-2">
              {([75, 85, 95, 99] as const).map((threshold) => (
                <button
                  key={threshold}
                  onClick={() => onChange({ ...config, confidenceThreshold: threshold })}
                  className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                    config.confidenceThreshold === threshold
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {threshold}%
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Поиск останавливается при достижении порога
            </p>
          </div>

          {/* Results Per Source */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              📊 Результатов с каждого поисковика
            </label>
            <div className="grid grid-cols-4 gap-2">
              {([3, 5, 10, 15] as const).map((count) => (
                <button
                  key={count}
                  onClick={() => onChange({ ...config, resultsPerSource: count })}
                  className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                    config.resultsPerSource === count
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Больше = дольше, но выше шанс найти редкое фото
            </p>
          </div>

          {/* Summary */}
          <div className="pt-3 border-t border-gray-200 bg-gray-50 -mx-4 px-4 py-2 rounded-b-lg">
            <p className="text-xs text-gray-600">
              <span className="font-medium">📈 Итого кандидатов:</span>{' '}
              {(() => {
                let total = 0;
                if (sources.google) total += config.resultsPerSource * 2; // EN + RU
                if (sources.brave) total += config.resultsPerSource;
                if (sources.perplexity) total += config.resultsPerSource;
                if (sources.openai) total += config.resultsPerSource;
                return total;
              })()} 
              {' '}• Порог: {config.confidenceThreshold}%
              {' '}• Поисковики: {[
                sources.google && 'Google',
                sources.brave && 'Brave', 
                sources.perplexity && 'Perplexity',
                sources.openai && 'ChatGPT'
              ].filter(Boolean).join(', ') || 'Нет'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
