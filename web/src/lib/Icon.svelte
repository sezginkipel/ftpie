<script lang="ts">
  /** Inline 20px line icons, so nothing is fetched and both themes inherit colour. */
  interface Props {
    name:
      | 'shield'
      | 'edit'
      | 'git'
      | 'queue'
      | 'script'
      | 'ai'
      | 'lock'
      | 'unlock'
      | 'check'
      | 'x'
      | 'arrow'
      | 'terminal';
    size?: number;
  }
  let { name, size = 20 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'shield'}
    <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  {:else if name === 'edit'}
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" />
    <path d="M14.5 6.5l3 3" />
  {:else if name === 'git'}
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="12" r="2.4" />
    <path d="M6 8.4v7.2" />
    <path d="M8.4 6h4.6a2.6 2.6 0 0 1 2.6 2.6v1" />
  {:else if name === 'queue'}
    <path d="M4 7h10" />
    <path d="M4 12h16" />
    <path d="M4 17h7" />
    <path d="M17 5l3 3-3 3" />
  {:else if name === 'script'}
    <path d="M5 4h9l5 5v11H5z" />
    <path d="M14 4v5h5" />
    <path d="M9 13l1.8 1.8L9 16.6" />
    <path d="M13 17h2.5" />
  {:else if name === 'ai'}
    <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z" />
    <path d="M18 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  {:else if name === 'lock'}
    <rect x="5" y="11" width="14" height="9" rx="1.6" />
    <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
  {:else if name === 'unlock'}
    <rect x="5" y="11" width="14" height="9" rx="1.6" />
    <path d="M8.5 11V8a3.5 3.5 0 0 1 6.4-2" />
  {:else if name === 'check'}
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  {:else if name === 'x'}
    <path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'arrow'}
    <path d="M5 12h13" />
    <path d="M13 6l6 6-6 6" />
  {:else if name === 'terminal'}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 10l2.5 2L7 14" />
    <path d="M12.5 14H17" />
  {/if}
</svg>

<style>
  svg {
    flex: none;
    display: block;
  }
</style>
