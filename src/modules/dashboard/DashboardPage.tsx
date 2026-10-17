import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, LoadingState, PageHeader, Panel } from '../../components/ui';
import {
  getDashboardDateRange,
  getNextCourseDates,
  getDashboardWeekday,
  formatDashboardTime,
  summarizeDashboard,
} from '../../business/dashboard/dashboardMetrics';
import { getDashboardData } from '../../data/repositories/dashboardRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import type { DashboardData, DashboardDateRange } from '../../types/dashboard';
import { useAuth } from '../auth/AuthProvider';
import { CentreRegionMap } from './CentreRegionMap';

type DashboardState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: DashboardData };

type ChartMode = 'line' | 'bar' | 'cum';

function DashboardIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16M8 7h8m-8 4h8',
    users:
      'M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m6-7a4 4 0 0 1 0 8m2 3h2a3 3 0 0 1 3 3v1',
    check: 'M5 12l4 4L19 6',
    clock: 'M12 7v5l3 2m5-2a8 8 0 1 1-2.3-5.7M20 4v5h-5',
    formations: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    groups:
      'M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-2h4m-2-2v4',
    refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5',
    filter: 'M3 5h18l-7 8v6l-4-2v-4z',
    line: 'M3 17l6-6 4 4 8-9',
    bars: 'M6 20V10M12 20V4M18 20v-7',
    cumulative: 'M3 20h18M5 16l5-4 4 2 5-8',
  };

  return (
    <svg aria-hidden="true" className="dashboard-icon" viewBox="0 0 24 24">
      <path d={paths[name]} />
    </svg>
  );
}

function DashboardMetric({
  title,
  description,
  value,
  icon,
  detailIcon,
}: {
  title: string;
  description: string;
  value: string | number;
  icon: string;
  detailIcon?: string;
}) {
  return (
    <article className="dashboard-card dashboard-metric">
      <span className="dashboard-metric-icon">
        <DashboardIcon name={icon} />
      </span>
      <div>
        <b>{title}</b>
        <small>{description}</small>
        <strong>{value}</strong>
      </div>
      {detailIcon && (
        <span className="dashboard-metric-detail">
          <DashboardIcon name={detailIcon} />
        </span>
      )}
    </article>
  );
}

