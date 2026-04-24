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
        '4. Вставьте JSON в поле ниже и нажмите "Сохранить"',
        '5. Откройте DevTools (F12) → Network → любой запрос к editor-api',
        '6. Скопируйте значение заголовка X-FP-Token и вставьте ниже'
      ]
    },
    {
      platform: 'vk',
      name: 'ВКонтакте',
      authenticated: false,
      description: 'VK Статьи — полноценные статьи в группе (@group)',
      instructions: [
        '1. Откройте vk.com в браузере и войдите в аккаунт',
        '2. Установите расширение "EditThisCookie" или "Cookie-Editor"',
        '3. Экспортируйте все cookies как JSON',
        '4. Вставьте JSON в поле ниже и нажмите "Сохранить"',
        '5. Также убедитесь что VK_ACCESS_TOKEN и VK_GROUP_ID настроены'
      ]
    },
    {
      platform: 'pikabu',
      name: 'Пикабу',
      authenticated: false,
      description: 'Публикация длинных постов на pikabu.ru',
      instructions: [
        '1. Откройте pikabu.ru в браузере и войдите в аккаунт',
        '2. Установите расширение "EditThisCookie" или "Cookie-Editor"',
        '3. Экспортируйте все cookies для pikabu.ru как JSON',
        '4. Вставьте JSON в поле ниже и нажмите "Сохранить"'
      ]
    }
  ]);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [cookieInput, setCookieInput] = useState('');
  const [fpTokenInput, setFpTokenInput] = useState('');
  const [expandedPlatform, setExpandedPlatform] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // VK Playwright login state
  const [vkLoginEmail, setVkLoginEmail] = useState('');
  const [vkLoginPassword, setVkLoginPassword] = useState('');
  const [vkLoginSessionId, setVkLoginSessionId] = useState<string | null>(null);
  const [vkLoginStatus, setVkLoginStatus] = useState<string | null>(null);
  const [vkLoginStepMessage, setVkLoginStepMessage] = useState<string | null>(null);
  const [vkLoginScreenshot, setVkLoginScreenshot] = useState<string | null>(null);
  const [vkLoginQrImage, setVkLoginQrImage] = useState<string | null>(null);
  const [vkLoginStepValue, setVkLoginStepValue] = useState('');

  useEffect(() => {
    console.log('Settings page mounted, checking auth status...');
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    console.log('Checking auth status for API:', API_URL);
    try {
      // Check Dzen
      const dzenRes = await fetch(`${API_URL}/api/publishing/auth/dzen/status`, {
        signal: AbortSignal.timeout(5000)
      });
      if (dzenRes.ok) {
        const dzenData = await dzenRes.json();
        setPlatforms(prev => prev.map(p => 
          p.platform === 'dzen' 
            ? { ...p, authenticated: dzenData.data?.authenticated || false }
            : p
        ));
      }

      // Check VK
      const vkRes = await fetch(`${API_URL}/api/publishing/auth/vk/status`, {
        signal: AbortSignal.timeout(5000)
      });
      if (vkRes.ok) {
        const vkData = await vkRes.json();
        setPlatforms(prev => prev.map(p => 
          p.platform === 'vk' 
            ? { ...p, authenticated: vkData.data?.authenticated || false }
            : p
        ));
      }

      // Check Pikabu
      const pikabuRes = await fetch(`${API_URL}/api/publishing/auth/pikabu/status`, {
        signal: AbortSignal.timeout(5000)
      });
      if (pikabuRes.ok) {
        const pikabuData = await pikabuRes.json();
        setPlatforms(prev => prev.map(p =>
          p.platform === 'pikabu'
            ? { ...p, authenticated: pikabuData.data?.authenticated || false }
            : p
        ));
      }
    } catch (error) {
      console.error('Failed to check auth status:', error);
    } finally {
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

    // Helper to convert sameSite from browser extension format to Playwright format
    const convertSameSite = (sameSite: string | undefined): 'Strict' | 'Lax' | 'None' => {
      if (!sameSite) return 'Lax';
      const lower = sameSite.toLowerCase();
      if (lower === 'strict') return 'Strict';
      if (lower === 'none' || lower === 'no_restriction') return 'None';
      // 'lax', 'unspecified', or anything else -> Lax
      return 'Lax';
    };

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
              domain: c.domain?.startsWith('.') ? c.domain : `.${c.domain || (platform === 'pikabu' ? 'pikabu.ru' : platform === 'vk' ? 'vk.com' : 'dzen.ru')}`,
              path: c.path || '/',
              expires: c.expirationDate || -1,
              httpOnly: c.httpOnly || false,
              secure: c.secure !== false, // default to true
              sameSite: convertSameSite(c.sameSite)
            })),
            origins: []
          };
        } else {
          // Already in Playwright format - but still validate sameSite
          if (parsed.cookies && Array.isArray(parsed.cookies)) {
            parsed.cookies = parsed.cookies.map((c: any) => ({
              ...c,
              sameSite: convertSameSite(c.sameSite)
            }));
          }
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

  const handleSaveFpToken = async () => {
    if (!fpTokenInput.trim()) {
      setMessage({ type: 'error', text: 'Вставьте X-FP-Token' });
      return;
    }

    setSaving('fp-token');
    setMessage(null);

    try {
      const response = await fetch(`${API_URL}/api/publishing/auth/dzen/fp-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fpToken: fpTokenInput.trim() })
      });

      const data = await response.json();

      if (data.success) {
        setMessage({ type: 'success', text: 'X-FP-Token сохранён!' });
        setFpTokenInput('');
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

  // ===== VK Playwright Login =====

  const applyVkLoginResult = (r: any) => {
    setVkLoginSessionId(r.sessionId);
    setVkLoginStatus(r.status);
    setVkLoginStepMessage(r.message || null);
    setVkLoginScreenshot(r.screenshot || null);
    setVkLoginQrImage(r.qrImage || null);

    if (r.status === 'done') {
      setMessage({ type: 'success', text: 'Успешный вход в VK! Cookies сохранены.' });
      setVkLoginEmail('');
      setVkLoginPassword('');
      setVkLoginSessionId(null);
      setVkLoginStatus(null);
      setVkLoginQrImage(null);
      checkAuthStatus();
    } else if (r.status === 'error') {
      setMessage({ type: 'error', text: r.message || 'Ошибка входа' });
      setVkLoginSessionId(null);
    }
  };

  const handleStartVkLoginQr = async () => {
    setSaving('vk-login-qr');
    setMessage(null);
    setVkLoginScreenshot(null);
    setVkLoginQrImage(null);
    try {
      const response = await fetch(`${API_URL}/api/publishing/auth/vk/login/qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Ошибка открытия QR');
      applyVkLoginResult(data.data);
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
      setVkLoginSessionId(null);
      setVkLoginStatus(null);
    } finally {
      setSaving(null);
    }
  };

  const handleStartVkLogin = async () => {
    if (!vkLoginEmail.trim() || !vkLoginPassword.trim()) {
      setMessage({ type: 'error', text: 'Введите email/телефон и пароль' });
      return;
    }
    setSaving('vk-login');
    setMessage(null);
    setVkLoginScreenshot(null);
    setVkLoginQrImage(null);
    try {
      const response = await fetch(`${API_URL}/api/publishing/auth/vk/login/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: vkLoginEmail.trim(),
          password: vkLoginPassword,
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Ошибка входа');
      applyVkLoginResult(data.data);
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
      setVkLoginSessionId(null);
      setVkLoginStatus(null);
    } finally {
      setSaving(null);
    }
  };

  const handleSubmitVkStep = async () => {
    if (!vkLoginSessionId) return;
    if (!vkLoginStepValue.trim()) {
      setMessage({ type: 'error', text: 'Введите значение' });
      return;
    }
    setSaving('vk-login-step');
    setMessage(null);
    try {
      const response = await fetch(`${API_URL}/api/publishing/auth/vk/login/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: vkLoginSessionId,
          value: vkLoginStepValue.trim(),
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Ошибка');
      setVkLoginStepValue('');
      applyVkLoginResult(data.data);
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  const handleCancelVkLogin = async () => {
    if (!vkLoginSessionId) return;
    try {
      await fetch(`${API_URL}/api/publishing/auth/vk/login/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: vkLoginSessionId }),
      });
    } catch {
      /* ignore */
    }
    setVkLoginSessionId(null);
    setVkLoginStatus(null);
    setVkLoginStepMessage(null);
    setVkLoginScreenshot(null);
    setVkLoginQrImage(null);
    setVkLoginStepValue('');
  };

  const handleConfirmVkLogin = async () => {
    if (!vkLoginSessionId) return;
    setSaving('vk-login-confirm');
    try {
      const response = await fetch(
        `${API_URL}/api/publishing/auth/vk/login/confirm`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: vkLoginSessionId }),
        },
      );
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Ошибка');
      applyVkLoginResult(data.data);
      if (data.data?.status === 'done') {
        setMessage({ type: 'success', text: 'VK вход выполнен, cookies сохранены' });
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(null);
    }
  };

  // Poll the server while waiting for the user to scan a QR code
  useEffect(() => {
    if (!vkLoginSessionId || vkLoginStatus !== 'awaiting_qr') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/publishing/auth/vk/login/poll/${vkLoginSessionId}`,
        );
        const data = await res.json();
        if (cancelled) return;
        if (data.success) applyVkLoginResult(data.data);
      } catch {
        /* ignore transient errors */
      }
    };
    const iv = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vkLoginSessionId, vkLoginStatus]);

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
                  {platform.platform === 'vk' && (
                    <span className="text-xl font-bold text-blue-500">VK</span>
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
                    href={platform.platform === 'dzen' ? 'https://dzen.ru' : platform.platform === 'vk' ? 'https://vk.com' : platform.platform === 'pikabu' ? 'https://pikabu.ru' : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Открыть {platform.name}
                  </a>
                </div>

                <div className="space-y-3">
                  {/* VK Playwright Login (VK only) */}
                  {platform.platform === 'vk' && (
                    <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                      <h4 className="font-medium text-blue-900 mb-1">
                        🤖 Вход через Playwright (рекомендуется)
                      </h4>
                      <p className="text-xs text-blue-800 mb-3">
                        Вход в VK прямо с сервера — cookies будут привязаны к IP сервера,
                        что нужно для публикации VK Статей. Быстрее всего через QR-код
                        из мобильного приложения VK.
                      </p>

                      {!vkLoginSessionId ? (
                        <div className="space-y-3">
                          {/* QR option */}
                          <button
                            onClick={handleStartVkLoginQr}
                            disabled={saving === 'vk-login-qr'}
                            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                          >
                            {saving === 'vk-login-qr' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : null}
                            📱 Войти через QR-код
                          </button>

                          <div className="flex items-center gap-3">
                            <div className="flex-1 h-px bg-blue-200" />
                            <span className="text-xs text-blue-700">или через пароль</span>
                            <div className="flex-1 h-px bg-blue-200" />
                          </div>

                          <div className="space-y-2">
                            <input
                              type="text"
                              value={vkLoginEmail}
                              onChange={(e) => setVkLoginEmail(e.target.value)}
                              placeholder="Email или телефон (+7...)"
                              className="w-full p-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                              disabled={saving === 'vk-login'}
                            />
                            <input
                              type="password"
                              value={vkLoginPassword}
                              onChange={(e) => setVkLoginPassword(e.target.value)}
                              placeholder="Пароль"
                              className="w-full p-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                              disabled={saving === 'vk-login'}
                            />
                            <button
                              onClick={handleStartVkLogin}
                              disabled={saving === 'vk-login'}
                              className="flex items-center gap-2 px-4 py-2 bg-white border border-blue-600 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-50"
                            >
                              {saving === 'vk-login' ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : null}
                              Войти с паролем
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="text-sm text-gray-700">
                            <strong>Статус:</strong>{' '}
                            <span className="font-mono">{vkLoginStatus}</span>
                          </div>
                          {vkLoginStepMessage && (
                            <div className="text-sm text-blue-900 font-medium">
                              {vkLoginStepMessage}
                            </div>
                          )}

                          {/* QR code: big & centered */}
                          {vkLoginStatus === 'awaiting_qr' && vkLoginQrImage && (
                            <div className="flex flex-col items-center gap-2 p-4 bg-white border border-blue-300 rounded-lg">
                              <img
                                src={vkLoginQrImage}
                                alt="VK login QR code"
                                className="w-64 h-64 object-contain"
                              />
                              <p className="text-xs text-gray-600 text-center max-w-xs">
                                Откройте мобильное приложение VK →
                                «Настройки» → «Вход по QR-коду» →
                                наведите камеру на код.
                                <br />
                                Ожидаем сканирование (проверка каждые 3 сек)…
                              </p>
                              <button
                                onClick={handleConfirmVkLogin}
                                disabled={saving === 'vk-login-confirm'}
                                className="mt-2 flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                              >
                                {saving === 'vk-login-confirm' ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : null}
                                Я авторизовался на телефоне
                              </button>
                              <p className="text-[11px] text-gray-500 text-center max-w-xs">
                                Нажмите, если уже подтвердили вход в мобильном приложении VK — сервер дожмёт авторизацию.
                              </p>
                            </div>
                          )}

                          {/* Page screenshot — only if no QR to keep UI compact */}
                          {!(vkLoginStatus === 'awaiting_qr' && vkLoginQrImage) &&
                            vkLoginScreenshot && (
                              <img
                                src={vkLoginScreenshot}
                                alt="VK login screenshot"
                                className="w-full border border-gray-300 rounded-lg"
                              />
                            )}
                          {(vkLoginStatus === 'awaiting_sms' ||
                            vkLoginStatus === 'awaiting_captcha' ||
                            vkLoginStatus === 'awaiting_password' ||
                            vkLoginStatus === 'awaiting_2fa') && (
                            <div className="flex gap-2">
                              <input
                                type={vkLoginStatus === 'awaiting_password' ? 'password' : 'text'}
                                value={vkLoginStepValue}
                                onChange={(e) => setVkLoginStepValue(e.target.value)}
                                placeholder={
                                  vkLoginStatus === 'awaiting_sms'
                                    ? 'Код из SMS'
                                    : vkLoginStatus === 'awaiting_captcha'
                                    ? 'Символы с картинки'
                                    : vkLoginStatus === 'awaiting_password'
                                    ? 'Пароль'
                                    : 'Код'
                                }
                                className="flex-1 p-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                                disabled={saving === 'vk-login-step'}
                                onKeyDown={(e) => e.key === 'Enter' && handleSubmitVkStep()}
                              />
                              <button
                                onClick={handleSubmitVkStep}
                                disabled={saving === 'vk-login-step'}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                              >
                                {saving === 'vk-login-step' ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  'Отправить'
                                )}
                              </button>
                            </div>
                          )}
                          <button
                            onClick={handleCancelVkLogin}
                            className="text-sm text-red-600 hover:underline"
                          >
                            Отменить вход
                          </button>
                        </div>
                      )}
                    </div>
                  )}

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

                  {/* X-FP-Token section (Dzen only) */}
                  {platform.platform === 'dzen' && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      X-FP-Token (fingerprint)
                    </label>
                    <p className="text-xs text-gray-500 mb-2">
                      DevTools → Network → любой запрос к editor-api → Headers → X-FP-Token
                    </p>
                    <input
                      type="text"
                      value={fpTokenInput}
                      onChange={(e) => setFpTokenInput(e.target.value)}
                      placeholder="19cf8014944:1aebbe607b2e4cda:3076d96:..."
                      className="w-full p-3 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <button
                      onClick={handleSaveFpToken}
                      disabled={saving === 'fp-token'}
                      className="mt-2 flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
                    >
                      {saving === 'fp-token' ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4" />
                      )}
                      Сохранить FP-Token
                    </button>
                  </div>
                  )}
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
