import type { RouteObject } from 'react-router';
import { App } from './App';

const routes: RouteObject[] = [
  { path: '/', element: <App /> },
  // A shared room link pre-fills the Join dialog with the code.
  { path: '/room/:code', element: <App /> },
];

export { routes };
