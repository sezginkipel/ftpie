<script lang="ts">
  import AppMock from '$lib/AppMock.svelte';
  import Icon from '$lib/Icon.svelte';
  import { reveal } from '$lib/reveal';
  import {
    FEATURES,
    NOT_INCLUDED,
    PROTOCOLS,
    PUBLISHED_BINARIES,
    REPO,
    SECURITY,
    SPOTLIGHTS,
    VERSION
  } from '$lib/data';

  const build = ['git clone <repo> && cd ftpie', 'npm ci --prefix frontend', 'npx --prefix frontend tauri build'];

  let copied = $state(false);
  async function copyBuild() {
    try {
      await navigator.clipboard.writeText(build.join('\n'));
      copied = true;
      setTimeout(() => (copied = false), 1800);
    } catch {
      copied = false;
    }
  }
</script>

<svelte:head>
  <title>ftpie — a transfer client that checks the server first</title>
  <meta
    name="description"
    content="Move files over FTP, FTPS and SFTP. ftpie remembers what your servers' keys look like and tells you when one changes, keeps saved passwords locked, edits remote files without overwriting anyone, and can push a git commit and take it back."
  />
  <meta property="og:title" content="ftpie" />
  <meta
    property="og:description"
    content="A transfer client that checks the server before it hands over your password."
  />
  <meta name="theme-color" content="#f7f7f4" />
</svelte:head>

<!-- ── Hero ──────────────────────────────────────────────────────────────── -->
<div class="hero">
  <div class="grid-bg" aria-hidden="true"></div>
  <div class="wrap hero-in">
    <div class="hero-copy">
      <p class="hero-tag mono">ftpie {VERSION}</p>
      <!-- Two blocks rather than hand-placed line breaks: the breaks only held
           at one specific width and turned the headline into five lines. -->
      <h1>
        <span class="ln l1">Most transfer clients will hand your password to whoever answers.</span>
        <span class="ln l2 accent">ftpie checks first.</span>
      </h1>
      <p class="hero-lede">
        It moves files over FTP, FTPS and SFTP, opens them in a proper editor, and pushes a git
        commit to your server when you're ready. Saved passwords stay locked. If a server's
        fingerprint changes, you hear about it before anything is sent.
      </p>
      <div class="hero-cta">
        <a class="btn btn-primary" href="#try">Try it <Icon name="arrow" size={16} /></a>
        <a class="btn btn-ghost" href="#checks">What it checks</a>
      </div>
    </div>

    <!-- Above the fold, so it animates on load with the headline rather than
         waiting on a scroll observer. -->
    <div class="hero-shot">
      <AppMock />
    </div>
  </div>

  <div class="wrap">
    <ul class="spec">
      <li><span class="mono">FTP · FTPS · SFTP</span><em>Four transports</em></li>
      <li><span class="mono">AES-256-GCM</span><em>Vault at rest</em></li>
      <li><span class="mono">Rust</span><em>Core</em></li>
      <li><span class="mono">Apache-2.0</span><em>License</em></li>
    </ul>
  </div>
</div>

