import { ResearchData } from '@content-pipeline/shared';
import { ExternalLink } from 'lucide-react';

interface Props {
  data: ResearchData;
}

export default function ResearchView({ data }: Props) {
  return (
    <div className="card">
      <h2 className="text-2xl font-semibold mb-6">📚 Результаты исследования</h2>
      
      {/* Facts */}
      <div className="mb-8">
        <h3 className="text-lg font-semibold mb-4">Факты из биографии ({data.facts?.length || 0})</h3>
        <div className="space-y-4">
          {data.facts?.map((fact) => (
            <div key={fact.id} className="p-4 bg-gray-50 rounded-lg">
              <div className="flex justify-between items-start mb-2">
                <h4 className="font-semibold">{fact.title}</h4>
                <span className={`text-xs px-2 py-1 rounded ${
                  fact.category === 'failure' ? 'bg-red-100 text-red-700' :
                  fact.category === 'tragedy' ? 'bg-purple-100 text-purple-700' :
                  fact.category === 'struggle' ? 'bg-orange-100 text-orange-700' :
                  'bg-blue-100 text-blue-700'
                }`}>
                  {fact.category}
                </span>
              </div>
              <p className="text-gray-700 text-sm">{fact.description}</p>
              {fact.year && (
                <p className="text-xs text-gray-500 mt-2">Год: {fact.year}</p>
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
                <p className="italic text-gray-800 mb-2">"{quote.text}"</p>
                <p className="text-xs text-gray-600">
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
          <h3 className="text-lg font-semibold mb-3">🔗 Источники</h3>
          <ul className="space-y-2">
            {data.sources.map((source, index) => (
              <li key={index} className="flex items-center gap-2 text-sm text-blue-600">
                <ExternalLink size={14} />
                <span>{source}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
