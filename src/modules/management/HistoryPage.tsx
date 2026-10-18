import { useEffect, useState } from 'react';
import { Alert, EmptyState, LoadingState, PageHeader, Panel } from '../../components/ui';
import { getSupabaseClient } from '../../data/supabase/client';
import { useAuth } from '../auth/AuthProvider';

type ConnectionRow = {
  id: number;
  email: string | null;
  full_name: string | null;
  role: string | null;
  methode: string | null;
  created_at: string;
};

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; rows: ConnectionRow[] };

export function HistoryPage() {
  const { profile, activeCentreId } = useAuth();
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    let active = true;

    async function loadHistory() {
      const centreId = profile?.role === 'super_admin' ? activeCentreId : profile?.centreId;
      if (!centreId) {
        setState({
          status: 'error',
          message: 'Sélectionnez un centre actif avant de consulter son historique.',
        });
        return;
      }

      setState({ status: 'loading' });
      try {
        const { data, error } = await getSupabaseClient()
          .from('connexions')
          .select('id,email,full_name,role,methode,created_at')
          .eq('centre_id', centreId)
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) throw error;
        if (active) setState({ status: 'loaded', rows: (data ?? []) as ConnectionRow[] });
      } catch (cause) {
        if (active) {
          setState({
            status: 'error',
            message: cause instanceof Error ? cause.message : 'Impossible de charger l’historique.',
          });
        }
      }
    }

    void loadHistory();
    return () => {
      active = false;
    };
  }, [profile?.centreId, profile?.role, activeCentreId]);

  return (
    <section className="mx-auto w-full max-w-screen-2xl space-y-5">
      <PageHeader
        description="Journal des connexions à la plateforme, limité au centre actif."
        eyebrow="Administration"
        title="Historique"
      />
      {state.status === 'loading' && (
        <Panel>
          <LoadingState label="Chargement de l’historique…" />
        </Panel>
      )}
      {state.status === 'error' && (
        <Panel className="space-y-3">
          <Alert tone="error">{state.message}</Alert>
          <p className="sp-muted">
            Les résultats restent masqués si le centre actif ne peut pas être déterminé.
          </p>
        </Panel>
      )}
      {state.status === 'loaded' && (
        <Panel className="space-y-3">
          {state.rows.length === 0 ? (
            <EmptyState
              title="Aucune connexion enregistrée"
              description="Aucune connexion n’a été trouvée pour ce centre."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">Date</th>
                    <th className="p-2">Utilisateur</th>
                    <th className="p-2">E-mail</th>
                    <th className="p-2">Rôle</th>
                    <th className="p-2">Méthode</th>
                  </tr>
                </thead>
                <tbody>
                  {state.rows.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="p-2">{new Date(row.created_at).toLocaleString('fr-FR')}</td>
                      <td className="p-2">{row.full_name || '—'}</td>
                      <td className="p-2">{row.email || '—'}</td>
                      <td className="p-2">{row.role || '—'}</td>
                      <td className="p-2">{row.methode || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="sp-muted">Les 200 connexions les plus récentes du centre sont affichées.</p>
        </Panel>
      )}
    </section>
  );
}
