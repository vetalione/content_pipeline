import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { Sparkles, Rocket } from 'lucide-react';
import { api } from '../lib/api';
import ImageSearchSettings, { ImageSearchConfig } from '../components/ImageSearchSettings';
import FactResearchSettings, { FactResearchConfig, DEFAULT_FACT_CONFIG } from '../components/FactResearchSettings';

interface FormData {
  celebrityName: string;
}

export default function NewArticle() {
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { errors }, getValues } = useForm<FormData>();
  const [loading, setLoading] = useState(false);
  const [autopilotLoading, setAutopilotLoading] = useState(false);
  const [language, setLanguage] = useState<'ru' | 'en' | 'both'>('ru');
  const [articleStyle, setArticleStyle] = useState<'basic' | 'rasplata'>('basic');

  // Image search config (shared via localStorage with ResearchView/ContentView)
  const [searchConfig, setSearchConfig] = useState<ImageSearchConfig>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('imageSearchConfig') : null;
    return saved
      ? JSON.parse(saved)
      : {
          sources: { google: true, brave: true, perplexity: true, openai: false },
          confidenceThreshold: 85,
          resultsPerSource: 5,
        };
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('imageSearchConfig', JSON.stringify(searchConfig));
    }
  }, [searchConfig]);

  // Cover model (shared via localStorage with CoverView)
  const [coverModel, setCoverModel] = useState<'gemini' | 'openai'>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('coverModel') : null;
    return saved === 'openai' ? 'openai' : 'gemini';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('coverModel', coverModel);
    }
  }, [coverModel]);

  // Fact research config (which AI models contribute facts)
  const [factConfig, setFactConfig] = useState<FactResearchConfig>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('factResearchConfig') : null;
    if (saved) {
      try { return JSON.parse(saved); } catch { /* fall through to default */ }
    }
    return DEFAULT_FACT_CONFIG;
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('factResearchConfig', JSON.stringify(factConfig));
    }
  }, [factConfig]);

  const onSubmit = async (data: FormData) => {
    try {
      setLoading(true);
      // include language and style selection
      const payload = { ...data, language, articleStyle };
      const response = await api.post('/articles', payload);
      const articleId = response.data.data.id;
      
      // Navigate first so Socket.IO connects before research starts
      navigate(`/articles/${articleId}`);
      
      // Start research after a brief delay to let Socket.IO connect
      setTimeout(async () => {
        try {
          await api.post(`/pipeline/${articleId}/research`, {
            factSources: factConfig.sources,
          });
        } catch (error) {
          console.error('Failed to start research:', error);
        }
      }, 500);
      
    } catch (error) {
      console.error('Failed to create article:', error);
      alert('Ошибка при создании статьи');
      setLoading(false);
    }
  };

  const onAutopilot = async () => {
    const celebrityName = getValues('celebrityName');
    if (!celebrityName?.trim()) {
      alert('Введите имя знаменитости');
      return;
    }

    try {
      setAutopilotLoading(true);
      
      // Create article
      const payload = { celebrityName, language, articleStyle };
      const response = await api.post('/articles', payload);
      const articleId = response.data.data.id;
      
      // Navigate first so Socket.IO connects
      navigate(`/articles/${articleId}`);
      
      // Start autopilot after a brief delay
      setTimeout(async () => {
        try {
          await api.post(`/pipeline/${articleId}/autopilot`, {
            factSources: factConfig.sources,
          });
        } catch (error) {
          console.error('Failed to start autopilot:', error);
        }
      }, 500);
      
    } catch (error) {
      console.error('Failed to create article:', error);
      alert('Ошибка при создании статьи');
      setAutopilotLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Новая статья</h1>
        <p className="text-gray-600">Начните с ввода имени знаменитости</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card">
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Язык контента</label>
          <div className="flex gap-3">
            <label className="inline-flex items-center gap-2">
              <input type="radio" name="language" value="ru" checked={language === 'ru'} onChange={() => setLanguage('ru')} />
              Русский
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" name="language" value="en" checked={language === 'en'} onChange={() => setLanguage('en')} />
              English
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" name="language" value="both" checked={language === 'both'} onChange={() => setLanguage('both')} />
              Рус & Eng
            </label>
          </div>
        </div>
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Стиль повествования</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label
              className={`flex flex-col gap-1 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                articleStyle === 'basic'
                  ? 'border-primary bg-blue-50'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="articleStyle"
                  value="basic"
                  checked={articleStyle === 'basic'}
                  onChange={() => setArticleStyle('basic')}
                />
                <span className="font-semibold">Базовый</span>
              </div>
              <p className="text-xs text-gray-600 ml-6">
                Лёгкая ирония, короткие предложения, дружеский рассказ. Текущий стиль канала.
              </p>
            </label>
            <label
              className={`flex flex-col gap-1 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                articleStyle === 'rasplata'
                  ? 'border-primary bg-blue-50'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="articleStyle"
                  value="rasplata"
                  checked={articleStyle === 'rasplata'}
                  onChange={() => setArticleStyle('rasplata')}
                />
                <span className="font-semibold">Расплата героя</span>
              </div>
              <p className="text-xs text-gray-600 ml-6">
                Глубже, драматургичнее. Драматическая ирония, форшедоуинг, ABT, голос-А/Б, ритм-контраст.
              </p>
            </label>
          </div>
        </div>
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">
            Имя знаменитости *
          </label>
          <input
            {...register('celebrityName', { 
              required: 'Введите имя знаменитости' 
            })}
            type="text"
            placeholder="Например: Илон Маск"
            className="input"
          />
          {errors.celebrityName && (
            <p className="text-red-500 text-sm mt-1">{errors.celebrityName.message}</p>
          )}
        </div>

        {/* Image search config (используется на этапе ресёрча и в контенте) */}
        <ImageSearchSettings config={searchConfig} onChange={setSearchConfig} />

        {/* Fact research config (какие AI-модели собирают факты) */}
        <FactResearchSettings config={factConfig} onChange={setFactConfig} />

        {/* Cover model selector */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Модель для обложки</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label
              className={`flex flex-col gap-1 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                coverModel === 'gemini'
                  ? 'border-primary bg-blue-50'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="coverModel"
                  value="gemini"
                  checked={coverModel === 'gemini'}
                  onChange={() => setCoverModel('gemini')}
                />
                <span className="font-semibold">🍌 Nano Banana (Gemini)</span>
              </div>
              <p className="text-xs text-gray-600 ml-6">
                Быстрее и дешевле. Оптимально для большинства обложек.
              </p>
            </label>
            <label
              className={`flex flex-col gap-1 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                coverModel === 'openai'
                  ? 'border-primary bg-blue-50'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="coverModel"
                  value="openai"
                  checked={coverModel === 'openai'}
                  onChange={() => setCoverModel('openai')}
                />
                <span className="font-semibold">🎨 GPT Image (OpenAI)</span>
              </div>
              <p className="text-xs text-gray-600 ml-6">
                Дороже и медленнее, но часто более выразительный результат.
              </p>
            </label>
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <div className="flex items-start gap-3">
            <Sparkles className="text-blue-500 mt-1" size={20} />
            <div className="text-sm text-gray-700">
              <p className="font-medium mb-1">Что произойдёт дальше:</p>
              <ol className="list-decimal list-inside space-y-1 text-gray-600">
                <li>AI соберёт информацию о неудачах и драмах</li>
                <li>Сгенерирует статью в вашем стиле</li>
                <li>Создаст обложку</li>
                <li>Вы проверите и опубликуете</li>
              </ol>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading || autopilotLoading}
            className="btn btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Создаём...' : 'Создать и начать исследование'}
          </button>
          
          <button
            type="button"
            onClick={onAutopilot}
            disabled={loading || autopilotLoading}
            className="btn flex-1 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            style={{ 
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              border: 'none'
            }}
          >
            <Rocket size={18} />
            {autopilotLoading ? 'Запускаем...' : 'Автопилот'}
          </button>
          
          <button
            type="button"
            onClick={() => navigate('/')}
            className="btn btn-secondary"
          >
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}
