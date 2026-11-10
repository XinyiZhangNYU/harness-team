import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { TitleBar } from './components/TitleBar.tsx';
import { PrefsProvider } from './i18n.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <TitleBar />
      <App />
    </PrefsProvider>
  </StrictMode>,
);
