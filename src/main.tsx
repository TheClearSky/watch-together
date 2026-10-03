import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router';
import { routes } from './routes';
import './index.css';

// Hash routing: GitHub Pages has no SPA fallback, and a room link
// (`…/watch-together/#/room/lunar-otter-4821`) must open the app, not a 404.
// Invite links shared where a #fragment may be dropped (Facebook) use
// `?room=<code>`: turn that into the hash route before the router starts.
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam && !location.hash) {
  history.replaceState(null, '', `${location.pathname}#/room/${encodeURIComponent(roomParam)}`);
}

const router = createHashRouter(routes);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
