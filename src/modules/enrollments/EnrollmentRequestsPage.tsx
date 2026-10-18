import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, EmptyState, LoadingState, PageHeader, Panel, notify } from '../../components/ui';
import {
  approveEnrollmentRequest,
  getEnrollmentRequests,
  rejectEnrollmentRequest,
} from '../../data/repositories/enrollmentRequestRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import type { EnrollmentRequest, EnrollmentRequestFilter } from '../../types/enrollmentRequests';
import { useAuth } from '../auth/AuthProvider';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; requests: EnrollmentRequest[] };

const FILTER_OPTIONS: Array<{ value: EnrollmentRequestFilter; label: string }> = [
  { value: 'en_attente', label: 'En attente' },
  { value: 'approuvee', label: 'Approuvées' },
  { value: 'refusee', label: 'Refusées' },
  { value: 'all', label: 'Toutes' },
];

function isEnrollmentRequestFilter(value: string): value is EnrollmentRequestFilter {
  return FILTER_OPTIONS.some((option) => option.value === value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur inattendue est survenue.';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('fr-FR') : value;
}

function statusLabel(status: EnrollmentRequest['status']): string {
  if (status === 'approuvee') return 'Approuvée';
  if (status === 'refusee') return 'Refusée';
  return 'En attente';
}

export function EnrollmentRequestsPage() {
  const { profile } = useAuth();
  const [filter, setFilter] = useState<EnrollmentRequestFilter>('en_attente');
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [message, setMessageState] = useState<string | null>(null);
  const setMessage = (value: string | null) => {
    setMessageState(value);
    if (value) notify(value, 'success');
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const [requestToReject, setRequestToReject] = useState<EnrollmentRequest | null>(null);
  const [refusalReason, setRefusalReason] = useState('');

  const authorized = profile?.role === 'admin' || profile?.role === 'director';

  useEffect(() => {
    let active = true;

    async function loadRequests() {
      setState({ status: 'loading' });
      if (!authorized) {
        setState({ status: 'error', message: 'Cette rubrique est réservée à l’administration.' });
        return;
      }
      try {
        const requests = await getEnrollmentRequests(
          getSupabaseClient(),
          profile?.centreId ?? '',
          filter,
        );
        if (active) setState({ status: 'loaded', requests });
      } catch (error) {
        if (active) setState({ status: 'error', message: errorMessage(error) });
      }
    }

    void loadRequests();
    return () => {
      active = false;
    };
  }, [authorized, filter, profile?.centreId, reloadKey]);

  async function performDecision(
    request: EnrollmentRequest,
    decision: 'approve' | 'reject',
    reason?: string,
  ) {
    setProcessingId(String(request.id));
    setMessage(null);
    setActionError(null);
    try {
      const client = getSupabaseClient();
      if (decision === 'approve') {
        await approveEnrollmentRequest(client, request.id);
        setMessage(`La demande de ${request.firstName} ${request.lastName} a été approuvée.`);
      } else {
        await rejectEnrollmentRequest(client, request.id, reason ?? null);
        setMessage(`La demande de ${request.firstName} ${request.lastName} a été refusée.`);
        setRequestToReject(null);
        setRefusalReason('');
      }
      setReloadKey((key) => key + 1);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setProcessingId(null);
    }
  }

  function submitRefusal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requestToReject) return;
    void performDecision(requestToReject, 'reject', refusalReason);
  }

  return (
    <section aria-label="Inscriptions" className="mx-auto w-full max-w-screen-2xl space-y-5">
      <PageHeader
        description="Consultez les demandes d’accès au centre et traitez les demandes en attente."
        eyebrow="Gestion du centre"
        title="Inscriptions"
      />

      {message && <Alert tone="success">{message}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}

      <Panel className="enrollment-request-toolbar">
        <label className="sp-form-field" htmlFor="enrollment-request-filter">
          Afficher
          <select
            className="sp-field"
            id="enrollment-request-filter"
            onChange={(event) => {
              if (isEnrollmentRequestFilter(event.target.value)) setFilter(event.target.value);
            }}
            value={filter}
          >
            {FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <span className="enrollment-request-limit">
          200 demandes au maximum, des plus récentes.
        </span>
      </Panel>

      {state.status === 'loading' && (
        <Panel>
          <LoadingState label="Chargement des demandes d’inscription…" />
        </Panel>
      )}

      {state.status === 'error' && (
        <Alert className="space-y-2" tone="error">
          <p>Les demandes d’inscription n’ont pas pu être chargées.</p>
          <p>{state.message}</p>
          <Button onClick={() => setReloadKey((key) => key + 1)} type="button" variant="secondary">
            Réessayer
          </Button>
        </Alert>
      )}

      {state.status === 'loaded' &&
        (state.requests.length === 0 ? (
          <EmptyState
            description="Aucune demande ne correspond au filtre sélectionné."
            title="Aucune demande d’inscription."
          />
        ) : (
          <Panel className="!p-0">
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Étudiant</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Adresse</th>
                    <th scope="col">Niveau</th>
                    <th scope="col">Statut / action</th>
                  </tr>
                </thead>
                <tbody>
                  {state.requests.map((request) => {
                    const pending = request.status === 'en_attente';
                    const processing = processingId === String(request.id);
                    return (
                      <tr key={String(request.id)}>
                        <td data-label="Date">{formatDate(request.createdAt)}</td>
                        <td data-label="Étudiant">
                          <strong>
                            {request.firstName} {request.lastName}
                          </strong>
                        </td>
                        <td data-label="Contact">
                          <a href={`mailto:${request.email}`}>{request.email}</a>
                          {request.telephone && (
                            <small className="enrollment-request-secondary">
                              <a href={`tel:${request.telephone}`}>{request.telephone}</a>
                            </small>
                          )}
                        </td>
                        <td data-label="Adresse">
                          {request.address || '—'}
                          <small className="enrollment-request-secondary">{request.city}</small>
                        </td>
                        <td data-label="Niveau">{request.educationLevel}</td>
                        <td data-label="Statut / action">
                          {pending ? (
                            <div className="enrollment-request-actions">
                              <Button
                                disabled={processingId !== null}
                                onClick={() => void performDecision(request, 'approve')}
                                type="button"
                              >
                                {processing ? 'Traitement…' : 'Approuver'}
                              </Button>
                              <Button
                                disabled={processingId !== null}
                                onClick={() => {
                                  setRequestToReject(request);
                                  setRefusalReason('');
                                  setActionError(null);
                                }}
                                type="button"
                                variant="secondary"
                              >
                                Refuser
                              </Button>
                            </div>
                          ) : (
                            <span className={`enrollment-request-status is-${request.status}`}>
                              {statusLabel(request.status)}
                              {request.status === 'refusee' && request.refusalReason && (
                                <small>{request.refusalReason}</small>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}

      {requestToReject && (
        <div
          className="planning-dialog-backdrop"
          onMouseDown={() => processingId === null && setRequestToReject(null)}
        >
          <section
            aria-labelledby="enrollment-reject-title"
            aria-modal="true"
            className="planning-dialog enrollment-reject-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="planning-dialog-heading">
              <h2 id="enrollment-reject-title">Refuser la demande</h2>
              <button
                aria-label="Fermer"
                className="planning-dialog-close"
                disabled={processingId !== null}
                onClick={() => setRequestToReject(null)}
                type="button"
              >
                ×
              </button>
            </header>
            <p>
              Demande de {requestToReject.firstName} {requestToReject.lastName}
            </p>
            <form className="enrollment-reject-form" onSubmit={submitRefusal}>
              <label className="sp-form-field" htmlFor="enrollment-refusal-reason">
                Motif du refus (facultatif)
                <textarea
                  className="sp-field"
                  id="enrollment-refusal-reason"
                  maxLength={500}
                  onChange={(event) => setRefusalReason(event.target.value)}
                  rows={4}
                  value={refusalReason}
                />
              </label>
              {actionError && <Alert tone="error">{actionError}</Alert>}
              <div className="planning-editor-actions">
                <Button
                  disabled={processingId !== null}
                  onClick={() => setRequestToReject(null)}
                  type="button"
                  variant="secondary"
                >
                  Annuler
                </Button>
                <Button disabled={processingId !== null} type="submit" variant="danger">
                  {processingId !== null ? 'Traitement…' : 'Confirmer le refus'}
                </Button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
