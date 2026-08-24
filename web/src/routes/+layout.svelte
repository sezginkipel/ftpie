<script lang="ts">
  import '../app.css';
  import { LICENSE, REPO, VERSION } from '$lib/data';

  let { children } = $props();

  const links = [
    { href: '#connects', label: 'Connections' },
    { href: '#checks', label: 'Security' },
    { href: '#does', label: 'Features' },
    { href: '#wont', label: 'Limits' },
    { href: '#try', label: 'Try it' }
  ];
</script>

<a class="skip" href="#main">Skip to content</a>

<header class="nav">
  <div class="wrap nav-in">
    <a class="logo" href="/" aria-label="ftpie, home">
      <span class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 19V6" /><path d="M4.5 9.5L8 6l3.5 3.5" />
          <path d="M16 5v13" /><path d="M19.5 14.5L16 18l-3.5-3.5" />
        </svg>
      </span>
      <span class="word">ftpie</span>
    </a>

    <nav aria-label="Sections">
      {#each links as link (link.href)}
        <a href={link.href}>{link.label}</a>
      {/each}
    </nav>
  </div>
</header>

<main id="main">
  {@render children()}
</main>

<footer class="foot">
  <div class="wrap foot-in">
    <div>
      <p class="ft-name">ftpie</p>
      <p class="ft-sub">A file transfer client for people who deploy things.</p>
    </div>
    <div class="ft-meta">
      <span class="mono">v{VERSION}</span>
      <span class="mono">{LICENSE}</span>
      {#if REPO}<a href={REPO}>Source</a>{/if}
    </div>
  </div>
</footer>

<style>
  .skip {
    position: absolute;
    left: -9999px;
    background: var(--ink);
    color: var(--paper);
    padding: 10px 16px;
    z-index: 100;
    font-weight: 600;
  }
  .skip:focus {
    left: 10px;
    top: 10px;
  }

  .nav {
    position: sticky;
    top: 0;
    z-index: 50;
    background: color-mix(in srgb, var(--paper) 86%, transparent);
    backdrop-filter: blur(12px) saturate(1.4);
    border-bottom: 1px solid var(--rule);
  }
  .nav-in {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 28px;
    height: 62px;
  }

  .logo {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--ink);
  }
  .mark {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 5px;
    background: var(--ink);
    color: var(--paper);
  }
  .mark svg {
    width: 15px;
    height: 15px;
  }
  .word {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.1rem;
    letter-spacing: -0.03em;
  }

  nav {
    display: flex;
    gap: 26px;
    font-size: 0.93rem;
  }
  nav a {
    color: var(--ink-2);
    position: relative;
    padding: 2px 0;
  }
  /* An underline that draws in, rather than a colour swap. */
  nav a::after {
    content: '';
    position: absolute;
    left: 0;
    bottom: -1px;
    height: 1px;
    width: 100%;
    background: var(--ink);
    transform: scaleX(0);
    transform-origin: left;
    transition: transform 200ms cubic-bezier(0.22, 0.68, 0.32, 1);
  }
  nav a:hover {
    color: var(--ink);
  }
  nav a:hover::after {
    transform: scaleX(1);
  }

  .foot {
    border-top: 1px solid var(--rule);
    padding: 40px 0 64px;
  }
  .foot-in {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
  }
  .ft-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.15rem;
    letter-spacing: -0.03em;
    margin: 0;
  }
  .ft-sub {
    margin: 4px 0 0;
    color: var(--ink-3);
    font-size: 0.92rem;
  }
  .ft-meta {
    display: flex;
    gap: 18px;
    font-size: 12px;
    color: var(--ink-3);
  }

  @media (max-width: 780px) {
    nav {
      display: none;
    }
  }
</style>
