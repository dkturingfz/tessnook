import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { configFromEnv, createRepo } from './data';
import { configureBackend } from './store/store';
import { CrashScreen, ErrorBoundary } from './components/ErrorBoundary';

const root = createRoot(document.getElementById('root')!);

// 组合根：唯一决定使用哪个后端实现的地方
createRepo(configFromEnv())
  .then((repo) => {
    configureBackend(repo);
    root.render(
      <StrictMode>
        <ErrorBoundary fallback={(error) => <CrashScreen error={error} />}>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  })
  .catch((error: Error) => root.render(<CrashScreen error={error} />));
