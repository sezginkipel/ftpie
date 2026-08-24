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

    const button: React.CSSProperties = {
      height: 28,
      padding: '0 12px',
      borderRadius: 4,
      border: '1px solid var(--border-strong)',
      background: 'var(--surface)',
      color: 'var(--text)',
      font: 'inherit',
      cursor: 'pointer',
    };

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          minHeight: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'var(--bg)',
          color: 'var(--text)',
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
        }}
      >
        <div style={{ maxWidth: 640, width: '100%' }}>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {this.t('boundary.title')}
          </h1>
          <p style={{ margin: '8px 0 0', color: 'var(--text-2)' }}>
            {this.t('boundary.body')}
          </p>

          <pre
            style={{
              margin: '12px 0 0',
              padding: 8,
              overflow: 'auto',
              maxHeight: 120,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--danger)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
            }}
          >
            {error.name}: {error.message}
          </pre>

          {componentStack ? (
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => this.setState({ expanded: !expanded })}
                style={{
                  ...button,
                  height: 22,
                  padding: '0 6px',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-3)',
                }}
              >
                {expanded ? '▾ ' : '▸ '}
                {this.t('boundary.componentStack')}
              </button>
              {expanded ? (
                <pre
                  style={{
                    margin: '4px 0 0',
                    padding: 8,
                    overflow: 'auto',
                    maxHeight: 240,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    borderRadius: 4,
                    border: '1px solid var(--border)',
                    background: 'var(--surface-2)',
                    color: 'var(--text-2)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                  }}
                >
                  {componentStack}
                </pre>
              ) : null}
            </div>
          ) : null}

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
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
