import { PipelineStage } from '@content-pipeline/shared';
import { Check, Loader } from 'lucide-react';

interface Props {
  currentStage: PipelineStage;
}

const stages = [
  { key: PipelineStage.INPUT, label: 'Ввод' },
  { key: PipelineStage.RESEARCH, label: 'Исследование' },
  { key: PipelineStage.GENERATION, label: 'Генерация' },
  { key: PipelineStage.COVER, label: 'Обложка' },
  { key: PipelineStage.REVIEW, label: 'Проверка' },
  { key: PipelineStage.PUBLISHING, label: 'Публикация' },
  { key: PipelineStage.COMPLETED, label: 'Завершено' },
];

export default function PipelineProgress({ currentStage }: Props) {
  const currentIndex = stages.findIndex(s => s.key === currentStage);

  return (
    <div className="card">
      <h2 className="text-xl font-semibold mb-6">Прогресс конвейера</h2>
      
      <div className="flex items-center justify-between">
        {stages.map((stage, index) => {
          const isActive = index === currentIndex;
          const isCompleted = index < currentIndex;
          
          return (
            <div key={stage.key} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center mb-2 ${
                    isActive
                      ? 'bg-primary text-white'
                      : isCompleted
                      ? 'bg-green-500 text-white'
                      : 'bg-gray-200 text-gray-400'
                  }`}
                >
                  {isCompleted ? (
                    <Check size={24} />
                  ) : isActive ? (
                    <Loader size={24} className="animate-spin" />
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <span
                  className={`text-sm font-medium ${
                    isActive || isCompleted ? 'text-gray-900' : 'text-gray-400'
                  }`}
                >
                  {stage.label}
                </span>
              </div>
              
              {index < stages.length - 1 && (
                <div
                  className={`h-1 w-16 mx-2 ${
                    isCompleted ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
