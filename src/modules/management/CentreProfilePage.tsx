import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, EmptyState, LoadingState, PageHeader, Panel, notify } from '../../components/ui';
import {
  getCentreProfile,
  saveCentreProfile,
  uploadCentreLogo,
  type CentreProfile,
} from '../../data/repositories/centreProfileRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import { useAuth } from '../auth/AuthProvider';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; centre: CentreProfile };

export function CentreProfilePage() {
  const { profile } = useAuth();
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [message, setMessageState] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const setMessage = (value: { tone: 'success' | 'error'; text: string } | null) => {
    setMessageState(value);
    if (value) notify(value.text, value.tone === 'error' ? 'error' : 'success');
  };
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview(null);
      return;
    }
    const preview = URL.createObjectURL(logoFile);
    setLogoPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [logoFile]);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!profile?.centreId || !['admin', 'director'].includes(profile.role)) {
        setState({
          status: 'error',
          message: 'Cette rubrique est réservée aux responsables rattachés à un centre.',
        });
        return;
      }
      setState({ status: 'loading' });
      try {
        const centre = await getCentreProfile(getSupabaseClient(), profile.centreId);
        if (active) setState({ status: 'loaded', centre });
      } catch (cause) {
        if (active) {
          setState({
            status: 'error',
            message: cause instanceof Error ? cause.message : 'Impossible de charger le centre.',
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [profile?.centreId, revision]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile?.centreId || state.status !== 'loaded') return;
    setSaving(true);
    setMessage(null);
    try {
      const client = getSupabaseClient();
      const logoUrl = logoFile
        ? await uploadCentreLogo(client, profile.centreId, logoFile)
        : undefined;
      const centre = await saveCentreProfile(
        client,
        profile.centreId,
        {
          name: state.centre.name,
          telephone: state.centre.telephone ?? '',
          email: state.centre.email ?? '',
          city: state.centre.city ?? '',
          address: state.centre.address ?? '',
        },
        logoUrl,
      );
      setState({ status: 'loaded', centre });
      setLogoFile(null);
      setMessage({ tone: 'success', text: 'Profil du centre enregistré avec succès.' });
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Impossible d’enregistrer le profil.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto w-full max-w-screen-2xl space-y-5">
      <PageHeader
        description="Mettez à jour les coordonnées et le logo affichés pour votre centre."
        eyebrow="Gestion du centre"
        title="Profil du centre"
      />
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {state.status === 'loading' && (
        <Panel>
          <LoadingState label="Chargement du profil du centre…" />
        </Panel>
      )}
      {state.status === 'error' && (
        <Panel className="space-y-3">
          <EmptyState
            title="Le profil du centre n’a pas pu être chargé."
            description={state.message}
          />
          <Button
            onClick={() => setRevision((value) => value + 1)}
            type="button"
            variant="secondary"
          >
            Réessayer
          </Button>
        </Panel>
      )}
      {state.status === 'loaded' && (
        <Panel className="management-profile-panel">
          <form className="management-editor-form" onSubmit={(event) => void save(event)}>
            <label className="sp-form-field">
              Nom du centre
              <input
                className="sp-field"
                maxLength={150}
                onChange={(event) =>
                  setState({
                    status: 'loaded',
                    centre: { ...state.centre, name: event.target.value },
                  })
                }
                required
                value={state.centre.name}
              />
            </label>
            <label className="sp-form-field">
              Téléphone
              <input
                className="sp-field"
                onChange={(event) =>
                  setState({
                    status: 'loaded',
                    centre: { ...state.centre, telephone: event.target.value },
                  })
                }
                type="tel"
                value={state.centre.telephone ?? ''}
              />
            </label>
            <label className="sp-form-field">
              E-mail
              <input
                className="sp-field"
                onChange={(event) =>
                  setState({
                    status: 'loaded',
                    centre: { ...state.centre, email: event.target.value },
                  })
                }
                type="email"
                value={state.centre.email ?? ''}
              />
            </label>
            <label className="sp-form-field">
              Ville
              <input
                className="sp-field"
                onChange={(event) =>
                  setState({
                    status: 'loaded',
                    centre: { ...state.centre, city: event.target.value },
                  })
                }
                value={state.centre.city ?? ''}
              />
            </label>
            <label className="sp-form-field management-editor-wide">
              Adresse
              <textarea
                className="sp-field management-textarea"
                onChange={(event) =>
                  setState({
                    status: 'loaded',
                    centre: { ...state.centre, address: event.target.value },
                  })
                }
                rows={3}
                value={state.centre.address ?? ''}
              />
            </label>
            <label className="sp-form-field management-editor-wide">
              Logo du centre
              <input
                accept="image/*"
                className="sp-field"
                onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            {(logoFile || state.centre.logoUrl) && (
              <div className="management-profile-logo management-editor-wide">
                <img
                  alt={`Logo de ${state.centre.name}`}
                  src={logoPreview ?? state.centre.logoUrl ?? ''}
                />
              </div>
            )}
            <div className="management-editor-actions management-editor-wide">
              <Button disabled={saving} type="submit">
                {saving ? 'Enregistrement…' : 'Enregistrer le profil'}
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </section>
  );
}
