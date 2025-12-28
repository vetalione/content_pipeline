import { useState, useEffect } from 'react';
import { ResearchData } from '../types';
import { ExternalLink, Edit2, Trash2, Square, RotateCcw, Search } from 'lucide-react';
import { io, Socket } from 'socket.io-client';

interface Props {
  data: ResearchData;
  articleId: string;
  onUpdate?: () => void;
}

interface ResearchProgress {
  status: 'idle' | 'searching' | 'parsing' | 'completed' | 'failed' | 'stopped';
  currentFact: number;
  totalFacts: number;
  percentage: number;
  message?: string;
  startedAt?: string;
  estimatedTimeRemaining?: number;
}

export default function ResearchView({ data, articleId, onUpdate }: Props) {
  const [facts, setFacts] = useState(data.facts || []);
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<any>(null);
  const [progress, setProgress] = useState<ResearchProgress | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Connect to Socket.IO
  useEffect(() => {
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    const newSocket = io(API_URL, {
      transports: ['websocket', 'polling'],
    });

    newSocket.on('connect', () => {
      console.log('✅ Connected to Socket.IO');
    });

    newSocket.on(`research:progress:${articleId}`, (prog: ResearchProgress) => {
      console.log('📡 Research progress:', prog);
      setProgress(prog);
    });

    newSocket.on(`research:complete:${articleId}`, (researchData: any) => {
      console.log('✅ Research complete');
      setFacts(researchData.facts || []);
      setProgress({
        status: 'completed',
        currentFact: researchData.facts?.length || 0,
        totalFacts: researchData.facts?.length || 0,
        percentage: 100,
        message: 'Исследование завершено!',
      });
      onUpdate?.();
    });

    newSocket.on(`research:error:${articleId}`, ({ error }: { error: string }) => {
      console.error('❌ Research error:', error);
      setProgress({
        status: 'failed',
        currentFact: 0,
        totalFacts: 0,
        percentage: 0,
        message: `Ошибка: ${error}`,
      });
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [articleId]);

  const handleEditClick = (fact: any) => {
    setEditingFactId(fact.id);
    setEditForm({ ...fact });
  };

  const handleDeleteClick = async (factId: string) => {
    if (!confirm('Удалить этот факт?')) return;

    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${API_URL}/api/articles/${articleId}/facts/${factId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setFacts(facts.filter(f => f.id !== factId));
        onUpdate?.();
      }
    } catch (error) {
      console.error('Failed to delete fact:', error);
    }
  };

  const handleSaveEdit = async () => {
    if (!editForm || !editingFactId) return;

    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${API_URL}/api/articles/${articleId}/facts/${editingFactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });

      if (res.ok) {
        const { data: updatedFact } = await res.json();
        setFacts(facts.map(f => f.id === editingFactId ? updatedFact : f));
        setEditingFactId(null);
        setEditForm(null);
        onUpdate?.();
      }
    } catch (error) {
      console.error('Failed to save edit:', error);
    }
  };

  const handleResearchControl = async (action: 'stop' | 'restart' | 'deep_dive') => {
    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      await fetch(`${API_URL}/api/pipeline/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId, action }),
      });
    } catch (error) {
      console.error('Research control error:', error);
    }
  };

  const visibleFacts = facts.filter(f => !f.isDeleted);

  return (
    <div className="card">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-semibold">📚 Результаты исследования</h2>
        
        {/* Research Control Buttons */}
        <div className="flex gap-2">
          {progress?.status === 'searching' || progress?.status === 'parsing' ? (
            <button
              onClick={() => handleResearchControl('stop')}
              className="btn btn-secondary flex items-center gap-2 text-sm"
            >
              <Square size={16} />
              Остановить
            </button>
          ) : (
            <>
              <button
                onClick={() => handleResearchControl('restart')}
                className="btn btn-secondary flex items-center gap-2 text-sm"
              >
                <RotateCcw size={16} />
                Заново
              </button>
              <button
                onClick={() => handleResearchControl('deep_dive')}
                className="btn btn-primary flex items-center gap-2 text-sm"
              >
                <Search size={16} />
                Углубить
              </button>
            </>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      {progress && progress.status !== 'idle' && (
        <div className="mb-6 p-4 bg-blue-50 rounded-lg">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium">
              {progress.status === 'searching' && '🔍 Поиск данных...'}
              {progress.status === 'parsing' && '📋 Обработка...'}
              {progress.status === 'completed' && '✅ Завершено!'}
              {progress.status === 'failed' && '❌ Ошибка'}
              {progress.status === 'stopped' && '⏸️ Остановлено'}
            </span>
            <span className="text-sm font-bold">{progress.percentage}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
            <div
              className={`h-2 rounded-full transition-all duration-300 ${
                progress.status === 'failed' ? 'bg-red-500' :
                progress.status === 'completed' ? 'bg-green-500' :
                'bg-blue-500'
              }`}
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
          {progress.message && (
            <p className="text-xs text-gray-600">{progress.message}</p>
          )}
        </div>
      )}

      {/* Edit Modal */}
      {editingFactId && editForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-semibold mb-4">Редактировать факт</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Заголовок</label>
                <input
                  type="text"
                  className="w-full p-2 border rounded"
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1">Описание</label>
                <textarea
                  className="w-full p-2 border rounded"
                  rows={6}
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1">Год</label>
                <input
                  type="number"
                  className="w-full p-2 border rounded"
                  value={editForm.year || ''}
                  onChange={(e) => setEditForm({ ...editForm, year: parseInt(e.target.value) || undefined })}
                />
              </div>
              
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setEditingFactId(null);
                    setEditForm(null);
                  }}
                  className="btn btn-secondary"
                >
                  Отмена
                </button>
                <button
                  onClick={handleSaveEdit}
                  className="btn btn-primary"
                >
                  Сохранить
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Facts */}
      <div className="mb-8">
        <h3 className="text-lg font-semibold mb-4">Факты из биографии ({visibleFacts.length})</h3>
        <div className="space-y-4">
          {visibleFacts.map((fact: any) => (
            <div key={fact.id} className="p-4 bg-gray-50 rounded-lg relative group">
              {/* Action buttons */}
              <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleEditClick(fact)}
                  className="p-1 bg-white rounded shadow hover:bg-blue-50"
                  title="Редактировать"
                >
                  <Edit2 size={16} className="text-blue-600" />
                </button>
                <button
                  onClick={() => handleDeleteClick(fact.id)}
                  className="p-1 bg-white rounded shadow hover:bg-red-50"
                  title="Удалить"
                >
                  <Trash2 size={16} className="text-red-600" />
                </button>
              </div>

              <div className="flex justify-between items-start mb-2">
                <h4 className="font-semibold break-words pr-20">{fact.title}</h4>
                <span className={`text-xs px-2 py-1 rounded flex-shrink-0 ml-2 ${
                  fact.category === 'failure' ? 'bg-red-100 text-red-700' :
                  fact.category === 'tragedy' ? 'bg-purple-100 text-purple-700' :
                  fact.category === 'struggle' ? 'bg-orange-100 text-orange-700' :
                  'bg-blue-100 text-blue-700'
                }`}>
                  {fact.category}
                </span>
              </div>
              
              {fact.isEdited && (
                <div className="text-xs text-green-600 mb-2">✏️ Отредактировано</div>
              )}
              
              {/* Image for this specific fact */}
              {fact.imageUrl && (
                <div className="my-3">
                  <img 
                    src={fact.imageUrl} 
                    alt={fact.visualSuggestion || fact.title}
                    className="w-full max-h-64 object-cover rounded-md"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                  {fact.visualSuggestion && (
                    <p className="text-xs text-gray-500 mt-1 italic">{fact.visualSuggestion}</p>
                  )}
                </div>
              )}
              
              {/* Visual suggestion hint if no image URL */}
              {!fact.imageUrl && fact.visualSuggestion && (
                <div className="my-3 p-2 bg-amber-50 border-l-2 border-amber-400 rounded">
                  <p className="text-xs text-amber-800">💡 {fact.visualSuggestion}</p>
                </div>
              )}
              
              <p className="text-gray-700 text-sm break-words whitespace-pre-wrap">{fact.description}</p>
              {fact.year && (
                <p className="text-xs text-gray-500 mt-2">Год: {fact.year}</p>
              )}
              
              {/* Sources for this fact */}
              {fact.sources && fact.sources.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <p className="text-xs font-medium text-gray-600 mb-1">Источники:</p>
                  <div className="space-y-1">
                    {fact.sources.map((source: string, idx: number) => (
                      <a
                        key={idx}
                        href={source}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-start gap-1 text-xs text-blue-600 hover:text-blue-800"
                      >
                        <ExternalLink size={12} className="flex-shrink-0 mt-0.5" />
                        <span className="break-all">{source}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Quotes */}
      {data.quotes && data.quotes.length > 0 && (
        <div className="mb-8">
          <h3 className="text-lg font-semibold mb-4">💬 Цитаты ({data.quotes.length})</h3>
          <div className="space-y-3">
            {data.quotes.map((quote) => (
              <div key={quote.id} className="p-4 bg-blue-50 border-l-4 border-blue-500">
                <p className="italic text-gray-800 mb-2 break-words">"{quote.text}"</p>
                <p className="text-xs text-gray-600 break-words">
                  {quote.source} {quote.year && `(${quote.year})`}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sources */}
      {data.sources && data.sources.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">🔗 Все источники</h3>
          <ul className="space-y-2">
            {data.sources.map((source, index) => (
              <li key={index} className="flex items-start gap-2 text-sm text-blue-600 break-all">
                <ExternalLink size={14} className="flex-shrink-0 mt-0.5" />
                <a 
                  href={source} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="break-all hover:text-blue-800"
                >
                  {source}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
