import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { Sparkles } from 'lucide-react';
import { api } from '../lib/api';

interface FormData {
  celebrityName: string;
}

export default function NewArticle() {
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { errors } } = useForm<FormData>();
  const [loading, setLoading] = useState(false);
  const [language, setLanguage] = useState<'ru' | 'en' | 'both'>('ru');

  const onSubmit = async (data: FormData) => {
    try {
      setLoading(true);
      // include language selection
      const payload = { ...data, language };
      const response = await api.post('/articles', payload);
      const articleId = response.data.data.id;
      
      // Start research automatically
      await api.post(`/pipeline/${articleId}/research`);
      
      navigate(`/articles/${articleId}`);
    } catch (error) {
      console.error('Failed to create article:', error);
      alert('Ошибка при создании статьи');
    } finally {
      setLoading(false);
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
            disabled={loading}
            className="btn btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Создаём...' : 'Создать и начать исследование'}
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
