import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { Live } from './Live';

createRoot(document.getElementById('root')!).render(<StrictMode><Live /></StrictMode>);