<!-- ── Connections ───────────────────────────────────────────────────────── -->
<section id="connects">
  <div class="wrap">
    <div class="sec-head" data-reveal use:reveal>
      <p class="tag">What it connects to</p>
      <h2>Four transports, and no quiet fallbacks.</h2>
      <p class="sec-lede">
        Everything here is implemented. Nothing on this list downgrades itself to something weaker
        when the handshake gets awkward.
      </p>
    </div>

    <div class="table" data-reveal use:reveal={80}>
      {#each PROTOCOLS as p, i (p.name)}
        <div class="trow" class:plain={!p.encrypted}>
          <span class="tname">{p.name}</span>
          <span class="tport mono">:{p.port}</span>
          <span class="thow">{p.how}</span>
          <span class="tseal">
            <span class="seal {p.encrypted ? 'seal-ok' : 'seal-no'}">
              <Icon name={p.encrypted ? 'lock' : 'unlock'} size={11} />
              {p.encrypted ? 'encrypted' : 'cleartext'}
            </span>
          </span>
        </div>
        {#if i === PROTOCOLS.length - 1}
          <p class="tnote">
            Plain FTP is supported because plenty of hosts still offer nothing else. It is never
            presented as fine.
          </p>
        {/if}
      {/each}
    </div>
  </div>
</section>

<!-- ── Security ──────────────────────────────────────────────────────────── -->
<section id="checks">
  <div class="wrap">
    <div class="sec-head" data-reveal use:reveal>
      <p class="tag">Before anything is sent</p>
      <h2>The check most clients skip.</h2>
      <p class="sec-lede">
        Accepting any certificate and any host key is a common default. It leaves you with
        encryption and no idea who you're encrypting to, which is no help at all against someone
        sitting between you and your server.
      </p>
    </div>

    <div class="moments">
      <figure class="moment" data-reveal use:reveal={60}>
        <figcaption><span class="step mono">01</span> First time you connect</figcaption>
        <div class="dlg">
          <p class="dlg-h">Unrecognised host key</p>
          <p class="dlg-b">deploy@example.com wants to identify itself with:</p>
          <code class="fp">SHA256:qh8Xk2mPvT4rL9wZ1cN6bF3sJdA7yE0uH5gR2iQoK8M</code>
          <div class="dlg-row">
            <span class="dlg-btn ghost">Cancel</span>
            <span class="dlg-btn">Trust this server</span>
          </div>
        </div>
        <p class="m-note">Nothing has been sent yet. Your password waits for this answer.</p>
      </figure>

      <div class="joint" aria-hidden="true"><span></span></div>

      <figure class="moment alarm" data-reveal use:reveal={180}>
        <figcaption><span class="step mono">02</span> If it ever changes</figcaption>
        <div class="dlg warn">
          <p class="dlg-h">This key is not the one you trusted</p>
          <p class="dlg-b">Someone may be sitting in the middle of this connection.</p>
          <code class="fp was">was qh8Xk2mP…iQoK8M</code>
          <code class="fp now">now 7dLm4Xq9…pW2vRt</code>
          <div class="dlg-row">
            <span class="dlg-btn solid">Cancel</span>
            <span class="dlg-btn ghost quiet">Trust the new key</span>
          </div>
        </div>
        <p class="m-note">Cancel is the obvious button. This is not a dialog to dismiss by reflex.</p>
      </figure>
    </div>

    <div class="sec-list">
      {#each SECURITY as s, i (s.label)}
        <div class="sitem" data-reveal use:reveal={60 + i * 70}>
          <h3>{s.label}</h3>
          <p>{s.body}</p>
        </div>
      {/each}
    </div>
  </div>
</section>

<!-- ── Features ──────────────────────────────────────────────────────────── -->
<section id="does">
  <div class="wrap">
    <div class="sec-head" data-reveal use:reveal>
      <p class="tag">Past the file copy</p>
      <h2>Dragging files is the easy part.</h2>
      <p class="sec-lede">
        The work is knowing what changed, not stepping on a colleague, and being able to undo it.
      </p>
    </div>

    <!-- Spotlight one: conflict-aware save -->
    <div class="spot" data-reveal use:reveal={60}>
      <div class="spot-copy">
        <span class="s-ico"><Icon name={SPOTLIGHTS[0].icon} /></span>
        <h3>{SPOTLIGHTS[0].title}</h3>
        <p>{SPOTLIGHTS[0].body}</p>
      </div>
      <div class="spot-art">
        <div class="diff">
          <p class="diff-h mono">config.yml — changed on the server</p>
          <div class="dl ctx"><span class="gut mono">12</span><span>workers: 4</span></div>
          <div class="dl del"><span class="gut mono">13</span><span>- timeout: 30</span></div>
          <div class="dl add"><span class="gut mono">13</span><span>+ timeout: 90</span></div>
          <div class="dl ctx"><span class="gut mono">14</span><span>retries: 2</span></div>
          <div class="diff-f">
            <span class="dlg-btn ghost">Keep theirs</span>
            <span class="dlg-btn">Keep mine</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Spotlight two: deploy plan -->
    <div class="spot flip" data-reveal use:reveal={60}>
      <div class="spot-copy">
        <span class="s-ico"><Icon name={SPOTLIGHTS[1].icon} /></span>
        <h3>{SPOTLIGHTS[1].title}</h3>
        <p>{SPOTLIGHTS[1].body}</p>
      </div>
      <div class="spot-art">
        <div class="plan">
          <p class="plan-h mono">main @ 4f2a1c → /var/www</p>
          <div class="pl up"><span class="pi">↑</span>dist/app.4f2a1c.js<span class="ps mono">142 KB</span></div>
          <div class="pl up"><span class="pi">↑</span>index.html<span class="ps mono">2.1 KB</span></div>
          <div class="pl del"><span class="pi">×</span>dist/app.9b0e77.js<span class="ps mono">delete</span></div>
          <div class="pl del"><span class="pi">×</span>old/legacy.css<span class="ps mono">delete</span></div>
          <div class="plan-f">
            <span class="mono">2 up, 2 removed</span>
            <span class="dlg-btn">Deploy</span>
          </div>
        </div>
      </div>
    </div>

    <div class="feat">
      {#each FEATURES as f, i (f.title)}
        <div class="fitem" data-reveal use:reveal={40 + i * 60}>
          <span class="f-ico"><Icon name={f.icon} size={18} /></span>
          <h3>{f.title}</h3>
          <p>{f.body}</p>
        </div>
      {/each}
    </div>

    <p class="honest" data-reveal use:reveal>
      One thing worth saying: turning up the transfer concurrency helps when you're pushing to
      several servers. Two files on the same connection still take turns, because that's how a
      single control connection works. The app says so rather than pretending.
    </p>
  </div>
</section>

<!-- ── Limits ────────────────────────────────────────────────────────────── -->
<section id="wont">
  <div class="wrap">
    <div class="sec-head" data-reveal use:reveal>
      <p class="tag">Limits</p>
      <h2>What it won't do.</h2>
      <p class="sec-lede">
        A feature list is only worth reading if the gaps are in it too. Some of these were taken out
        because they couldn't be made safe.
      </p>
    </div>

    <ul class="wont-list">
      {#each NOT_INCLUDED as item, i (item.name)}
        <li data-reveal use:reveal={30 + i * 45}>
          <strong>{item.name}</strong>
          <p>{item.reason}</p>
        </li>
      {/each}
    </ul>
  </div>
</section>

<!-- ── Try it ────────────────────────────────────────────────────────────── -->
<section id="try">
  <div class="wrap">
    <div class="sec-head" data-reveal use:reveal>
      <p class="tag">Try it</p>
      <h2>Build it in about five minutes.</h2>
      <p class="sec-lede">
        {#if PUBLISHED_BINARIES}
          Signed installers are available for Windows, macOS and Linux.
        {:else}
          There's no installer to download yet. Release signing isn't set up, and passing around
          unsigned installers is the same trust problem this whole app is about. So: from source.
        {/if}
      </p>
    </div>

    <div class="term" data-reveal use:reveal={60}>
      <div class="term-h">
        <span class="mono">Windows · macOS · Linux</span>
        <button class="copy" onclick={copyBuild} type="button">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre><code>{#each build as line, i (line)}<span class="pr">$</span>{line}{i < build.length - 1 ? '\n' : ''}{/each}</code></pre>
      <p class="term-f">
        You'll need Rust, Node 20 or newer, and a C toolchain. On Windows the MSVC toolchain is
        required to produce installers — the README covers that and a path-with-spaces trap that
        breaks MinGW builds.
      </p>
    </div>

    {#if REPO}
      <a class="btn btn-ghost src-link" href={REPO}>Read the source</a>
    {/if}
  </div>
</section>

<style>
  /* ── Hero ─────────────────────────────────────────────────────────────── */
  .hero {
    position: relative;
    padding: 76px 0 0;
    overflow: hidden;
  }
  /* Drafting paper, fading out so it never competes with the text. */
  .grid-bg {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(to right, var(--rule) 1px, transparent 1px),
      linear-gradient(to bottom, var(--rule) 1px, transparent 1px);
    background-size: 34px 34px;
    mask-image: radial-gradient(120% 90% at 78% 12%, #000 0%, transparent 68%);
    opacity: 0.55;
    pointer-events: none;
  }
  .hero-in {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.04fr);
    gap: 52px;
    align-items: center;
    padding-bottom: 68px;
  }

  .hero-tag {
    font-size: 11.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-3);
    margin: 0 0 22px;
  }

  h1 {
    font-size: clamp(1.95rem, 3.9vw, 3rem);
    letter-spacing: -0.035em;
    margin-bottom: 26px;
    text-wrap: balance;
  }
  .ln {
    display: block;
    animation: rise 720ms cubic-bezier(0.2, 0.7, 0.3, 1) both;
  }
  .l1 {
    animation-delay: 40ms;
  }
  .l2 {
    animation-delay: 200ms;
    margin-top: 0.12em;
  }
  .accent {
    color: var(--accent);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(16px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  .hero-lede {
    color: var(--ink-2);
    font-size: 1.08rem;
    max-width: 52ch;
    margin: 0 0 30px;
    animation: rise 720ms cubic-bezier(0.2, 0.7, 0.3, 1) 420ms both;
  }
  .hero-cta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    animation: rise 720ms cubic-bezier(0.2, 0.7, 0.3, 1) 520ms both;
  }

  /* Let the window bleed past the container on wide screens. */
  .hero-shot {
    margin-right: calc(-1 * min(7vw, 90px));
    animation: shot-in 900ms cubic-bezier(0.2, 0.7, 0.3, 1) 260ms both;
  }
  @keyframes shot-in {
    from {
      opacity: 0;
      transform: translateY(20px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  .spec {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-top: 1px solid var(--rule);
    position: relative;
  }
  .spec li {
    padding: 20px 22px 22px 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .spec li + li {
    border-left: 1px solid var(--rule);
    padding-left: 22px;
  }
  .spec span {
    font-size: 12.5px;
    color: var(--ink);
  }
  .spec em {
    font-style: normal;
    font-size: 11.5px;
    color: var(--ink-3);
  }

  /* ── Protocol table ───────────────────────────────────────────────────── */
  .table {
    margin-top: 40px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--card);
    overflow: hidden;
  }
  .trow {
    display: grid;
    grid-template-columns: 148px 62px 1fr auto;
    gap: 18px;
    align-items: center;
    padding: 17px 22px;
    transition: background 140ms ease;
  }
  .trow + .trow {
    border-top: 1px solid var(--rule);
  }
  .trow:hover {
    background: var(--wash);
  }
  .trow.plain {
    background: var(--alert-wash);
  }
  .tname {
    font-family: var(--font-display);
    font-weight: 600;
  }
  .tport {
    font-size: 12px;
    color: var(--ink-3);
  }
  .thow {
    color: var(--ink-2);
    font-size: 0.94rem;
  }
  .tnote {
    margin: 0;
    padding: 14px 22px;
    border-top: 1px solid var(--rule);
    background: var(--wash);
    color: var(--ink-3);
    font-size: 0.87rem;
  }

  /* ── Security moments ─────────────────────────────────────────────────── */
  .moments {
    display: grid;
    grid-template-columns: 1fr 44px 1fr;
    gap: 0;
    align-items: start;
    margin: 44px 0 0;
  }
  .moment {
    margin: 0;
  }
  .moment figcaption {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.95rem;
    margin-bottom: 14px;
  }
  .step {
    font-size: 11px;
    color: var(--ink-3);
    font-weight: 400;
  }
  .joint {
    display: grid;
    place-items: center;
    align-self: center;
    height: 100%;
  }
  .joint span {
    display: block;
    width: 100%;
    height: 1px;
    background: repeating-linear-gradient(
      to right,
      var(--rule-strong) 0 4px,
      transparent 4px 8px
    );
  }

  .dlg {
    border: 1px solid var(--rule-strong);
    border-radius: 5px;
    background: var(--card);
    padding: 18px;
    box-shadow: 0 10px 26px -18px rgba(20, 23, 28, 0.35);
  }
  .dlg.warn {
    border-color: color-mix(in srgb, var(--alert) 42%, var(--rule-strong));
    background: var(--alert-wash);
  }
  .dlg-h {
    font-family: var(--font-display);
    font-weight: 650;
    font-size: 1rem;
    margin: 0 0 6px;
  }
  .dlg.warn .dlg-h {
    color: var(--alert);
  }
  .dlg-b {
    margin: 0 0 12px;
    color: var(--ink-2);
    font-size: 0.9rem;
  }
  .fp {
    display: block;
    font-size: 11px;
    color: var(--ink-2);
    background: var(--wash);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 7px 9px;
    overflow-x: auto;
    white-space: nowrap;
  }
  .fp + .fp {
    margin-top: 6px;
  }
  .fp.was {
    color: var(--ink-3);
    text-decoration: line-through;
  }
  .fp.now {
    color: var(--alert);
    border-color: color-mix(in srgb, var(--alert) 30%, var(--rule));
    background: #fff;
  }
  .dlg-row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 14px;
  }
  .dlg-btn {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 11.5px;
    padding: 6px 12px;
    border-radius: 3px;
    background: var(--ink);
    color: var(--paper);
    white-space: nowrap;
  }
  .dlg-btn.ghost {
    background: transparent;
    border: 1px solid var(--rule-strong);
    color: var(--ink-2);
  }
  .dlg-btn.solid {
    background: var(--alert);
    color: #fff;
  }
  .dlg-btn.quiet {
    color: var(--ink-3);
  }
  .m-note {
    margin: 12px 0 0;
    font-size: 0.87rem;
    color: var(--ink-3);
  }

  .sec-list {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    margin-top: 56px;
    border-top: 1px solid var(--rule);
  }
  .sitem {
    padding: 26px 24px 0 0;
  }
  .sitem + .sitem {
    border-left: 1px solid var(--rule);
    padding-left: 24px;
  }
  .sitem h3 {
    font-size: 1rem;
    margin-bottom: 8px;
  }
  .sitem p {
    margin: 0;
    color: var(--ink-2);
    font-size: 0.93rem;
  }

  /* ── Spotlights ───────────────────────────────────────────────────────── */
  .spot {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 52px;
    align-items: center;
    margin-top: 52px;
    padding-top: 52px;
    border-top: 1px solid var(--rule);
  }
  .spot.flip .spot-copy {
    order: 2;
  }
  .s-ico {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    background: var(--ink);
    color: var(--paper);
    margin-bottom: 16px;
  }
  .spot-copy h3 {
    font-size: clamp(1.2rem, 2.2vw, 1.5rem);
    margin-bottom: 12px;
    max-width: 22ch;
  }
  .spot-copy p {
    margin: 0;
    color: var(--ink-2);
    max-width: 48ch;
  }

  .diff,
  .plan {
    border: 1px solid var(--rule-strong);
    border-radius: 5px;
    background: var(--card);
    overflow: hidden;
    font-size: 12px;
    box-shadow: 0 10px 26px -20px rgba(20, 23, 28, 0.3);
  }
  .diff-h,
  .plan-h {
    margin: 0;
    padding: 10px 14px;
    border-bottom: 1px solid var(--rule);
    background: var(--wash);
    font-size: 10.5px;
    color: var(--ink-3);
  }
  .dl {
    display: flex;
    gap: 12px;
    padding: 4px 14px;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .gut {
    color: var(--ink-3);
    width: 18px;
    flex: none;
    text-align: right;
  }
  .dl.del {
    background: var(--alert-wash);
    color: var(--alert);
  }
  .dl.add {
    background: var(--seal-wash);
    color: var(--seal);
  }
  .diff-f,
  .plan-f {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid var(--rule);
    background: var(--wash);
  }
  .plan-f {
    justify-content: space-between;
  }
  .plan-f .mono {
    font-size: 11px;
    color: var(--ink-3);
  }
  .pl {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .pl + .pl {
    border-top: 1px solid #f2f2ec;
  }
  .pi {
    width: 12px;
    flex: none;
    text-align: center;
  }
  .pl.up .pi {
    color: var(--seal);
  }
  .pl.del {
    color: var(--ink-3);
  }
  .pl.del .pi {
    color: var(--alert);
  }
  .ps {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--ink-3);
  }

  /* ── Feature grid ─────────────────────────────────────────────────────── */
  .feat {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    margin-top: 56px;
    border-top: 1px solid var(--rule);
  }
  .fitem {
    padding: 26px 22px 0 0;
  }
  .fitem + .fitem {
    border-left: 1px solid var(--rule);
    padding-left: 22px;
  }
  .f-ico {
    display: block;
    color: var(--accent);
    margin-bottom: 12px;
  }
  .fitem h3 {
    font-size: 0.98rem;
    margin-bottom: 7px;
  }
  .fitem p {
    margin: 0;
    color: var(--ink-2);
    font-size: 0.9rem;
  }

  .honest {
    margin: 52px 0 0;
    padding-left: 16px;
    border-left: 2px solid var(--rule-strong);
    color: var(--ink-3);
    font-size: 0.92rem;
    max-width: 74ch;
  }

  /* ── Limits ───────────────────────────────────────────────────────────── */
  .wont-list {
    list-style: none;
    margin: 40px 0 0;
    padding: 0;
    border-top: 1px solid var(--rule);
  }
  .wont-list li {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 24px;
    padding: 20px 0;
    border-bottom: 1px solid var(--rule);
    transition: padding-left 160ms ease;
  }
  .wont-list li:hover {
    padding-left: 8px;
  }
  .wont-list strong {
    font-family: var(--font-display);
    font-weight: 600;
    color: var(--ink-3);
    text-decoration: line-through;
    text-decoration-color: var(--rule-strong);
  }
  .wont-list p {
    margin: 0;
    color: var(--ink-2);
    font-size: 0.94rem;
  }

  /* ── Terminal ─────────────────────────────────────────────────────────── */
  .term {
    margin-top: 40px;
    border: 1px solid var(--rule-strong);
    border-radius: 5px;
    overflow: hidden;
    background: var(--card);
    max-width: 780px;
  }
  .term-h {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 15px;
    border-bottom: 1px solid var(--rule);
    background: var(--wash);
    font-size: 11px;
    color: var(--ink-3);
  }
  .copy {
    font-family: var(--font-mono);
    font-size: 10.5px;
    background: transparent;
    border: 1px solid var(--rule-strong);
    color: var(--ink-2);
    padding: 4px 11px;
    border-radius: 3px;
    cursor: pointer;
    transition: all 140ms ease;
  }
  .copy:hover {
    border-color: var(--ink);
    color: var(--ink);
  }
  pre {
    margin: 0;
    padding: 18px 15px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 2;
    color: var(--ink);
  }
  .pr {
    color: var(--ink-3);
    user-select: none;
    margin-right: 10px;
  }
  .term-f {
    margin: 0;
    padding: 14px 15px;
    border-top: 1px solid var(--rule);
    color: var(--ink-3);
    font-size: 0.86rem;
  }
  .src-link {
    margin-top: 22px;
  }

  /* ── Responsive ───────────────────────────────────────────────────────── */
  @media (max-width: 1000px) {
    .hero-in {
      grid-template-columns: 1fr;
      gap: 42px;
    }
    .hero-shot {
      margin-right: 0;
    }
    .moments {
      grid-template-columns: 1fr;
      gap: 34px;
    }
    .joint {
      display: none;
    }
    .spot,
    .spot.flip {
      grid-template-columns: 1fr;
      gap: 30px;
    }
    .spot.flip .spot-copy {
      order: 0;
    }
    .sec-list,
    .feat {
      grid-template-columns: repeat(2, 1fr);
    }
    .sitem:nth-child(3),
    .fitem:nth-child(3) {
      border-left: none;
      padding-left: 0;
      border-top: 1px solid var(--rule);
      margin-top: 26px;
    }
  }

  @media (max-width: 640px) {
    .spec {
      grid-template-columns: repeat(2, 1fr);
    }
    .spec li:nth-child(3) {
      border-left: none;
      padding-left: 0;
    }
    .trow {
      grid-template-columns: 1fr auto;
      row-gap: 8px;
    }
    .tport,
    .thow {
      grid-column: 1 / -1;
    }
    .sec-list,
    .feat {
      grid-template-columns: 1fr;
    }
    .sitem + .sitem,
    .fitem + .fitem {
      border-left: none;
      padding-left: 0;
      border-top: 1px solid var(--rule);
      margin-top: 24px;
    }
    .wont-list li {
      grid-template-columns: 1fr;
      gap: 6px;
    }
  }
</style>
