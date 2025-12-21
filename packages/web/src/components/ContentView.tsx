import { ArticleContent } from '@content-pipeline/shared';
import { Edit } from 'lucide-react';

interface Props {
  content: ArticleContent;
}

export default function ContentView({ content }: Props) {
  return (
    <div className="card">
      <div className="flex justify-between items-start mb-6">
        <h2 className="text-2xl font-semibold">✍️ Сгенерированная статья</h2>
        <button className="btn btn-secondary flex items-center gap-2">
          <Edit size={18} />
          Редактировать
        </button>
      </div>

      {/* Title */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-3">{content.title}</h1>
        {content.subtitle && (
          <p className="text-xl text-gray-600">{content.subtitle}</p>
        )}
      </div>

      {/* Intro */}
      <div className="prose max-w-none mb-8">
        <p className="text-lg leading-relaxed">{content.intro}</p>
      </div>

      {/* Sections */}
      <div className="space-y-8 mb-8">
        {content.sections?.map((section) => (
          <div key={section.id} className="border-l-4 border-primary pl-6">
            <h3 className="text-2xl font-bold mb-4">
              {section.order}. {section.title}
            </h3>
            <div className="prose max-w-none mb-4">
              <p className="whitespace-pre-wrap">{section.content}</p>
            </div>
            
            {/* Quote */}
            {section.quote && (
              <div className="my-4 p-4 bg-blue-50 border-l-4 border-blue-500">
                <p className="italic text-lg mb-2">"{section.quote.text}"</p>
                <p className="text-sm text-gray-600">— {section.quote.source}</p>
              </div>
            )}

            {/* Meme text */}
            {section.memeText && (
              <div className="my-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-center">
                <p className="font-semibold text-gray-800">{section.memeText}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Conclusion */}
      <div className="prose max-w-none mb-8">
        <h3 className="text-2xl font-bold mb-4">Заключение</h3>
        <p className="text-lg leading-relaxed">{content.conclusion}</p>
      </div>

      {/* Motivation */}
      <div className="bg-gradient-to-r from-primary/10 to-secondary/10 p-6 rounded-xl">
        <h3 className="text-xl font-bold mb-3">🌟 Вывод</h3>
        <p className="text-lg leading-relaxed">{content.motivation}</p>
      </div>
    </div>
  );
}
