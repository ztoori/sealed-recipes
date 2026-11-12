import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../styles.css';
import { Live } from './Live';

createRoot(document.getElementById('root')!).render(<StrictMode><Live /></StrictMode>);
