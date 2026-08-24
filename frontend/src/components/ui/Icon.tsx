/**
 * Inline SVG icons. Sizing, colour and stroke all come from the `.icon` /
 * `.icon-16` classes in `globals.css` (15px and 17px at a 1.6 stroke — the old
 * 14px/1.5 read as spindly beside 13.5px text). Never set a size here ad hoc.
 * No emoji is ever used as a UI icon.
 *
 * Icons are decorative by default (`aria-hidden`), because the control around
 * them carries the accessible name. Pass a `title` only when an icon genuinely
 * stands alone.
 */
import { cn } from '../../lib/cn';

export type IconName =
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'file-text'
  | 'file-binary'
  | 'symlink'
  | 'drive'
  | 'home'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'chevron-up'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'upload'
  | 'download'
  | 'x'
  | 'check'
  | 'plus'
  | 'minus'
  | 'search'
  | 'settings'
  | 'refresh'
  | 'trash'
  | 'edit'
  | 'copy'
  | 'save'
  | 'play'
  | 'pause'
  | 'stop'
  | 'lock'
  | 'unlock'
  | 'shield'
  | 'shield-alert'
  | 'alert-triangle'
  | 'alert-circle'
  | 'info'
  | 'help'
  | 'star'
  | 'bookmark'
  | 'git-branch'
  | 'terminal'
  | 'sparkles'
  | 'panel'
  | 'list'
  | 'server'
  | 'key'
  | 'clock'
  | 'more-horizontal'
  | 'external';

/** Path data only — the wrapper supplies sizing, colour and stroke width. */
const PATHS: Record<IconName, string> = {
  folder:
    'M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z',
  'folder-open':
    'M2 11.5V4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5M2 11.5A1.5 1.5 0 0 0 3.5 13h9l2-6H4l-2 4.5Z',
  file: 'M4 2h5l3 3v9H4V2Zm5 0v3h3',
  'file-text': 'M4 2h5l3 3v9H4V2Zm5 0v3h3M6 8h4M6 10.5h4',
  'file-binary': 'M4 2h5l3 3v9H4V2Zm5 0v3h3M6 8h1v3H6m3-3h1v3H9',
  symlink: 'M6.5 9.5 12 4m0 0H8.5M12 4v3.5M4 6.5V12a1.5 1.5 0 0 0 1.5 1.5H11',
  drive: 'M2 9.5h12M3.5 9.5 5 3.5h6l1.5 6M2 9.5v3h12v-3M11.5 11h.5',
  home: 'M2.5 7 8 2.5 13.5 7M4 6v7.5h8V6M6.5 13.5v-4h3v4',
  'chevron-right': 'm6 3.5 5 4.5-5 4.5',
  'chevron-left': 'm10 3.5-5 4.5 5 4.5',
  'chevron-down': 'm3.5 6 4.5 5 4.5-5',
  'chevron-up': 'm3.5 10 4.5-5 4.5 5',
  'arrow-up': 'M8 13V3m0 0L4 7m4-4 4 4',
  'arrow-down': 'M8 3v10m0 0 4-4m-4 4-4-4',
  'arrow-left': 'M13 8H3m0 0 4-4M3 8l4 4',
  'arrow-right': 'M3 8h10m0 0-4-4m4 4-4 4',
  upload: 'M8 11V2m0 0L5 5m3-3 3 3M2.5 10v2.5A1 1 0 0 0 3.5 13.5h9a1 1 0 0 0 1-1V10',
  download: 'M8 2v9m0 0L5 8m3 3 3-3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10',
  x: 'm4 4 8 8M12 4l-8 8',
  check: 'm3 8.5 3.5 3.5L13 5',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  search: 'M11.5 11.5 14 14M2.5 7a4.5 4.5 0 1 0 9 0 4.5 4.5 0 0 0-9 0Z',
  settings:
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm5.5-2 .9-1.6-1.3-2.2-1.8.4-1.4-.9L10.6 1.5H7.4l-.3 1.8-1.4.9-1.8-.4L2.6 6l.9 1.6v.8L2.6 10l1.3 2.2 1.8-.4 1.4.9.3 1.8h3.2l.3-1.8 1.4-.9 1.8.4 1.3-2.2-.9-1.6v-.4Z',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.9-4.2M13.5 2v3.5H10',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5 5 13.5h6l.5-9M7 7v4M9 7v4',
  edit: 'M11.5 2.5 13.5 4.5 6 12H4v-2l7.5-7.5ZM10 4l2 2',
  copy: 'M5.5 5.5V3h7.5v7.5h-2.5M3 5.5h7.5V13H3V5.5Z',
  save: 'M3 3h8l2 2v8H3V3Zm2.5 0v3.5h5V3m-5 10v-4h5v4',
  play: 'M5 3.5 12 8l-7 4.5v-9Z',
  pause: 'M6 3.5v9M10 3.5v9',
  stop: 'M4 4h8v8H4z',
  lock: 'M4 7.5h8v6H4v-6ZM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5M8 10v1.5',
  unlock: 'M4 7.5h8v6H4v-6ZM5.5 7.5V5a2.5 2.5 0 0 1 4.9-.7M8 10v1.5',
  shield: 'M8 2 3 4v4c0 3 2.2 5.3 5 6 2.8-.7 5-3 5-6V4L8 2Z',
  'shield-alert': 'M8 2 3 4v4c0 3 2.2 5.3 5 6 2.8-.7 5-3 5-6V4L8 2ZM8 5.5V9m0 2h.01',
  'alert-triangle': 'M8 2.5 14.5 13.5H1.5L8 2.5ZM8 6.5v3.5m0 1.5h.01',
  'alert-circle': 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 5v3.5m0 2h.01',
  info: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 7.5V11M8 5h.01',
  help: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.2 6a1.8 1.8 0 0 1 3.6.3c0 1.2-1.8 1.4-1.8 2.7M8 11.5h.01',
  star: 'm8 2 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.8 4.2 13.8l.7-4.3-3.1-3 4.3-.6L8 2Z',
  bookmark: 'M4 2.5h8v11L8 10.5l-4 3v-11Z',
  'git-branch':
    'M5 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm6-5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5 4.5v7M5 8h3.5A2.5 2.5 0 0 0 11 5.5v-.5',
  terminal: 'M2 3h12v10H2V3Zm2.5 3 2 2-2 2M8 10.5h3.5',
  sparkles:
    'm5.5 2 1 2.5L9 5.5 6.5 6.5l-1 2.5-1-2.5L2 5.5l2.5-1L5.5 2Zm5.5 6 .8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8L11 8Z',
  panel: 'M2 3h12v10H2V3Zm4 0v10',
  list: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01',
  server: 'M2.5 3h11v4h-11V3Zm0 6h11v4h-11V9ZM5 5h.01M5 11h.01',
  key: 'M9.5 2a4.5 4.5 0 0 0-4.2 6L2 11.3V14h2.7l3.3-3.3A4.5 4.5 0 1 0 9.5 2Zm1.5 3h.01',
  clock: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 4.5V8l2.5 1.5',
  'more-horizontal': 'M4 8h.01M8 8h.01M12 8h.01',
  external: 'M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3.5H3V4.5h3.5',
};

export interface IconProps {
  name: IconName;
  /**
   * The `size` values stay `14 | 16` because call sites all over the app pass
   * them; they select the `.icon` (15px) and `.icon-16` (17px) classes.
   */
  size?: 14 | 16;
  className?: string;
  /** Provide only when the icon carries meaning nothing around it repeats. */
  title?: string;
}

export function Icon({ name, size = 14, className, title }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('icon', size === 16 && 'icon-16', className)}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
