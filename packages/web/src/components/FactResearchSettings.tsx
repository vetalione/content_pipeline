import { useState } from 'react';
import { Search, ChevronDown, ChevronUp } from 'lucide-react';

export type FactSource = 'perplexity' | 'gpt' | 'claude' | 'gemini';

export interface FactResearchConfig {
  sources: Record<FactSource, boolean>;
}

export const DEFAULT_FACT_CONFIG: FactResearchConfig = {
  sources: { perplexity: true, gpt: false, claude: false, gemini: false },
};

interface Props {
  config: FactResearchConfig;
  onChange: (config: FactResearchConfig) => void;
}

export default function FactResearchSettings({ config, onChange }: Props) {
  const [isExpanded, setIsExpanded] = useState(true);

  // Defensive: ensure sources object has all required properties
  const sources = {
    perplexity: config.sources?.perplexity ?? true,
    gpt: config.sources?.gpt ?? false,
    claude: config.sources?.claude ?? false,
    gemini: config.sources?.gemini ?? false,
  };

  const noneSelected = !sources.perplexity && !sources.gpt && !sources.claude && !sources.gemini;

  const toggle = (key: FactSource) =>
    onChange({ ...config, sources: { ...sources, [key]: !sources[key] } });

  return (
    <div className="border border-gray-200 rounded-lg bg-white shadow-sm mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors rounded-t-lg"
        type="button"
      >
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-indigo-600" />
          <span className="font-medium text-gray-900">📚 Поиск фактов (мульти-AI)</span>
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
      </button>

      {isExpanded && (
        <div className="px-4 py-3 space-y-3 border-t border-gray-200">
          <p className="text-xs text-gray-500 leading-relaxed">
            Если выбрано несколько моделей — они работают параллельно и выдают свои факты.
            Дальше вы убираете дубли и неинтересное вручную (или автопилот сам выбирает лучшее).
          </p>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sources.perplexity}
                onChange={() => toggle('perplexity')}
                className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
              />
              <span className="text-sm text-gray-700">
                🟣 Perplexity Sonar Pro
                <span className="text-gray-400 text-xs ml-1">(web-поиск, цитаты, основной)</span>
              </span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sources.gpt}
                onChange={() => toggle('gpt')}
                className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-sm text-gray-700">
                🧠 GPT-4o (OpenAI)
                <span className="text-gray-400 text-xs ml-1">(параметрические знания, разнообразие)</span>
              </span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sources.claude}
                onChange={() => toggle('claude')}
                className="w-4 h-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
              />
              <span className="text-sm text-gray-700">
                🤖 Claude Sonnet 4.5 (Anthropic)
                <span className="text-gray-400 text-xs ml-1">(детальные нарративные факты)</span>
              </span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={sources.gemini}
                onChange={() => toggle('gemini')}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">
                💎 Gemini 2.5 Flash (Google)
                <span className="text-gray-400 text-xs ml-1">(быстро, широкий охват)</span>
              </span>
            </label>
          </div>

          {noneSelected && (
            <p className="text-xs text-red-500">⚠️ Выберите хотя бы одну модель — иначе ресёрч не запустится</p>
          )}
        </div>
      )}
    </div>
  );
}
