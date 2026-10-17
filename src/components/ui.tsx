import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  SelectHTMLAttributes,
} from 'react';
import { useEffect } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: '',
  secondary: 'sp-btn-ghost',
  danger: 'sp-btn-danger',
  quiet: 'sp-btn-quiet',
};

export function Button({
  children,
  className = '',
  variant = 'primary',
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>> & {
  variant?: ButtonVariant;
}) {
  return (
    <button className={`sp-btn ${buttonVariants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: PropsWithChildren['children'];
}) {
  return (
    <header className="sp-page-heading">
      <div>
        {eyebrow && <p className="sp-page-eyebrow">{eyebrow}</p>}
        <h1 className="sp-page-title">{title}</h1>
        {description && <p className="sp-page-description">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  children,
  className = '',
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLElement>>) {
  return (
    <section className={`sp-panel ${className}`} {...props}>
      {children}
    </section>
  );
}

export function Field({
  label,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = props.id ?? props.name;
  return (
    <label className={`sp-form-field ${className}`} htmlFor={id}>
      {label}
      <input {...props} className="sp-field" id={id} />
    </label>
  );
}

export function SelectField({
  label,
  className = '',
  children,
  ...props
}: PropsWithChildren<SelectHTMLAttributes<HTMLSelectElement>> & { label: string }) {
  const id = props.id ?? props.name;
  return (
    <label className={`sp-form-field ${className}`} htmlFor={id}>
      {label}
      <select {...props} className="sp-field" id={id}>
        {children}
      </select>
    </label>
  );
}

export function StatusBadge({
  children,
  tone = 'neutral',
}: PropsWithChildren<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' }>) {
  const tones = {
    neutral: 'sp-status-neutral',
    success: 'sp-status-success',
    warning: 'sp-status-warning',
    danger: 'sp-status-danger',
  };
  return <span className={`sp-status ${tones[tone]}`}>{children}</span>;
}

export function Alert({
  children,
  className = '',
  tone = 'info',
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>> & {
  tone?: 'info' | 'success' | 'warning' | 'error';
}) {
  const tones = {
    info: 'sp-alert-info',
    success: 'sp-alert-success',
    warning: 'sp-alert-warning',
    error: 'sp-alert-error',
  };
  return (
    <div
      className={`sp-alert ${tones[tone]} ${className}`}
      role={tone === 'error' ? 'alert' : 'status'}
      {...props}
    >
      {children}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div aria-live="polite" className="sp-loading" role="status">
      <span className="sp-spinner" />
      {label}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="sp-empty">
      <p>{title}</p>
      {description && <p className="sp-muted">{description}</p>}
    </div>
  );
}


export function Modal({
  children,
  onClose,
  label = 'Fenêtre de dialogue',
}: PropsWithChildren<{ onClose: () => void; label?: string }>) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="sp-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section aria-label={label} aria-modal="true" className="sp-modal" role="dialog">
        <button
          aria-label="Fermer la fenêtre"
          className="sp-modal-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
        {children}
      </section>
    </div>
  );
}

export function ThemeToggle() {
  return (
    <button
      aria-label="Changer de thème (clair ou sombre)"
      className="sp-icon-button sp-theme-toggle"
      onClick={() => {
        const root = document.documentElement;
        const isDark =
          root.dataset.theme === 'dark' ||
          (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
        root.dataset.theme = isDark ? 'light' : 'dark';
      }}
      title="Clair / sombre"
      type="button"
    >
      <svg aria-hidden="true" className="sp-theme-moon" viewBox="0 0 24 24">
        <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
      </svg>
      <svg aria-hidden="true" className="sp-theme-sun" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    </button>
  );
}
