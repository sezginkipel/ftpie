import { Component, type ErrorInfo, type ReactNode } from 'react';

import { translate, type Locale } from '../lib/i18n';
import { DEFAULT_LOCALE } from '../lib/i18n';

interface Props {
  children: ReactNode;
  /**
   * The boundary sits *outside* `I18nProvider` (a throw inside the provider
   * must still render), so it cannot use `useT`. Pass the locale explicitly.
   */
  locale?: Locale;
  /** Called on catch, e.g. to log to a file. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  expanded: boolean;
  copied: boolean;
}

/**
 * Top-level error boundary.
 *
 * Without one, any render throw white-screened the entire app with no way back.
 * This shows what failed, the component stack behind a disclosure, a Reload
 * button, and a Copy details button so the user can report it.
 *
 * Deliberately styled with inline CSS variables rather than Tailwind classes:
 * if the failure is in the stylesheet or the theme setup, this still renders.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, expanded: false, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    this.props.onError?.(error, info);
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private t = (key: Parameters<typeof translate>[1]): string =>
    translate(this.props.locale ?? DEFAULT_LOCALE, key);

  private details(): string {
    const { error, componentStack } = this.state;
    return [
      `${error?.name ?? 'Error'}: ${error?.message ?? ''}`,
      '',
      error?.stack ?? '(no stack)',
      '',
      'Component stack:',
      componentStack ?? '(none)',
    ].join('\n');
  }

  private copyDetails = (): void => {
    const text = this.details();
    const done = () => this.setState({ copied: true });

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => this.setState({ copied: false }));
      return;
    }
    // No clipboard API (or permission denied): the <pre> below is selectable,
    // so the user still has a way to copy it manually.
    this.setState({ copied: false });
  };

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, componentStack, expanded, copied } = this.state;
    if (!error) return this.props.children;

    /*
     * Calm, not alarming. This is the last thing a user sees when the interface
     * dies, so it reads as a card with a way forward rather than a red stack
     * trace: neutral surface, a quiet tinted icon, the reason in a monospace
     * block, the stack folded away, and two buttons that actually help.
     */
    const button: React.CSSProperties = {
      height: 30,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 14px',
      borderRadius: 'var(--radius)',
      border: '1px solid var(--border-strong)',
      background: 'var(--surface)',
      color: 'var(--text)',
      font: 'inherit',
      cursor: 'pointer',
    };

    const codeBlock: React.CSSProperties = {
      margin: 0,
      padding: 10,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      borderRadius: 'var(--radius)',
      border: '1px solid var(--border)',
      background: 'var(--surface-2)',
      fontFamily: 'var(--font-mono)',
      fontSize: 11.5,
      lineHeight: 1.55,
      // Selectable: even with no clipboard permission there is a way to report.
      userSelect: 'text',
    };

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          minHeight: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          background: 'var(--bg)',
          color: 'var(--text)',
          fontFamily: 'var(--font-ui)',
          fontSize: 13.5,
          lineHeight: 1.45,
        }}
      >
        <div
          style={{
            maxWidth: 620,
            width: '100%',
            padding: 24,
            borderRadius: 'var(--radius-xl)',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            boxShadow: 'var(--elev-2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <span
              aria-hidden="true"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                flex: 'none',
                borderRadius: 999,
                background: 'var(--warn-weak)',
                color: 'var(--warn)',
                fontSize: 18,
              }}
            >
              {/* Inline glyph rather than the Icon component: this must render
                  even if the module graph is what failed. */}
              <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
                <path
                  d="M8 2.5 14.5 13.5H1.5L8 2.5ZM8 6.5v3.5m0 1.5h.01"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <div style={{ minWidth: 0 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 19,
                  lineHeight: '25px',
                  fontWeight: 600,
                  letterSpacing: '-0.022em',
                }}
              >
                {this.t('boundary.title')}
              </h1>
              <p style={{ margin: '6px 0 0', color: 'var(--text-2)' }}>{this.t('boundary.body')}</p>
            </div>
          </div>

          <pre style={{ ...codeBlock, marginTop: 18, maxHeight: 120, color: 'var(--danger)' }}>
            {error.name}: {error.message}
          </pre>

          {componentStack ? (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => this.setState({ expanded: !expanded })}
                style={{
                  ...button,
                  height: 24,
                  padding: '0 8px 0 4px',
                  border: '1px solid transparent',
                  background: 'transparent',
                  color: 'var(--text-3)',
                  fontSize: 12.5,
                }}
              >
                <span aria-hidden="true" style={{ width: 14, textAlign: 'center' }}>
                  {expanded ? '\u25be' : '\u25b8'}
                </span>
                {this.t('boundary.componentStack')}
              </button>
              {expanded ? (
                <pre
                  style={{
                    ...codeBlock,
                    marginTop: 6,
                    maxHeight: 240,
                    color: 'var(--text-2)',
                  }}
                >
                  {componentStack}
                </pre>
              ) : null}
            </div>
          ) : null}

          <div style={{ marginTop: 20, display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={this.reload}
              style={{
                ...button,
                background: 'var(--accent)',
                borderColor: 'var(--accent)',
                color: 'var(--on-accent)',
              }}
            >
              {this.t('boundary.reload')}
            </button>
            <button type="button" onClick={this.copyDetails} style={button}>
              {copied ? this.t('common.copied') : this.t('boundary.copyDetails')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
