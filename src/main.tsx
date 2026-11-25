import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { configFromEnv, createRepo } from './data';
import { configureBackend } from './store/store';

// 组合根：唯一决定使用哪个后端实现的地方
createRepo(configFromEnv()).then((repo) => {
  configureBackend(repo);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
