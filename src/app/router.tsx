import { createBrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthenticatedRoutes, SectionPlaceholder } from '../modules/auth/AuthRoutes';
import { DashboardPage } from '../modules/dashboard/DashboardPage';
import { LandingPage } from '../modules/public/LandingPage';

export const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <LandingPage />,
    },
    {
      path: '/login',
      element: <App />,
    },
    {
      path: '/app',
      element: <AuthenticatedRoutes />,
      children: [
        {
          index: true,
          element: <DashboardPage />,
        },
        {
          path: ':section',
          element: <SectionPlaceholder />,
        },
      ],
    },
    {
      path: '*',
      element: (
        <main className="grid min-h-screen content-center gap-3 bg-canvas px-6 py-10">
          <p className="m-0 text-xs font-bold tracking-[.12em] text-accent-600 uppercase">
            SchoolPlans
          </p>
          <h1 className="m-0 text-3xl font-bold text-brand-900">Page introuvable</h1>
          <a
            className="w-fit font-semibold text-brand-900 underline-offset-4 hover:underline"
            href="/react-app.html"
          >
            Retourner à l'accueil
          </a>
        </main>
      ),
    },
  ],
  { basename: '/react-app.html' },
);
