/**
 * Monaco, bundled locally.
 *
 * `@monaco-editor/react` defaults to fetching Monaco from jsdelivr, which broke
 * the editor, the diff view and the script editor on any machine without
 * internet — unacceptable for a tool used on servers and restricted networks,
 * and a supply-chain and CSP problem besides. We import the `monaco-editor` ESM
 * build, hand it to the loader with `loader.config({ monaco })`, and wire the
 * web workers through Vite's `?worker` imports so they are emitted into our own
 * bundle. `tauri.conf.json` allows `worker-src 'self' blob:`, which is what
 * these workers need.
 *
 * Import this module once (from `main.tsx`) before any editor renders.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/** Monaco reads this global to construct workers. */
declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

export const RHAI_LANGUAGE_ID = 'rhai';

/**
 * Host functions the script sandbox exposes. Highlighted so a typo is visible
 * before the script runs.
 */
const RHAI_HOST_FUNCTIONS = [
  'ftp_list',
  'ftp_download',
  'ftp_upload',
  'ftp_mkdir',
  'ftp_delete',
  'log',
  'read_file',
  'write_file',
];

const RHAI_KEYWORDS = [
  'let',
  'const',
  'if',
  'else',
  'switch',
  'for',
  'in',
  'while',
  'loop',
  'do',
  'until',
  'break',
  'continue',
  'fn',
  'private',
  'return',
  'throw',
  'try',
  'catch',
  'import',
  'export',
  'as',
  'global',
  'this',
  'true',
  'false',
];

let configured = false;

/**
 * Register the local Monaco instance, the worker factory and the Rhai language.
 * Idempotent — safe to call from more than one entry point.
 */
export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  loader.config({ monaco });
  registerRhai(monaco);
  return monaco;
}

/**
 * A Monarch tokenizer for Rhai. The script editor was previously set to
 * `javascript`, which highlighted the wrong keywords and produced bogus
 * squiggles from the TypeScript worker on perfectly valid Rhai.
 */
function registerRhai(m: typeof monaco): void {
  if (m.languages.getLanguages().some((l) => l.id === RHAI_LANGUAGE_ID)) return;

  m.languages.register({
    id: RHAI_LANGUAGE_ID,
    extensions: ['.rhai'],
    aliases: ['Rhai', 'rhai'],
  });

  m.languages.setLanguageConfiguration(RHAI_LANGUAGE_ID, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: '`', close: '`', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
  });

  m.languages.setMonarchTokensProvider(RHAI_LANGUAGE_ID, {
    defaultToken: '',
    keywords: RHAI_KEYWORDS,
    hostFunctions: RHAI_HOST_FUNCTIONS,
    operators: [
      '=',
      '==',
      '!=',
      '<',
      '>',
      '<=',
      '>=',
      '+',
      '-',
      '*',
      '/',
      '%',
      '**',
      '&&',
      '||',
      '!',
      '&',
      '|',
      '^',
      '<<',
      '>>',
      '+=',
      '-=',
      '*=',
      '/=',
      '??',
      '=>',
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]{1,6}\})/,

    tokenizer: {
      root: [
        // Host functions before generic identifiers so they win.
        [
          /[a-zA-Z_$][\w$]*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@hostFunctions': 'support.function',
              '@default': 'identifier',
            },
          },
        ],
        { include: '@whitespace' },
        [/[{}()[\]]/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
        // Numbers: hex, binary, octal, float with exponent, decimal.
        [/0[xX][0-9A-Fa-f_]+/, 'number.hex'],
        [/0[bB][01_]+/, 'number.binary'],
        [/0[oO][0-7_]+/, 'number.octal'],
        [/\d[\d_]*\.\d[\d_]*([eE][-+]?\d+)?/, 'number.float'],
        [/\d[\d_]*([eE][-+]?\d+)?/, 'number'],
        [/[;,.]/, 'delimiter'],
        // Strings.
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/"/, { token: 'string.quote', bracket: '@open', next: '@string' }],
        [/`/, { token: 'string.quote', bracket: '@open', next: '@rawstring' }],
        [/'[^\\']'/, 'string'],
        [/'(\\.)'/, 'string'],
        [/'/, 'string.invalid'],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
      ],

      comment: [
        [/[^/*]+/, 'comment'],
        [/\/\*/, 'comment', '@push'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],

      string: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],

      rawstring: [
        [/[^`]+/, 'string'],
        [/`/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
    },
  });
}

/** Guess a Monaco language id from a file name, for the remote editor. */
export function languageForPath(path: string): string {
  const name =
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path;
  const lower = name.toLowerCase();

  const byName: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'plaintext',
    '.gitignore': 'plaintext',
    '.env': 'ini',
  };
  if (byName[lower]) return byName[lower];

  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const byExt: Record<string, string> = {
    rhai: RHAI_LANGUAGE_ID,
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    html: 'html',
    htm: 'html',
    vue: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    xml: 'xml',
    svg: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    cfg: 'ini',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    bat: 'bat',
    cmd: 'bat',
    sql: 'sql',
    py: 'python',
    rb: 'ruby',
    php: 'php',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    lua: 'lua',
    pl: 'perl',
    r: 'r',
    dart: 'dart',
    graphql: 'graphql',
    htaccess: 'plaintext',
    log: 'plaintext',
    txt: 'plaintext',
  };
  return byExt[ext] ?? 'plaintext';
}

export { monaco };
