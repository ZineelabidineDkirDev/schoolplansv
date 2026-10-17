import { useEffect, useState, type FormEvent } from 'react';
import type { Certificate } from '../../data/repositories/certificateRepository';
import {
  createCentreCertificate,
  getCentreCertificates,
} from '../../data/repositories/certificateRepository';
import { getCentreStudents } from '../../data/repositories/managementRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import type { ManagedStudent } from '../../types/management';
import { Alert, Button, EmptyState, LoadingState, PageHeader, Panel, notify } from '../../components/ui';
import { useAuth } from '../auth/AuthProvider';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; students: ManagedStudent[]; certificates: Certificate[] };

function studentName(student: ManagedStudent | undefined) {
  return student ? `${student.firstName} ${student.lastName}`.trim() : 'Étudiant';
}

function certificateNumber(certificate: Certificate) {
  return `ISLI-${new Date(certificate.createdAt).getFullYear()}-${String(certificate.id).padStart(4, '0')}`;
}

function formatDate(value: string | null) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR') : '';
}

async function downloadCertificate(certificate: Certificate, name: string) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const width = 297;
  const center = width / 2;
  const navy: [number, number, number] = [15, 45, 92];
  const gold: [number, number, number] = [184, 137, 43];
  const number = certificateNumber(certificate);
  pdf.setDrawColor(...navy);
  pdf.setLineWidth(1.4);
  pdf.rect(8, 8, width - 16, 194);
  pdf.setDrawColor(...gold);
  pdf.setLineWidth(0.5);
  pdf.rect(11, 11, width - 22, 188);
  pdf.setFillColor(...navy);
  pdf.roundedRect(center - 7, 20, 14, 14, 3, 3, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.text('I', center, 30.2, { align: 'center' });
  pdf.setTextColor(...navy);
  pdf.setFontSize(11);
  pdf.text('ISLI FORMATION', center, 42, { align: 'center' });
  pdf.setFont('times', 'bold');
  pdf.setFontSize(36);
  pdf.text('CERTIFICAT DE RÉUSSITE', center, 62, { align: 'center' });
  pdf.setDrawColor(...gold);
  pdf.setLineWidth(0.8);
  pdf.line(center - 30, 67, center + 30, 67);
  pdf.setFont('times', 'italic');
  pdf.setFontSize(14);
  pdf.setTextColor(90, 90, 90);
  pdf.text('Il est certifié que', center, 80, { align: 'center' });
  pdf.setFont('times', 'bold');
  pdf.setFontSize(30);
  pdf.setTextColor(...navy);
  pdf.text(name, center, 97, { align: 'center', maxWidth: 220 });
  pdf.setLineWidth(0.3);
  pdf.line(center - 70, 101, center + 70, 101);
  pdf.setFont('times', 'normal');
  pdf.setFontSize(14);
  pdf.setTextColor(60, 60, 60);
  pdf.text('a suivi avec succès la formation', center, 113, { align: 'center' });
  pdf.setFont('times', 'bold');
  pdf.setFontSize(24);
  pdf.setTextColor(...navy);
  const moduleLines = pdf.splitTextToSize(certificate.module, 220);
  pdf.text(moduleLines, center, 127, { align: 'center' });
  let detailY = 127 + moduleLines.length * 9 + 2;
  pdf.setFont('times', 'normal');
  pdf.setFontSize(13);
  pdf.setTextColor(60, 60, 60);
  const details = [
    certificate.hours ? `Durée : ${certificate.hours} heures` : '',
    certificate.startsOn && certificate.endsOn
      ? `Du ${formatDate(certificate.startsOn)} au ${formatDate(certificate.endsOn)}`
      : '',
  ]
    .filter(Boolean)
    .join('   -   ');
  if (details) {
    pdf.text(details, center, detailY, { align: 'center' });
    detailY += 8;
  }
  if (certificate.mention) {
    pdf.setFont('times', 'bolditalic');
    pdf.text(certificate.mention, center, detailY, { align: 'center' });
  }
  pdf.setFont('times', 'normal');
  pdf.setFontSize(11);
  pdf.setTextColor(60, 60, 60);
  pdf.text(`Délivré le ${new Date(certificate.createdAt).toLocaleDateString('fr-FR')}`, 45, 172);
  pdf.setDrawColor(120, 120, 120);
  pdf.setLineWidth(0.3);
  pdf.line(width - 100, 170, width - 40, 170);
  pdf.text('La Direction', width - 70, 177, { align: 'center' });
  pdf.setDrawColor(...gold);
  pdf.setLineWidth(0.8);
  pdf.circle(center, 172, 12);
  pdf.circle(center, 172, 9.5);
  pdf.setFont('times', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(...gold);
  pdf.text('ISLI', center, 171, { align: 'center' });
  pdf.setFontSize(6.5);
  pdf.text('FORMATION', center, 175, { align: 'center' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(130, 130, 130);
  pdf.text(`N° ${number}`, center, 192, { align: 'center' });
  const safeName = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  pdf.save(`Certificat-${number}-${safeName}.pdf`);
}

export function CertificatesPage() {
  const { profile } = useAuth();
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessageState] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const setMessage = (value: { tone: 'success' | 'error'; text: string } | null) => {
    setMessageState(value);
    if (value) notify(value.text, value.tone === 'error' ? 'error' : 'success');
  };
  const [studentId, setStudentId] = useState('');
  const [module, setModule] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [hours, setHours] = useState('');
  const [mention, setMention] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      if (!profile?.centreId || !['admin', 'director'].includes(profile.role)) {
        setState({
          status: 'error',
          message: 'Cette rubrique est réservée aux responsables du centre.',
        });
        return;
      }
      setState({ status: 'loading' });
      try {
        const client = getSupabaseClient();
        const [students, certificates] = await Promise.all([
          getCentreStudents(client, profile.centreId),
          getCentreCertificates(client, profile.centreId),
        ]);
        if (active) {
          setState({ status: 'loaded', students, certificates });
          setStudentId((current) => current || String(students[0]?.id ?? ''));
        }
      } catch (cause) {
        if (active) {
          setState({
            status: 'error',
            message:
              cause instanceof Error ? cause.message : 'Impossible de charger les certificats.',
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [profile?.centreId, profile?.role, reload]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status !== 'loaded' || !profile?.centreId) return;
    setBusy(true);
    setMessage(null);
    try {
      const certificate = await createCentreCertificate(getSupabaseClient(), profile.centreId, {
        studentId,
        module,
        startsOn: startsOn || null,
        endsOn: endsOn || null,
        hours: hours ? Number(hours) : null,
        mention: mention || null,
      });
      const student = state.students.find((item) => String(item.id) === studentId);
      setState({ ...state, certificates: [certificate, ...state.certificates].slice(0, 200) });
      try {
        await downloadCertificate(certificate, studentName(student));
        setMessage({
          tone: 'success',
          text: `Certificat ${certificateNumber(certificate)} généré et téléchargé.`,
        });
      } catch (cause) {
        setMessage({
          tone: 'error',
          text: `Le certificat a été enregistré, mais le PDF n’a pas pu être généré : ${
            cause instanceof Error ? cause.message : 'erreur inconnue'
          }`,
        });
      }
      setModule('');
      setStartsOn('');
      setEndsOn('');
      setHours('');
      setMention('');
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Impossible de créer le certificat.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function download(certificate: Certificate) {
    if (state.status !== 'loaded') return;
    const student = state.students.find(
      (item) => String(item.id) === String(certificate.studentId),
    );
    try {
      await downloadCertificate(certificate, studentName(student));
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Impossible de télécharger le certificat.',
      });
    }
  }

  return (
    <section className="mx-auto w-full max-w-screen-2xl space-y-5">
      <PageHeader
        description="Créez et téléchargez les certificats PDF délivrés aux étudiants de votre centre."
        eyebrow="Gestion pédagogique"
        title="Certificats"
      />
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {state.status === 'loading' && (
        <Panel>
          <LoadingState label="Chargement des certificats…" />
        </Panel>
      )}
      {state.status === 'error' && (
        <Panel className="space-y-3">
          <EmptyState
            description={state.message}
            title="Les certificats ne sont pas disponibles."
          />
          <Button onClick={() => setReload((value) => value + 1)} type="button" variant="secondary">
            Réessayer
          </Button>
        </Panel>
      )}
      {state.status === 'loaded' && (
        <>
          <Panel>
            <h2 className="management-panel-title">Émettre un certificat</h2>
            {state.students.length === 0 ? (
              <EmptyState
                description="Ajoutez d’abord des étudiants au centre."
                title="Aucun étudiant disponible."
              />
            ) : (
              <form className="management-editor-form" onSubmit={(event) => void submit(event)}>
                <label className="sp-form-field">
                  Étudiant
                  <select
                    className="sp-field"
                    onChange={(event) => setStudentId(event.target.value)}
                    required
                    value={studentId}
                  >
                    {state.students.map((student) => (
                      <option key={String(student.id)} value={String(student.id)}>
                        {studentName(student)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="sp-form-field">
                  Formation / module
                  <input
                    className="sp-field"
                    maxLength={200}
                    onChange={(event) => setModule(event.target.value)}
                    required
                    value={module}
                  />
                </label>
                <label className="sp-form-field">
                  Date de début
                  <input
                    className="sp-field"
                    onChange={(event) => setStartsOn(event.target.value)}
                    type="date"
                    value={startsOn}
                  />
                </label>
                <label className="sp-form-field">
                  Date de fin
                  <input
                    className="sp-field"
                    min={startsOn || undefined}
                    onChange={(event) => setEndsOn(event.target.value)}
                    type="date"
                    value={endsOn}
                  />
                </label>
                <label className="sp-form-field">
                  Durée (heures)
                  <input
                    className="sp-field"
                    min="0.5"
                    onChange={(event) => setHours(event.target.value)}
                    step="0.5"
                    type="number"
                    value={hours}
                  />
                </label>
                <label className="sp-form-field">
                  Mention
                  <input
                    className="sp-field"
                    maxLength={120}
                    onChange={(event) => setMention(event.target.value)}
                    value={mention}
                  />
                </label>
                <div className="management-editor-actions management-editor-wide">
                  <Button disabled={busy} type="submit">
                    {busy ? 'Génération…' : 'Créer et télécharger le PDF'}
                  </Button>
                </div>
              </form>
            )}
          </Panel>
          <Panel className="!p-0">
            {state.certificates.length === 0 ? (
              <EmptyState
                description="Les certificats générés apparaîtront ici."
                title="Aucun certificat émis."
              />
            ) : (
              <div className="sp-table-wrap">
                <table className="sp-table">
                  <thead>
                    <tr>
                      <th>N°</th>
                      <th>Étudiant</th>
                      <th>Formation</th>
                      <th>Période</th>
                      <th>Émis le</th>
                      <th>PDF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.certificates.map((certificate) => (
                      <tr key={String(certificate.id)}>
                        <td>
                          <strong>{certificateNumber(certificate)}</strong>
                        </td>
                        <td>
                          {studentName(
                            state.students.find(
                              (item) => String(item.id) === String(certificate.studentId),
                            ),
                          )}
                        </td>
                        <td>{certificate.module}</td>
                        <td>
                          {certificate.startsOn && certificate.endsOn
                            ? `${formatDate(certificate.startsOn)} - ${formatDate(certificate.endsOn)}`
                            : '—'}
                        </td>
                        <td>{new Date(certificate.createdAt).toLocaleDateString('fr-FR')}</td>
                        <td>
                          <Button
                            onClick={() => void download(certificate)}
                            type="button"
                            variant="secondary"
                          >
                            Télécharger
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </section>
  );
}