function DomainDistribution({ values }: { values: { domain: string; count: number }[] }) {
  const total = values.reduce((sum, item) => sum + item.count, 0);
  if (!total) return <p className="sp-muted">Pas encore de données.</p>;

  const colors: Record<string, string> = {
    Langues: 'var(--lang)',
    Bureautique: 'var(--bur)',
    'Data & IT': 'var(--data)',
    Mathématiques: 'var(--math)',
  };
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = values.map((item) => {
    const length = (item.count / total) * circumference;
    const segment = { ...item, length, offset, color: colors[item.domain] ?? 'var(--brand)' };
    offset += length;
    return segment;
  });

  return (
    <div className="dashboard-donut-layout">
      <svg
        aria-label={`Répartition par domaine, ${total} séances`}
        role="img"
        viewBox="0 0 160 160"
      >
        <g fill="none" strokeWidth="26" transform="rotate(-90 80 80)">
          {segments.map((segment) => (
            <circle
              key={segment.domain}
              cx="80"
              cy="80"
              r={radius}
              stroke={segment.color}
              strokeDasharray={`${segment.length} ${circumference - segment.length}`}
              strokeDashoffset={-segment.offset}
            />
          ))}
        </g>
        <text className="dashboard-donut-title" textAnchor="middle" x="80" y="76">
          Séances
        </text>
        <text className="dashboard-donut-total" textAnchor="middle" x="80" y="101">
          {total}
        </text>
      </svg>
      <ul className="dashboard-donut-legend">
        {segments.map((segment) => (
          <li key={segment.domain}>
            <span>
              <i style={{ background: segment.color }} />
              {segment.domain}
            </span>
            <strong>
              {segment.count} ({Math.round((segment.count / total) * 100)}%)
            </strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur inattendue est survenue.';
}

function getEnrollmentSeries(data: DashboardData, range: DashboardDateRange) {
  const from = new Date(`${range.from}T12:00:00`);
  const to = new Date(`${range.to}T12:00:00`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to < from) return [];

  const monthly = to.getTime() - from.getTime() > 62 * 86400000;
  const values = new Map<string, number>();
  for (let date = new Date(from); date <= to;) {
    const key = monthly
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    values.set(key, 0);
    if (monthly) {
      date = new Date(date.getFullYear(), date.getMonth() + 1, 1, 12);
    } else {
      date.setDate(date.getDate() + 1);
    }
  }

  for (const enrollment of data.enrollments) {
    const createdAt = enrollment.createdAt?.slice(0, 10);
    if (!createdAt) continue;
    const key = monthly ? createdAt.slice(0, 7) : createdAt;
    if (values.has(key)) values.set(key, (values.get(key) ?? 0) + 1);
  }

  return [...values].map(([key, value]) => ({
    label: key.slice(monthly ? 5 : 5).replace('-', '/'),
    value,
  }));
}

function EnrollmentChart({
  data,
  range,
  mode,
}: {
  data: DashboardData;
  range: DashboardDateRange;
  mode: ChartMode;
}) {
  const series = getEnrollmentSeries(data, range);
  const plotted =
    mode === 'cum'
      ? series.map((point, index) => ({
          ...point,
          value: series.slice(0, index + 1).reduce((total, current) => total + current.value, 0),
        }))
      : series;
  const maximum = Math.max(1, ...plotted.map((point) => point.value));

  if (!series.length) {
    return <p className="sp-muted">Choisissez une période valide.</p>;
  }

  const width = 760;
  const height = 250;
  const left = 40;
  const right = 16;
  const top = 12;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const interval =
    [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((value) => maximum / value <= 5) ?? 1000;
  const yMaximum = Math.ceil(maximum / interval) * interval;
  const x = (index: number) =>
    left + (plotted.length > 1 ? (index / (plotted.length - 1)) * plotWidth : plotWidth / 2);
  const y = (value: number) => top + plotHeight - (value / yMaximum) * plotHeight;
  const tickIndexes =
    plotted.length <= 6
      ? plotted.map((_, index) => index)
      : Array.from({ length: 6 }, (_, index) => Math.round((index * (plotted.length - 1)) / 5));
  const coordinates = plotted.map((point, index) => [x(index), y(point.value)] as const);
  const curvePath = coordinates
    .map((point, index) => {
      if (index === 0) return `M${point[0]},${point[1]}`;
      const previous = coordinates[index - 1];
      const beforePrevious = coordinates[index - 2] ?? previous;
      const next = coordinates[index + 1] ?? point;
      const firstControl = [
        previous[0] + (point[0] - beforePrevious[0]) / 6,
        Math.min(top + plotHeight, previous[1] + (point[1] - beforePrevious[1]) / 6),
      ];
      const secondControl = [
        point[0] - (next[0] - previous[0]) / 6,
        Math.min(top + plotHeight, point[1] - (next[1] - previous[1]) / 6),
      ];
      return `C${firstControl[0]},${firstControl[1]} ${secondControl[0]},${secondControl[1]} ${point[0]},${point[1]}`;
    })
    .join(' ');
  const areaPath =
    coordinates.length > 0
      ? `${curvePath} L${coordinates.at(-1)?.[0]},${top + plotHeight} L${coordinates[0][0]},${top + plotHeight} Z`
      : '';

  return (
    <div className="dashboard-chart" role="img" aria-label="Évolution des inscriptions">
      <svg className="dashboard-chart-svg" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <defs>
          <linearGradient id="dashboard-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--brand)" stopOpacity=".22" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: yMaximum / interval + 1 }, (_, index) => {
          const value = index * interval;
          return (
            <g key={value}>
              <line
                className="dashboard-chart-grid"
                x1={left}
                x2={width - right}
                y1={y(value)}
                y2={y(value)}
              />
              <text
                className="dashboard-chart-label"
                textAnchor="end"
                x={left - 8}
                y={y(value) + 4}
              >
                {value}
              </text>
            </g>
          );
        })}
        {tickIndexes.map((index, tickIndex) => (
          <text
            className="dashboard-chart-label"
            key={`${plotted[index].label}-${index}`}
            textAnchor={
              plotted.length < 2
                ? 'middle'
                : tickIndex === 0
                  ? 'start'
                  : tickIndex === tickIndexes.length - 1
                    ? 'end'
                    : 'middle'
            }
            x={x(index)}
            y={height - 8}
          >
            {plotted[index].label}
          </text>
        ))}
        {mode === 'bar' ? (
          plotted.map((point, index) => {
            const barWidth = Math.max(3, Math.min(26, (plotWidth / plotted.length) * 0.6));
            return (
              <rect
                className="dashboard-chart-bar"
                height={top + plotHeight - y(point.value)}
                key={`${point.label}-${index}`}
                rx="3"
                width={barWidth}
                x={x(index) - barWidth / 2}
                y={y(point.value)}
              />
            );
          })
        ) : (
          <>
            {coordinates.length > 1 && <path className="dashboard-chart-area" d={areaPath} />}
            <path className="dashboard-chart-line" d={curvePath} />
            {coordinates.length === 1 && (
              <circle
                className="dashboard-chart-point"
                cx={coordinates[0][0]}
                cy={coordinates[0][1]}
                r="4"
              />
            )}
          </>
        )}
      </svg>
    </div>
  );
}

function TeacherDashboard({ data }: { data: DashboardData }) {
  if (!data.linkedTeacher) {
    return (
      <section className="mx-auto w-full max-w-screen-2xl">
        <PageHeader eyebrow="Espace formateur" title="Mon tableau de bord" />
        <Alert>Votre compte formateur n’est pas encore lié à une fiche formateur.</Alert>
      </section>
    );
  }

  const courseIds = new Set(data.courses.map((course) => String(course.id)));
  const enrollments = data.enrollments.filter((enrollment) =>
    courseIds.has(String(enrollment.courseId)),
  );
  const students = new Set(enrollments.map((enrollment) => String(enrollment.studentId)));
  const presences = data.presences.filter((presence) => courseIds.has(String(presence.courseId)));
  const presentCount = presences.filter(
    (presence) => presence.status === 'present' || presence.status === 'retard',
  ).length;
  const attendanceRate = presences.length ? Math.round((presentCount / presences.length) * 100) : 0;
  const monthEnd = new Date();
  const monthStart = new Date(monthEnd.getFullYear(), monthEnd.getMonth() - 5, 1);
  const sixMonthRange = {
    from: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-01`,
    to: `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`,
  };
  const upcoming = getNextCourseDates(data.courses);
  const subjectNames = new Map(data.subjects.map((subject) => [String(subject.id), subject.name]));
  const monthlyData = {
    ...data,
    enrollments: enrollments.filter((enrollment) => enrollment.createdAt),
  };

  return (
    <section
      className="mx-auto w-full max-w-screen-2xl space-y-5"
      aria-labelledby="dashboard-title"
    >
      <PageHeader
        description="Votre activité pédagogique"
        eyebrow="Espace formateur"
        title="Mon tableau de bord"
      />

      <div className="dashboard-kpis">
        <DashboardMetric
          description="Cours attribués"
          detailIcon="check"
          icon="book"
          title="Mes cours"
          value={data.courses.length}
        />
        <DashboardMetric
          description="Étudiants inscrits à mes cours"
          detailIcon="users"
          icon="users"
          title="Mes étudiants"
          value={students.size}
        />
        <DashboardMetric
          description="Sur mes cours"
          detailIcon="check"
          icon="check"
          title="Taux de présence"
          value={`${attendanceRate}%`}
        />
        <DashboardMetric
          description="Total"
          detailIcon="check"
          icon="clock"
          title="Présences enregistrées"
          value={presences.length}
        />
      </div>

      <div className="dashboard-columns">
        <Panel>
          <h2>Évolution de mes inscriptions</h2>
          <EnrollmentChart data={monthlyData} range={sixMonthRange} mode="line" />
        </Panel>
        <Panel className="dashboard-panel">
          <h2>Mes prochains cours</h2>
          {upcoming.length ? (
            <ul className="dashboard-upcoming">
              {upcoming.map(({ course, date }) => (
                <li className="dashboard-upcoming-item" key={`${course.id}-${date.toISOString()}`}>
                  <strong>{subjectNames.get(String(course.subjectId)) ?? '?'}</strong>
                  <span>
                    {date.toLocaleDateString('fr-FR', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    })}
                    {' · '}
                    {formatDashboardTime(course.startsAt)} – {formatDashboardTime(course.endsAt)}
                    {course.roomName ? ` · ${course.roomName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Alert>Aucun prochain cours.</Alert>
          )}
        </Panel>
      </div>

      <Panel className="dashboard-panel">
        <h2>Mes cours</h2>
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr className="border-b border-line bg-slate-50 text-xs tracking-wide text-slate-500 uppercase">
                <th className="px-4 py-3 font-semibold" scope="col">
                  Séance
                </th>
                <th className="px-4 py-3 font-semibold" scope="col">
                  Jour
                </th>
                <th className="px-4 py-3 font-semibold" scope="col">
                  Horaire
                </th>
                <th className="px-4 py-3 font-semibold" scope="col">
                  Étudiants
                </th>
              </tr>
            </thead>
            <tbody>
              {data.courses.length ? (
                data.courses.map((course) => (
                  <tr
                    className="border-b border-line last:border-0 hover:bg-slate-50/70"
                    key={String(course.id)}
                  >
                    <td data-label="Séance">{subjectNames.get(String(course.subjectId)) ?? '?'}</td>
                    <td data-label="Jour">{getDashboardWeekday(course.weekday)}</td>
                    <td data-label="Horaire">
                      {formatDashboardTime(course.startsAt)} – {formatDashboardTime(course.endsAt)}
                    </td>
                    <td data-label="Étudiants">
                      {
                        enrollments.filter(
                          (enrollment) => String(enrollment.courseId) === String(course.id),
                        ).length
                      }
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-4 py-4 text-slate-500" colSpan={4}>
                    Aucun cours attribué.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

export function DashboardPage() {
  const { profile } = useAuth();
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<DashboardState>({ status: 'loading' });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [filters, setFilters] = useState({ teacherId: '', courseId: '' });
  const [range, setRange] = useState<DashboardDateRange>(() => getDashboardDateRange('m'));

  useEffect(() => {
    let active = true;
    async function load() {
      setState({ status: 'loading' });
      try {
        if (!profile) throw new Error('Votre profil ne peut pas être chargé.');
        if (profile.role === 'etudiant') {
          if (active) {
            setState({
              status: 'loaded',
              data: {
                linkedTeacher: null,
                courses: [],
                subjects: [],
                teachers: [],
                studentIds: [],
                enrollments: [],
                presences: [],
                requests: [],
                formationCount: null,
                groupCount: null,
                popularFormations: [],
                closedDates: [],
                cancelledOccurrences: [],
              },
            });
          }
          return;
        }
        const data = await getDashboardData(
          getSupabaseClient(),
          profile.centreId ?? '',
          profile.id,
          profile.role,
        );
        if (active) setState({ status: 'loaded', data });
      } catch (error) {
        if (active) setState({ status: 'error', message: errorMessage(error) });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [profile, reloadKey]);

  const summary = useMemo(
    () =>
      state.status === 'loaded'
        ? summarizeDashboard(
            state.data,
            range,
            filters,
            new Set(state.data.closedDates),
            new Set(state.data.cancelledOccurrences),
          )
        : null,
    [state, range, filters],
  );

  if (state.status === 'loading') {
    return (
      <section className="mx-auto w-full max-w-screen-2xl">
        <Panel>
          <LoadingState label="Chargement du tableau de bord…" />
        </Panel>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section
        className="mx-auto w-full max-w-screen-2xl space-y-5"
        aria-labelledby="dashboard-title"
      >
        <PageHeader eyebrow="Espace membre" title="Tableau de bord" />
        <Alert className="space-y-2" tone="error">
          <p>Le tableau de bord ne peut pas être chargé.</p>
          <p>{state.message}</p>
          <Button onClick={() => setReloadKey((key) => key + 1)} type="button" variant="secondary">
            Réessayer
          </Button>
        </Alert>
      </section>
    );
  }

  if (profile?.role === 'etudiant') {
    return (
      <section className="mx-auto w-full max-w-screen-2xl">
        <PageHeader
          description="Choisissez une rubrique dans le menu pour consulter vos cours et présences."
          eyebrow="Espace étudiant"
          title={`Bonjour${profile.fullName ? `, ${profile.fullName}` : ''}`}
        />
      </section>
    );
  }

  if (profile?.role === 'formateur') return <TeacherDashboard data={state.data} />;

  const data = state.data;
  const metrics = summary;
  if (!metrics) return null;

  return (
    <section
      className="mx-auto w-full max-w-screen-2xl space-y-5"
      aria-labelledby="dashboard-title"
    >
      <PageHeader
        description="Indicateurs calculés à partir des données de la période choisie."
        eyebrow="Vue d’ensemble du centre"
        title="Tableau de bord"
      />

      <div className="dashboard-toolbar" aria-label="Période du tableau de bord">
        <div className="dashboard-periods" role="group" aria-label="Période prédéfinie">
          {(['d', 'w', 'm', 'y'] as const).map((preset) => {
            const presetRange = getDashboardDateRange(preset);
            const isSelected = range.from === presetRange.from && range.to === presetRange.to;
            return (
              <button
                aria-pressed={isSelected}
                className={`dashboard-period${isSelected ? ' active' : ''}`}
                key={preset}
                onClick={() => setRange(presetRange)}
                type="button"
              >
                {{ d: 'Aujourd’hui', w: 'Cette semaine', m: 'Ce mois', y: 'Cette année' }[preset]}
              </button>
            );
          })}
        </div>
        <div className="dashboard-date-range">
          <label>
            Du
            <input
              aria-label="Du"
              onChange={(event) =>
                setRange((current) => ({ ...current, from: event.target.value }))
              }
              type="date"
              value={range.from}
            />
          </label>
          <label>
            Au
            <input
              aria-label="Au"
              onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))}
              type="date"
              value={range.to}
            />
          </label>
        </div>
        <button
          aria-label="Actualiser"
          className="dashboard-action-button"
          onClick={() => setReloadKey((key) => key + 1)}
          title="Actualiser"
          type="button"
        >
          <DashboardIcon name="refresh" />
        </button>
        <button
          aria-expanded={filtersOpen}
          aria-label="Filtres"
          className={`dashboard-action-button${filtersOpen ? ' active' : ''}`}
          onClick={() => setFiltersOpen((open) => !open)}
          title="Filtres"
          type="button"
        >
          <DashboardIcon name="filter" />
        </button>
      </div>

      {filtersOpen && (
        <div className="dashboard-filters">
          <label>
            Formateur
            <select
              className="min-h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm"
              onChange={(event) =>
                setFilters((current) => ({ ...current, teacherId: event.target.value }))
              }
              value={filters.teacherId}
            >
              <option value="">Tous les formateurs</option>
              {data.teachers.map((teacher) => (
                <option key={String(teacher.id)} value={String(teacher.id)}>
                  {teacher.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Séance
            <select
              className="min-h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm"
              onChange={(event) =>
                setFilters((current) => ({ ...current, courseId: event.target.value }))
              }
              value={filters.courseId}
            >
              <option value="">Toutes les séances</option>
              {data.courses.map((course) => (
                <option key={String(course.id)} value={String(course.id)}>
                  {data.subjects.find((subject) => String(subject.id) === String(course.subjectId))
                    ?.name ?? '?'}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="dashboard-kpis">
        <DashboardMetric
          description="Inscrits et actifs"
          detailIcon="users"
          icon="users"
          title="Total des étudiants"
          value={metrics.studentCount}
        />

        <DashboardMetric
          description="Formations du centre"
          detailIcon="book"
          icon="formations"
          title="Formations"
          value={data.formationCount ?? '—'}
        />
        <DashboardMetric
          description="Actifs sur la période"
          detailIcon="users"
          icon="users"
          title="Formateurs"
          value={metrics.teacherCount}
        />
        <DashboardMetric
          description="Groupes du centre"
          detailIcon="groups"
          icon="groups"
          title="Groupes"
          value={data.groupCount ?? '—'}
        />
      </div>

      <div className="dashboard-columns dashboard-main-grid">
        <Panel className="dashboard-panel">
          <div className="dashboard-heading dashboard-chart-heading">
            <h2>Évolution des inscriptions</h2>
            <div className="dashboard-chart-controls" aria-label="Mode du graphique">
              {(['line', 'bar', 'cum'] as const).map((mode) => (
                <button
                  aria-pressed={chartMode === mode}
                  aria-label={{ line: 'Courbe', bar: 'Barres', cum: 'Cumul' }[mode]}
                  className={`dashboard-chart-mode${chartMode === mode ? ' active' : ''}`}
                  key={mode}
                  onClick={() => setChartMode(mode)}
                  type="button"
                  title={{ line: 'Courbe', bar: 'Barres', cum: 'Cumul' }[mode]}
                >
                  <DashboardIcon name={{ line: 'line', bar: 'bars', cum: 'cumulative' }[mode]} />
                </button>
              ))}
            </div>
          </div>
          <EnrollmentChart data={data} range={range} mode={chartMode} />
        </Panel>
        <div className="dashboard-side-cards">
          <Panel className="dashboard-panel dashboard-side-metric">
            <span className="dashboard-side-icon">
              <DashboardIcon name="check" />
            </span>
            <div>
              <b>Taux de présence</b>
              <small>Période choisie</small>
              <strong>
                {metrics.attendanceRate === null ? '—' : `${Math.round(metrics.attendanceRate)}%`}
              </strong>
              <small>
                {metrics.attendanceCount} présence(s); tout statut autre que « absent » compte comme
                présent.
              </small>
            </div>
          </Panel>
          <Panel className="dashboard-panel dashboard-side-metric">
            <span className="dashboard-side-icon">
              <DashboardIcon name="clock" />
            </span>
            <div>
              <b>Demandes d’inscription</b>
              <small>Tous statuts</small>
              <ul className="dashboard-status-list">
                <li>
                  En attente <strong>{metrics.requestCounts.pending}</strong>
                </li>
                <li>
                  Approuvées <strong>{metrics.requestCounts.approved}</strong>
                </li>
                <li>
                  Refusées <strong>{metrics.requestCounts.refused}</strong>
                </li>
              </ul>
            </div>
          </Panel>
        </div>
      </div>

      <div className="dashboard-data-grid">
        <Panel className="dashboard-panel">
          <h2>Séances sur la période</h2>
          {metrics.occurrences.length ? (
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr className="border-b border-line bg-slate-50 text-xs tracking-wide text-slate-500 uppercase">
                    <th className="px-4 py-3 font-semibold" scope="col">
                      Séance
                    </th>
                    <th className="px-4 py-3 font-semibold" scope="col">
                      Formateur
                    </th>
                    <th className="px-4 py-3 font-semibold" scope="col">
                      Étudiants
                    </th>
                    <th className="px-4 py-3 font-semibold" scope="col">
                      Présences
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.popularSubjects.map((item) => (
                    <tr
                      className="border-b border-line last:border-0 hover:bg-slate-50/70"
                      key={`${item.subject}-${item.teacher}`}
                    >
                      <td data-label="Séance">{item.subject}</td>
                      <td data-label="Formateur">{item.teacher}</td>
                      <td data-label="Étudiants">{item.studentCount}</td>
                      <td data-label="Présences">{item.presentCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Alert>Aucun cours ne correspond à ces filtres.</Alert>
          )}
        </Panel>
        <Panel className="dashboard-panel">
          <h2>Formations les plus populaires</h2>
          {data.popularFormations.length ? (
            <ol className="dashboard-popular">
              {data.popularFormations.map((formation, index) => {
                const maxStudents = Math.max(...data.popularFormations.map((item) => item.studentCount), 1);
                const share = Math.round((formation.studentCount / maxStudents) * 100);
                return (
                  <li key={formation.name}>
                    <div className="dashboard-popular-rank" aria-label={`Rang ${index + 1}`}>
                      {String(index + 1).padStart(2, '0')}
                    </div>
                    <div className="dashboard-popular-content">
                      <div className="dashboard-popular-line">
                        <span title={formation.name}>{formation.name}</span>
                        <strong>{formation.studentCount}</strong>
                      </div>
                      <div className="dashboard-popular-track" aria-hidden="true">
                        <span style={{ width: `${share}%` }} />
                      </div>
                      <small>{formation.studentCount === 1 ? 'étudiant inscrit' : 'étudiants inscrits'}</small>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <Alert>Aucune formation trouvée.</Alert>
          )}
        </Panel>
        <Panel className="dashboard-panel">
          <h2>Répartition par domaine</h2>
          <DomainDistribution values={metrics.domainDistribution} />
        </Panel>
      </div>

      <div className="dashboard-insights-grid">
        <Panel className="dashboard-insight-panel">
          <div className="dashboard-insight-heading">
            <span className="dashboard-insight-icon is-green">↗</span>
            <div><h2>Présences et absences</h2><p>Répartition des statuts enregistrés</p></div>
          </div>
          {(() => {
            const statuses = [
              { label: 'Présent', value: data.presences.filter((item) => ['present', 'présent'].includes(item.status.toLowerCase())).length, color: 'is-green' },
              { label: 'Retard', value: data.presences.filter((item) => item.status.toLowerCase() === 'retard').length, color: 'is-amber' },
              { label: 'Absent', value: data.presences.filter((item) => ['absent', 'absence'].includes(item.status.toLowerCase())).length, color: 'is-rose' },
            ];
            const total = statuses.reduce((sum, item) => sum + item.value, 0);
            return total ? <div className="dashboard-insight-bars">{statuses.map((item) => <div className="dashboard-insight-bar-row" key={item.label}><div><span>{item.label}</span><strong>{item.value}</strong></div><div className="dashboard-insight-track"><span className={item.color} style={{ width: `${Math.round(item.value / total * 100)}%` }} /></div></div>)}</div> : <p className="dashboard-insight-empty">Les graphiques apparaîtront dès que des présences seront enregistrées.</p>;
          })()}
        </Panel>
        <Panel className="dashboard-insight-panel">
          <div className="dashboard-insight-heading">
            <span className="dashboard-insight-icon is-blue">◫</span>
            <div><h2>Charge des formateurs</h2><p>Nombre de cours par formateur</p></div>
          </div>
          {(() => {
            const counts = data.teachers.map((teacher) => ({ name: teacher.name, count: data.courses.filter((course) => String(course.teacherId) === String(teacher.id)).length })).sort((a,b) => b.count-a.count).slice(0,5);
            const max = Math.max(1, ...counts.map((item) => item.count));
            return counts.length ? <div className="dashboard-insight-bars">{counts.map((item) => <div className="dashboard-insight-bar-row" key={item.name}><div><span title={item.name}>{item.name}</span><strong>{item.count}</strong></div><div className="dashboard-insight-track"><span className="is-blue" style={{ width: `${Math.round(item.count / max * 100)}%` }} /></div></div>)}</div> : <p className="dashboard-insight-empty">Aucun formateur disponible pour cette vue.</p>;
          })()}
        </Panel>
        <Panel className="dashboard-insight-panel">
          <div className="dashboard-insight-heading">
            <span className="dashboard-insight-icon is-violet">▦</span>
            <div><h2>Utilisation des salles</h2><p>Répartition des cours par salle renseignée</p></div>
          </div>
          {(() => {
            const counts = new Map<string, number>();
            data.courses.forEach((course) => { if (course.roomName) counts.set(course.roomName, (counts.get(course.roomName) ?? 0) + 1); });
            const values = [...counts].map(([name, count]) => ({ name, count })).sort((a,b) => b.count-a.count).slice(0,5);
            const max = Math.max(1, ...values.map((item) => item.count));
            return values.length ? <div className="dashboard-insight-bars">{values.map((item) => <div className="dashboard-insight-bar-row" key={item.name}><div><span title={item.name}>{item.name}</span><strong>{item.count}</strong></div><div className="dashboard-insight-track"><span className="is-violet" style={{ width: `${Math.round(item.count / max * 100)}%` }} /></div></div>)}</div> : <p className="dashboard-insight-empty">Renseignez les salles dans les cours pour alimenter ce graphique.</p>;
          })()}
        </Panel>
        <Panel className="dashboard-insight-panel dashboard-insight-future">
          <div className="dashboard-insight-heading">
            <span className="dashboard-insight-icon is-green">◉</span>
            <div><h2>Paiements et recettes</h2><p>Analyse financière du centre</p></div>
          </div>
          <div className="dashboard-future-visual" aria-hidden="true"><div className="dashboard-future-donut"><span>DH</span></div><div className="dashboard-future-legend"><i /><i /><i /></div></div>
          <p className="dashboard-insight-empty">Graphiques prêts à être connectés aux données de paiement : recettes mensuelles, montants dus et paiements en attente. Aucun montant fictif n’est affiché.</p>
        </Panel>
        <CentreRegionMap centreId={profile?.centreId ?? ''} />
      </div>
    </section>
  );
}
