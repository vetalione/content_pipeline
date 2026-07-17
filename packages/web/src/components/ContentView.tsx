import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { ArticleContent, ResearchData } from '../types';
import { Edit, ImagePlus, RefreshCw, Settings, ChevronDown, ChevronUp, Check, X } from 'lucide-react';
import ImageSearchSettings, { ImageSearchConfig } from './ImageSearchSettings';

interface Props {
  content: ArticleContent;
  researchData?: ResearchData | null;
  articleId: string;
  onUpdate?: () => void;
}

interface SectionImageProgress {
  articleId: string;
  sectionIndex: number;
  status: string;
  progress: number;
  message?: string;
  confidence?: number;
}

/** A Gemini-scored candidate returned by the API for manual selection */
interface ImageCandidateOption {
  originalUrl: string;
  thumbnailUrl?: string;
  sourceUrl?: string;
  source: string;
  confidence: number;
  metadataScore: number;
}

/**
 * Coerce a value into a renderable string. Some AI models return fields that
 * the schema declares as strings (teaser, blockquote, bonusFact, ...) as objects
 * like { text: "..." }. Rendering such an object directly crashes React
 * ("Objects are not valid as a React child" / minified error #31), producing a
 * white screen. This safely unwraps the common shapes.
 */
function toText(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.value === 'string') return value.value;
    if (typeof value.content === 'string') return value.content;
  }
  return '';
}

