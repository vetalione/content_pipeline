import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ArticleDetail from './pages/ArticleDetail';
import NewArticle from './pages/NewArticle';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/articles/new" element={<NewArticle />} />
        <Route path="/articles/:id" element={<ArticleDetail />} />
      </Routes>
    </Layout>
  );
}

export default App;
