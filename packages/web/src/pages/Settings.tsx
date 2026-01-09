import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, CheckCircle, XCircle, Upload, ExternalLink, Loader2 } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface PlatformStatus {
  platform: string;
  name: string;
  authenticated: boolean;
  description: string;
  instructions: string[];
}

export default function Settings() {
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([
    {
      platform: 'dzen',
      name: 'Яндекс Дзен',
      authenticated: false,
      description: 'Публикация статей на dzen.ru',
      instructions: [
        '1. Откройте dzen.ru в браузере и войдите в аккаунт',
        '2. Установите расширение "EditThisCookie" или "Cookie-Editor"',
        '3. Экспортируйте все cookies как JSON',
        '4. Вставьте JSON в поле ниже и нажмите "Сохранить"'
      ]
    }
  ]);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [cookieInput, setCookieInput] = useState('');
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    console.log('Settings page mounted, checking auth status...');
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    console.log('Checking auth status for API:', API_URL);
    try {
      const response = await fetch(`${API_URL}/api/publishing/auth/dzen/status`, {
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });
      console.log('Auth status response:', response.status);
      if (!response.ok) throw new Error('API error');
      const data = await response.json();
      console.log('Auth status data:', data);
      
      setPlatforms(prev => prev.map(p => 
        p.platform === 'dzen' 
          ? { ...p, authenticated: data.data?.authenticated || false }
          : p
      ));
    } catch (error) {
      console.error('Failed to check auth status:', error);
      // Still show the page even if API fails
    } finally {
      console.log('Setting loading to false');
      setLoading(false);
    }
  };

  const handleSaveCookies = async (platform: string) => {
    if (!cookieInput.trim()) {
      setMessage({ type: 'error', text: 'Вставьте cookies JSON' });
      return;
    }

    setSaving(platform);
    setMessage(null);

    try {
      // Parse cookies - support both array format and object format
      let cookies;
      try {
        const parsed = JSON.parse(cookieInput);
        
        // If it's an array of cookies from EditThisCookie
        if (Array.isArray(parsed)) {
          // Convert to Playwright storage state format
          cookies = {
            cookies: parsed.map((c: any) => ({
              name: c.name,
              value: c.value,
              domain: c.domain?.startsWith('.') ? c.domain : `.${c.domain || 'dzen.ru'}`,
              path: c.path || '/',
              expires: c.expirationDate || -1,
              httpOnly: c.httpOnly || false,
              secure: c.secure || true,
              sameSite: c.sameSite || 'Lax'
            })),
            origins: []
          };
        } else {
          // Already in Playwright format
          cookies = parsed;
        }
      } catch (e) {
        throw new Error('Неверный формат JSON. Скопируйте cookies из расширения браузера.');
      }

      const response = await fetch(`${API_URL}/api/publishing/auth/${platform}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionData: cookies })
      });

      const data = await response.json();

      if (data.success) {
        setMessage({ type: 'success', text: 'Cookies сохранены! Авторизация активна.' });
        setCookieInput('');
        setExpandedPlatform(null);
        checkAuthStatus();
      } else {
        throw new Error(data.error || 'Ошибка сохранения');
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <SettingsIcon className="w-8 h-8 text-gray-600" />
        <h1 className="text-2xl font-bold">Настройки публикации</h1>
      </div>

      {message && (
        <div className={`mb-6 p-4 rounded-lg ${
          message.type === 'success' 
            ? 'bg-green-50 border border-green-200 text-green-800' 
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          {message.text}
        </div>
      )}

      <div className="space-y-4">
        {platforms.map(platform => (
          <div 
            key={platform.platform}
            className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden"
          >
            {/* Header */}
            <div 
              className="p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50"
              onClick={() => setExpandedPlatform(
                expandedPlatform === platform.platform ? null : platform.platform
              )}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  platform.authenticated ? 'bg-green-100' : 'bg-gray-100'
                }`}>
                  {platform.platform === 'dzen' && (
                    <span className="text-xl font-bold text-orange-500">Д</span>
                  )}
                </div>
                <div>
                  <h3 className="font-medium">{platform.name}</h3>
                  <p className="text-sm text-gray-500">{platform.description}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                {platform.authenticated ? (
                  <span className="flex items-center gap-1 text-green-600 text-sm">
                    <CheckCircle className="w-4 h-4" />
                    Авторизован
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-gray-400 text-sm">
                    <XCircle className="w-4 h-4" />
                    Не авторизован
                  </span>
                )}
              </div>
            </div>

            {/* Expanded content */}
            {expandedPlatform === platform.platform && (
              <div className="p-4 border-t border-gray-100 bg-gray-50">
                <div className="mb-4">
                  <h4 className="font-medium mb-2">Инструкция:</h4>
                  <ol className="text-sm text-gray-600 space-y-1">
                    {platform.instructions.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                </div>

                <div className="flex gap-2 mb-4">
                  <a
                    href={platform.platform === 'dzen' ? 'https://dzen.ru' : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Открыть {platform.name}
                  </a>
                </div>

                <div className="space-y-3">
                  <textarea
                    value={cookieInput}
                    onChange={(e) => setCookieInput(e.target.value)}
                    placeholder='Вставьте JSON с cookies сюда...'
                    className="w-full h-32 p-3 border border-gray-300 rounded-lg font-mono text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  
                  <button
                    onClick={() => handleSaveCookies(platform.platform)}
                    disabled={saving === platform.platform}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving === platform.platform ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    Сохранить cookies
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Help section */}
      <div className="mt-8 p-4 bg-blue-50 rounded-lg border border-blue-100">
        <h3 className="font-medium text-blue-900 mb-2">💡 Как экспортировать cookies?</h3>
        <ol className="text-sm text-blue-800 space-y-2">
          <li>
            <strong>Chrome:</strong> Установите расширение{' '}
            <a 
              href="https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              EditThisCookie
            </a>
          </li>
          <li>
            <strong>Firefox:</strong> Установите{' '}
            <a 
              href="https://addons.mozilla.org/en-US/firefox/addon/cookie-editor/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Cookie-Editor
            </a>
          </li>
          <li>Войдите на сайт платформы (например, dzen.ru)</li>
          <li>Откройте расширение и нажмите "Export" → "JSON"</li>
          <li>Вставьте скопированный JSON в поле выше</li>
        </ol>
      </div>
    </div>
  );
}