export default function ContentView({ content, researchData, articleId, onUpdate }: Props) {
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
  const [searchingImageIds, setSearchingImageIds] = useState<Set<number>>(new Set());
  const [imageProgress, setImageProgress] = useState<SectionImageProgress | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Per-section candidate galleries (sectionIndex → scored candidates)
  const [sectionCandidates, setSectionCandidates] = useState<Record<number, ImageCandidateOption[]>>({});
  const [settingImageIdx, setSettingImageIdx] = useState<number | null>(null);
  
  // Image search configuration
  const [searchConfig, setSearchConfig] = useState<ImageSearchConfig>(() => {
    const saved = localStorage.getItem('imageSearchConfig');
    return saved ? JSON.parse(saved) : {
      sources: { google: true, brave: true, perplexity: true, openai: false },
      confidenceThreshold: 70,
      resultsPerSource: 5
    };
  });

  // Save config to localStorage
  useEffect(() => {
    localStorage.setItem('imageSearchConfig', JSON.stringify(searchConfig));
  }, [searchConfig]);

  // Socket.IO connection
  useEffect(() => {
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    const socket = io(API_URL, { transports: ['websocket', 'polling'] });

    socket.on('section-image-search-progress', (prog: SectionImageProgress) => {
      if (prog.articleId === articleId) {
        setImageProgress(prog);
        if (prog.status === 'complete' || prog.status === 'error' || prog.status === 'not-found') {
          setTimeout(() => setImageProgress(null), 2000);
        }
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [articleId]);

  // Find image for section
  const handleFindImage = async (sectionIndex: number) => {
    setSearchingImageIds(prev => new Set(prev).add(sectionIndex));
    setImageProgress({
      articleId,
      sectionIndex,
      status: 'searching',
      progress: 5,
      message: 'Начинаем поиск...'
    });

    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const response = await fetch(`${API_URL}/api/articles/${articleId}/sections/${sectionIndex}/find-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          useGoogle: searchConfig.sources.google,
          useBrave: searchConfig.sources.brave,
          usePerplexity: searchConfig.sources.perplexity,
          useOpenAI: searchConfig.sources.openai,
          confidenceThreshold: searchConfig.confidenceThreshold,
          resultsPerSource: searchConfig.resultsPerSource
        })
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message || 'Failed to find image');
      }

      // Store scored candidates so the user can always re-pick manually —
      // including when auto-selection didn't clear the quality floor.
      const candidates: ImageCandidateOption[] = result.data?.candidates || [];
      setSectionCandidates(prev => ({ ...prev, [sectionIndex]: candidates }));

      if (result.success) {
        console.log('✅ Section image found:', result.data);
        onUpdate?.();
      } else {
        // No auto-pick, but candidates are available for manual choice
        console.log(`ℹ️ No image cleared the quality floor; ${candidates.length} candidates available for manual pick`);
      }
    } catch (error) {
      console.error('Section image search error:', error);
      setImageProgress({
        articleId,
        sectionIndex,
        status: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setSearchingImageIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(sectionIndex);
        return newSet;
      });
    }
  };

  // Manually pick a candidate from the gallery
  const handlePickCandidate = async (sectionIndex: number, candidate: ImageCandidateOption) => {
    setSettingImageIdx(sectionIndex);
    try {
      const response = await fetch(`${API_URL}/api/articles/${articleId}/sections/${sectionIndex}/set-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: candidate.originalUrl,
          thumbnailUrl: candidate.thumbnailUrl
        })
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Failed to set image');
      }
      // Clear gallery for this section and refresh article
      setSectionCandidates(prev => {
        const next = { ...prev };
        delete next[sectionIndex];
        return next;
      });
      onUpdate?.();
    } catch (error) {
      console.error('Set image error:', error);
      alert(error instanceof Error ? error.message : 'Не удалось установить изображение');
    } finally {
      setSettingImageIdx(null);
    }
  };

  // Get matching fact for section
  const getMatchingFact = (section: any) => {
    const facts = researchData?.facts || [];
    if (section.factId) {
      return facts.find((f: any) => f.id === section.factId && !f.isDeleted);
    }
    return null;
  };

  // ── Inline text editing ────────────────────────────────────────────────────
  // editingKey: 'header' | `section-${idx}` | 'conclusion' | 'heroQuote' | 'bonusFact'
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>({});
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = (key: string, initial: any) => {
    setEditingKey(key);
    setDraft(initial);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setDraft({});
  };

  /** Deep-copy content, apply mutation, PATCH to the API, refresh. */
  const saveContentPatch = async (mutate: (c: any) => void) => {
    setSavingEdit(true);
    try {
      const updated = JSON.parse(JSON.stringify(content));
      mutate(updated);
      const response = await fetch(`${API_URL}/api/articles/${articleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: updated }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.message || 'Не удалось сохранить изменения');
      }
      setEditingKey(null);
      setDraft({});
      onUpdate?.();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Не удалось сохранить изменения');
    } finally {
      setSavingEdit(false);
    }
  };

  /** Small pencil button shown next to editable blocks */
  const EditButton = ({ onClick, title = 'Редактировать текст' }: { onClick: () => void; title?: string }) => (
    <button
      onClick={onClick}
      className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition"
      title={title}
    >
      <Edit size={16} />
    </button>
  );

  /** Save / Cancel row for edit forms */
  const EditActions = () => (
    <div className="flex gap-2 mt-3">
      <button
        onClick={() => {
          if (editingKey === 'header') {
            saveContentPatch(c => { c.title = draft.title; c.teaser = draft.teaser; });
          } else if (editingKey?.startsWith('section-')) {
            const idx = parseInt(editingKey.split('-')[1], 10);
            saveContentPatch(c => {
              const s = c.sections[idx];
              s.heading = draft.heading;
              if (draft.hasParagraphs) {
                s.paragraph1 = draft.paragraph1;
                s.paragraph2 = draft.paragraph2;
              } else {
                s.content = draft.content;
              }
              s.blockquote = draft.blockquote?.trim() ? draft.blockquote : null;
            });
          } else if (editingKey === 'conclusion') {
            saveContentPatch(c => {
              c.conclusion = { heading: draft.heading, text: draft.text };
            });
          } else if (editingKey === 'heroQuote') {
            saveContentPatch(c => {
              c.heroQuote = draft.text?.trim() ? { text: draft.text, author: draft.author } : null;
            });
          } else if (editingKey === 'bonusFact') {
            saveContentPatch(c => {
              c.bonusFact = draft.text?.trim() ? draft.text : null;
            });
          }
        }}
        disabled={savingEdit}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm disabled:opacity-50"
      >
        <Check size={16} /> {savingEdit ? 'Сохраняем...' : 'Сохранить'}
      </button>
      <button
        onClick={cancelEdit}
        disabled={savingEdit}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg text-sm disabled:opacity-50"
      >
        <X size={16} /> Отмена
      </button>
    </div>
  );

  // ── Block images (Успех / Бонусный факт) ──────────────────────────────────
  const [blockSearching, setBlockSearching] = useState<Record<string, boolean>>({});
  const [blockCandidates, setBlockCandidates] = useState<Record<string, ImageCandidateOption[]>>({});
  const [blockSetting, setBlockSetting] = useState<string | null>(null);

  const handleFindBlockImage = async (blockKey: 'conclusion' | 'bonus') => {
    setBlockSearching(prev => ({ ...prev, [blockKey]: true }));
    try {
      const response = await fetch(`${API_URL}/api/articles/${articleId}/blocks/${blockKey}/find-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          useGoogle: searchConfig.sources.google,
          useBrave: searchConfig.sources.brave,
          usePerplexity: searchConfig.sources.perplexity,
          useOpenAI: searchConfig.sources.openai,
          confidenceThreshold: searchConfig.confidenceThreshold,
          resultsPerSource: searchConfig.resultsPerSource
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Failed to find image');
      setBlockCandidates(prev => ({ ...prev, [blockKey]: result.data?.candidates || [] }));
      if (result.success) onUpdate?.();
    } catch (error) {
      console.error('Block image search error:', error);
      alert(error instanceof Error ? error.message : 'Ошибка поиска изображения');
    } finally {
      setBlockSearching(prev => ({ ...prev, [blockKey]: false }));
    }
  };

  const handlePickBlockCandidate = async (blockKey: 'conclusion' | 'bonus', candidate: ImageCandidateOption) => {
    setBlockSetting(blockKey);
    try {
      const response = await fetch(`${API_URL}/api/articles/${articleId}/blocks/${blockKey}/set-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: candidate.originalUrl, thumbnailUrl: candidate.thumbnailUrl })
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || 'Failed to set image');
      setBlockCandidates(prev => { const n = { ...prev }; delete n[blockKey]; return n; });
      onUpdate?.();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Не удалось установить изображение');
    } finally {
      setBlockSetting(null);
    }
  };

  /** Image area for a block: current image with re-pick, or a find button, plus candidate gallery */
  const renderBlockImage = (blockKey: 'conclusion' | 'bonus', imageUrl?: string) => {
    const isSearching = !!blockSearching[blockKey];
    const cands = blockCandidates[blockKey];
    return (
      <div className="my-3">
        {imageUrl ? (
          <div className="rounded-lg overflow-hidden relative group bg-gray-100">
            <img
              src={imageUrl.startsWith('/') ? `${API_URL}${imageUrl}` : imageUrl}
              alt={blockKey === 'conclusion' ? 'Успех' : 'Бонусный факт'}
              className="w-full max-h-96 object-contain rounded-lg"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <button
              onClick={() => handleFindBlockImage(blockKey)}
              disabled={isSearching}
              className="absolute top-2 right-2 bg-white/90 hover:bg-white p-2 rounded-lg shadow opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
              title="Переподобрать изображение"
            >
              <RefreshCw size={18} className={isSearching ? 'animate-spin' : ''} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => handleFindBlockImage(blockKey)}
            disabled={isSearching}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700 transition disabled:opacity-50"
          >
            <ImagePlus size={18} />
            {isSearching ? 'Поиск...' : 'Подобрать изображение'}
          </button>
        )}

        {cands && cands.length > 0 && (
          <div className="mt-3 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm font-medium text-amber-900 mb-3">
              🖼️ Кандидаты от поиска (оценка Gemini) — выберите вручную:
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {cands.map((cand, ci) => (
                <button
                  key={ci}
                  onClick={() => handlePickBlockCandidate(blockKey, cand)}
                  disabled={blockSetting === blockKey}
                  className="relative rounded-lg overflow-hidden border-2 border-transparent hover:border-amber-500 transition disabled:opacity-50 bg-gray-100 text-left"
                  title={`Источник: ${cand.source} | Уверенность: ${cand.confidence}%`}
                >
                  <img
                    src={cand.thumbnailUrl || cand.originalUrl}
                    alt={`Кандидат ${ci + 1}`}
                    className="w-full h-28 object-cover"
                    loading="lazy"
                    onError={(e) => {
                      const img = e.currentTarget;
                      if (cand.thumbnailUrl && img.src !== cand.originalUrl) {
                        img.src = cand.originalUrl;
                      } else {
                        (img.closest('button') as HTMLElement | null)?.style.setProperty('display', 'none');
                      }
                    }}
                  />
                  <span className={`absolute top-1 left-1 text-xs font-bold px-1.5 py-0.5 rounded ${
                    cand.confidence >= 70 ? 'bg-green-500 text-white' :
                    cand.confidence >= 50 ? 'bg-yellow-500 text-white' :
                    'bg-red-500 text-white'
                  }`}>
                    {cand.confidence}%
                  </span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setBlockCandidates(prev => { const n = { ...prev }; delete n[blockKey]; return n; })}
              className="mt-2 text-xs text-amber-700 underline hover:text-amber-900"
            >
              Скрыть
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="card">
      <div className="flex justify-between items-start mb-6">
        <h2 className="text-2xl font-semibold">✍️ Сгенерированная статья</h2>
        <div className="flex gap-2">
          <button 
            onClick={() => setShowSettings(!showSettings)}
            className="btn btn-secondary flex items-center gap-2"
          >
            <Settings size={18} />
            Настройки поиска
            {showSettings ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          <button
            onClick={() => startEdit('header', { title: toText(content.title), teaser: toText(content.teaser || content.intro) })}
            className="btn btn-secondary flex items-center gap-2"
          >
            <Edit size={18} />
            Заголовок и тизер
          </button>
        </div>
      </div>

      {/* Image Search Settings */}
      {showSettings && (
        <div className="mb-6">
          <ImageSearchSettings config={searchConfig} onChange={setSearchConfig} />
        </div>
      )}

      {/* Title + Teaser (editable) */}
      {editingKey === 'header' ? (
        <div className="mb-8 p-4 bg-gray-50 border border-gray-200 rounded-lg">
          <label className="block text-sm font-medium mb-1">Заголовок статьи</label>
          <input
            type="text"
            value={draft.title || ''}
            onChange={e => setDraft({ ...draft, title: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-lg font-bold mb-3"
          />
          <label className="block text-sm font-medium mb-1">Тизер</label>
          <textarea
            value={draft.teaser || ''}
            onChange={e => setDraft({ ...draft, teaser: e.target.value })}
            rows={4}
            className="w-full border border-gray-300 rounded-lg px-3 py-2"
          />
          <EditActions />
        </div>
      ) : (
        <>
          <div className="mb-8">
            <h1 className="text-4xl font-bold mb-3">{toText(content.title)}</h1>
          </div>
          <div className="prose max-w-none mb-8">
            <p className="text-lg leading-relaxed text-gray-700">
              {toText(content.teaser || content.intro)}
            </p>
          </div>
        </>
      )}

      {/* Sections */}
      <div className="space-y-8 mb-8">
        {content.sections?.map((section, idx) => {
          const matchingFact = getMatchingFact(section);
          const isSearching = searchingImageIds.has(idx);
          const currentProgress = imageProgress?.sectionIndex === idx ? imageProgress : null;
          
          return (
          <div key={section.number || section.id || idx} className="border-l-4 border-primary pl-6">
            <div className="flex items-start justify-between gap-2 mb-4">
              <h3 className="text-2xl font-bold">
                {section.number || section.order}. {toText(section.heading || section.title)}
              </h3>
              <EditButton onClick={() => startEdit(`section-${idx}`, {
                heading: toText(section.heading || section.title),
                hasParagraphs: !!section.paragraph1,
                paragraph1: toText(section.paragraph1),
                paragraph2: toText(section.paragraph2),
                content: toText(section.content),
                blockquote: toText(section.blockquote),
              })} />
            </div>
            
            {/* Section Image */}
            {section.imageUrl ? (
              <div className="my-4 rounded-lg overflow-hidden relative group bg-gray-100">
                <img 
                  src={section.imageUrl.startsWith('/') ? `${API_URL}${section.imageUrl}` : section.imageUrl} 
                  alt={section.visualSuggestion || section.heading || section.title}
                  className="w-full max-h-96 object-contain rounded-lg"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
                {section.visualSuggestion && (
                  <p className="text-xs text-gray-500 mt-2 italic">{section.visualSuggestion}</p>
                )}
                {/* Refresh button overlay */}
                <button
                  onClick={() => handleFindImage(idx)}
                  disabled={isSearching}
                  className="absolute top-2 right-2 bg-white/90 hover:bg-white p-2 rounded-lg shadow opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                  title="Переподобрать изображение"
                >
                  <RefreshCw size={18} className={isSearching ? 'animate-spin' : ''} />
                </button>
              </div>
            ) : (
              <div className="my-4">
                {/* No image - show search button or progress */}
                {currentProgress && isSearching ? (
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-medium">{currentProgress.message}</span>
                      <span className="text-sm font-bold">{currentProgress.progress}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="h-2 rounded-full bg-blue-500 transition-all"
                        style={{ width: `${currentProgress.progress}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => handleFindImage(idx)}
                    disabled={isSearching}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700 transition disabled:opacity-50"
                  >
                    <ImagePlus size={18} />
                    {isSearching ? 'Поиск...' : 'Подобрать изображение'}
                  </button>
                )}
                {/* Show visual suggestion hint if available */}
                {matchingFact?.visualSuggestion && !section.imageUrl && (
                  <p className="text-xs text-gray-400 mt-2 italic">
                    💡 Подсказка: {matchingFact.visualSuggestion}
                  </p>
                )}
              </div>
            )}

            {/* Candidate gallery — manual pick when auto-selection failed or user wants alternatives */}
            {sectionCandidates[idx] && sectionCandidates[idx].length > 0 && (
              <div className="my-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm font-medium text-amber-900 mb-3">
                  🖼️ Кандидаты от поиска (оценка Gemini) — выберите вручную:
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {sectionCandidates[idx].map((cand, ci) => (
                    <button
                      key={ci}
                      onClick={() => handlePickCandidate(idx, cand)}
                      disabled={settingImageIdx === idx}
                      className="relative group/cand rounded-lg overflow-hidden border-2 border-transparent hover:border-amber-500 transition disabled:opacity-50 bg-gray-100 text-left"
                      title={`Источник: ${cand.source} | Уверенность: ${cand.confidence}%`}
                    >
                      <img
                        src={cand.thumbnailUrl || cand.originalUrl}
                        alt={`Кандидат ${ci + 1}`}
                        className="w-full h-28 object-cover"
                        loading="lazy"
                        onError={(e) => {
                          // Thumbnail broken → try original once, then hide
                          const img = e.currentTarget;
                          if (cand.thumbnailUrl && img.src !== cand.originalUrl) {
                            img.src = cand.originalUrl;
                          } else {
                            (img.closest('button') as HTMLElement | null)?.style.setProperty('display', 'none');
                          }
                        }}
                      />
                      <span className={`absolute top-1 left-1 text-xs font-bold px-1.5 py-0.5 rounded ${
                        cand.confidence >= 70 ? 'bg-green-500 text-white' :
                        cand.confidence >= 50 ? 'bg-yellow-500 text-white' :
                        'bg-red-500 text-white'
                      }`}>
                        {cand.confidence}%
                      </span>
                      <span className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate">
                        {cand.source}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="flex justify-between items-center mt-3">
                  <p className="text-xs text-amber-700">
                    {settingImageIdx === idx ? 'Сохраняем выбранное изображение...' : 'Клик по картинке — вставить её в секцию.'}
                  </p>
                  <button
                    onClick={() => setSectionCandidates(prev => { const n = { ...prev }; delete n[idx]; return n; })}
                    className="text-xs text-amber-700 underline hover:text-amber-900"
                  >
                    Скрыть
                  </button>
                </div>
              </div>
            )}
            
            {/* Section text: edit form or rendered content */}
            {editingKey === `section-${idx}` ? (
              <div className="my-4 p-4 bg-gray-50 border border-gray-200 rounded-lg">
                <label className="block text-sm font-medium mb-1">Заголовок пункта</label>
                <input
                  type="text"
                  value={draft.heading || ''}
                  onChange={e => setDraft({ ...draft, heading: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 font-semibold mb-3"
                />
                {draft.hasParagraphs ? (
                  <>
                    <label className="block text-sm font-medium mb-1">Абзац 1</label>
                    <textarea
                      value={draft.paragraph1 || ''}
                      onChange={e => setDraft({ ...draft, paragraph1: e.target.value })}
                      rows={5}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
                    />
                    <label className="block text-sm font-medium mb-1">Абзац 2</label>
                    <textarea
                      value={draft.paragraph2 || ''}
                      onChange={e => setDraft({ ...draft, paragraph2: e.target.value })}
                      rows={4}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
                    />
                  </>
                ) : (
                  <>
                    <label className="block text-sm font-medium mb-1">Текст пункта</label>
                    <textarea
                      value={draft.content || ''}
                      onChange={e => setDraft({ ...draft, content: e.target.value })}
                      rows={6}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
                    />
                  </>
                )}
                <label className="block text-sm font-medium mb-1">Цитата (пусто — без цитаты)</label>
                <textarea
                  value={draft.blockquote || ''}
                  onChange={e => setDraft({ ...draft, blockquote: e.target.value })}
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
                <EditActions />
              </div>
            ) : (
              <>
                {/* New format: paragraph1 + paragraph2 */}
                {section.paragraph1 && (
                  <div className="prose max-w-none mb-3">
                    <p className="whitespace-pre-wrap">{toText(section.paragraph1)}</p>
                  </div>
                )}
                {section.paragraph2 && (
                  <div className="prose max-w-none mb-4">
                    <p className="whitespace-pre-wrap text-gray-700">{toText(section.paragraph2)}</p>
                  </div>
                )}

                {/* Legacy format: content */}
                {!section.paragraph1 && section.content && (
                  <div className="prose max-w-none mb-4">
                    <p className="whitespace-pre-wrap">{toText(section.content)}</p>
                  </div>
                )}

                {/* Blockquote (new format) */}
                {section.blockquote && toText(section.blockquote) && (
                  <div className="my-4 p-4 bg-blue-50 border-l-4 border-blue-500 italic">
                    <p className="text-lg">{toText(section.blockquote)}</p>
                  </div>
                )}
              </>
            )}

            {/* Quote (legacy format) */}
            {section.quote && (
              <div className="my-4 p-4 bg-blue-50 border-l-4 border-blue-500">
                <p className="italic text-lg mb-2">"{toText(section.quote.text)}"</p>
                <p className="text-sm text-gray-600">— {toText(section.quote.source)}</p>
              </div>
            )}

            {/* Meme text */}
            {section.memeText && (
              <div className="my-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-center">
                <p className="font-semibold text-gray-800">{toText(section.memeText)}</p>
              </div>
            )}
          </div>
        )})}
      </div>

      {/* Conclusion (editable, with illustration) */}
      <div className="prose max-w-none mb-8">
        {editingKey === 'conclusion' ? (
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg not-prose">
            <label className="block text-sm font-medium mb-1">Заголовок блока</label>
            <input
              type="text"
              value={draft.heading || ''}
              onChange={e => setDraft({ ...draft, heading: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 font-semibold mb-3"
            />
            <label className="block text-sm font-medium mb-1">Текст итога</label>
            <textarea
              value={draft.text || ''}
              onChange={e => setDraft({ ...draft, text: e.target.value })}
              rows={6}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
            />
            <EditActions />
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-2xl font-bold mb-4">
                {typeof content.conclusion === 'object' ? toText(content.conclusion.heading) || 'Заключение' : 'Заключение'}
              </h3>
              <EditButton onClick={() => startEdit('conclusion', {
                heading: typeof content.conclusion === 'object' ? toText(content.conclusion.heading) : 'Успех',
                text: typeof content.conclusion === 'object' ? toText(content.conclusion.text) : toText(content.conclusion),
              })} />
            </div>
            {renderBlockImage('conclusion', (content as any).conclusionImageUrl)}
            <p className="text-lg leading-relaxed">
              {typeof content.conclusion === 'object' ? toText(content.conclusion.text) : toText(content.conclusion)}
            </p>
          </>
        )}
      </div>

      {/* Hero Quote (editable) */}
      {editingKey === 'heroQuote' ? (
        <div className="my-8 p-4 bg-gray-50 border border-gray-200 rounded-lg">
          <label className="block text-sm font-medium mb-1">Цитата героя (пусто — убрать блок)</label>
          <textarea
            value={draft.text || ''}
            onChange={e => setDraft({ ...draft, text: e.target.value })}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
          />
          <label className="block text-sm font-medium mb-1">Автор</label>
          <input
            type="text"
            value={draft.author || ''}
            onChange={e => setDraft({ ...draft, author: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2"
          />
          <EditActions />
        </div>
      ) : content.heroQuote && (
        <div className="my-8 p-6 bg-gradient-to-r from-yellow-50 to-orange-50 border-l-4 border-yellow-500 rounded-r-lg relative group">
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <EditButton onClick={() => startEdit('heroQuote', {
              text: toText(content.heroQuote?.text),
              author: toText(content.heroQuote?.author),
            })} />
          </div>
          <p className="text-xl italic mb-3">"{toText(content.heroQuote.text)}"</p>
          <p className="text-right font-semibold text-gray-700">— {toText(content.heroQuote.author)}</p>
        </div>
      )}

      {/* Bonus Fact (editable, with illustration) */}
      {editingKey === 'bonusFact' ? (
        <div className="my-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
          <label className="block text-sm font-medium mb-1">Бонусный факт (пусто — убрать блок)</label>
          <textarea
            value={draft.text || ''}
            onChange={e => setDraft({ ...draft, text: e.target.value })}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2"
          />
          <EditActions />
        </div>
      ) : content.bonusFact && (
        <div className="my-6 p-4 bg-purple-50 border border-purple-200 rounded-lg relative group">
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <EditButton onClick={() => startEdit('bonusFact', { text: toText(content.bonusFact) })} />
          </div>
          <h4 className="font-bold text-purple-800 mb-2">🎁 Бонусный факт:</h4>
          {renderBlockImage('bonus', (content as any).bonusFactImageUrl)}
          <p className="text-gray-800">{toText(content.bonusFact)}</p>
        </div>
      )}

      {/* CTA */}
      {content.cta && (
        <div className="my-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-gray-800">{toText(content.cta)}</p>
        </div>
      )}

      {/* Brand Ending / Motivation */}
      <div className="bg-gradient-to-r from-primary/10 to-secondary/10 p-6 rounded-xl">
        <h3 className="text-xl font-bold mb-3">🌟 Вывод</h3>
        <p className="text-lg leading-relaxed">
          {toText(content.brandEnding || content.motivation)}
        </p>
      </div>
    </div>
  );
}
