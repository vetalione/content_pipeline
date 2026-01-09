import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ArticleDetail from './pages/ArticleDetail';
import NewArticle from './pages/NewArticle';
import Settings from './pages/Settings';
import Analytics from './pages/Analytics';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/articles/new" element={<NewArticle />} />
        <Route path="/articles/:id" element={<ArticleDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/analytics" element={<Analytics />} />
      </Routes>
    </Layout>
  );
}

export default App;
