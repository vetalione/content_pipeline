import { ArticleContent } from '../types';
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
      </div>

      {/* Teaser / Intro */}
      <div className="prose max-w-none mb-8">
        <p className="text-lg leading-relaxed text-gray-700">
          {content.teaser || content.intro}
        </p>
      </div>

      {/* Sections */}
      <div className="space-y-8 mb-8">
        {content.sections?.map((section, idx) => (
          <div key={section.number || section.id || idx} className="border-l-4 border-primary pl-6">
            <h3 className="text-2xl font-bold mb-4">
              {section.number || section.order}. {section.heading || section.title}
            </h3>
            
            {/* New format: paragraph1 + paragraph2 */}
            {section.paragraph1 && (
              <div className="prose max-w-none mb-3">
                <p className="whitespace-pre-wrap">{section.paragraph1}</p>
              </div>
            )}
            {section.paragraph2 && (
              <div className="prose max-w-none mb-4">
                <p className="whitespace-pre-wrap text-gray-700">{section.paragraph2}</p>
              </div>
            )}
            
            {/* Legacy format: content */}
            {!section.paragraph1 && section.content && (
              <div className="prose max-w-none mb-4">
                <p className="whitespace-pre-wrap">{section.content}</p>
              </div>
            )}
            
            {/* Blockquote (new format) */}
            {section.blockquote && (
              <div className="my-4 p-4 bg-blue-50 border-l-4 border-blue-500 italic">
                <p className="text-lg">{section.blockquote}</p>
              </div>
            )}

            {/* Quote (legacy format) */}
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
        <h3 className="text-2xl font-bold mb-4">
          {typeof content.conclusion === 'object' ? content.conclusion.heading : 'Заключение'}
        </h3>
        <p className="text-lg leading-relaxed">
          {typeof content.conclusion === 'object' ? content.conclusion.text : content.conclusion}
        </p>
      </div>

      {/* Hero Quote */}
      {content.heroQuote && (
        <div className="my-8 p-6 bg-gradient-to-r from-yellow-50 to-orange-50 border-l-4 border-yellow-500 rounded-r-lg">
          <p className="text-xl italic mb-3">"{content.heroQuote.text}"</p>
          <p className="text-right font-semibold text-gray-700">— {content.heroQuote.author}</p>
        </div>
      )}

      {/* Bonus Fact */}
      {content.bonusFact && (
        <div className="my-6 p-4 bg-purple-50 border border-purple-200 rounded-lg">
          <h4 className="font-bold text-purple-800 mb-2">🎁 Бонусный факт:</h4>
          <p className="text-gray-800">{content.bonusFact}</p>
        </div>
      )}

      {/* CTA */}
      {content.cta && (
        <div className="my-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-gray-800">{content.cta}</p>
        </div>
      )}

      {/* Brand Ending / Motivation */}
      <div className="bg-gradient-to-r from-primary/10 to-secondary/10 p-6 rounded-xl">
        <h3 className="text-xl font-bold mb-3">🌟 Вывод</h3>
        <p className="text-lg leading-relaxed">
          {content.brandEnding || content.motivation}
        </p>
      </div>
    </div>
  );
}
