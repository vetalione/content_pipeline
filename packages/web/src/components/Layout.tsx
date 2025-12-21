import React from 'react';
import { Link } from 'react-router-dom';
import { FileText, Settings, BarChart3 } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 p-6">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-primary">Content Pipeline</h1>
          <p className="text-sm text-gray-500">Контент-конвейер</p>
        </div>
        
        <nav className="space-y-2">
          <Link 
            to="/" 
            className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <FileText size={20} />
            <span>Статьи</span>
          </Link>
          
          <Link 
            to="/analytics" 
            className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <BarChart3 size={20} />
            <span>Аналитика</span>
          </Link>
          
          <Link 
            to="/settings" 
            className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Settings size={20} />
            <span>Настройки</span>
          </Link>
        </nav>
      </aside>
      
      {/* Main content */}
      <main className="flex-1 p-8">
        {children}
      </main>
    </div>
  );
}
