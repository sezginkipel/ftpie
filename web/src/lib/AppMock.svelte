<script lang="ts">
  /**
   * A CSS reconstruction of the real ftpie window in its light theme, used as the
   * product shot. Rebuilding it means it cannot go stale against the next
   * release and there is no screenshot to ship.
   *
   * Every vertical dimension is stated rather than inferred — an earlier version
   * leaned on `margin-top: auto` and a bare `section` selector from the global
   * stylesheet reached in and padded the panes, floating their headers and
   * footers in the middle.
   */
  import Icon from './Icon.svelte';

  const localRows = [
    { name: 'dist', dir: true, size: '—', when: '12:04' },
    { name: 'src', dir: true, size: '—', when: '11:58' },
    { name: 'index.html', dir: false, size: '2.1 KB', when: '12:04' },
    { name: 'styles.css', dir: false, size: '18.4 KB', when: '12:04' },
    { name: 'README.md', dir: false, size: '6.0 KB', when: '09:31' }
  ];

  const remoteRows = [
    { name: 'public_html', dir: true, size: '—', when: 'Aug 22' },
    { name: 'logs', dir: true, size: '—', when: 'Aug 24' },
    { name: 'index.html', dir: false, size: '2.1 KB', when: 'Aug 22' },
    { name: 'robots.txt', dir: false, size: '81 B', when: 'Jul 03' }
  ];
</script>

<div
  class="frame"
  role="img"
  aria-label="The ftpie window: saved sites on the left, local files beside the server's files, a transfer in progress underneath, and a status bar showing an encrypted SFTP session."
>
  <div class="titlebar">
    <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="brand">ftpie</span>
    <span class="tab">deploy@example.com</span>
    <span class="grow"></span>
    <span class="newbtn">New connection</span>
  </div>

  <div class="body">
    <aside class="side">
      <p class="side-h">Saved sites</p>
      <div class="bm on">production</div>
      <div class="bm">staging</div>
      <div class="bm">backups</div>
      <p class="side-h">This computer</p>
      <div class="bm">C:</div>
      <div class="bm">Home</div>
    </aside>

    <div class="panes">
      <div class="pane-row">
        <section class="pane">
          <header class="pane-h">
            <span class="lbl">Local</span>
            <span class="path">~/site</span>
          </header>
          <div class="cols"><span>Name</span><span class="r">Size</span><span class="r">Modified</span></div>
          <div class="rows">
            {#each localRows as row (row.name)}
              <div class="row">
                <span class="nm" class:dir={row.dir}>{row.name}</span>
                <span class="r tnum">{row.size}</span>
                <span class="r tnum">{row.when}</span>
              </div>
            {/each}
          </div>
          <footer class="pane-f">3 files, 2 folders</footer>
        </section>

        <section class="pane">
          <header class="pane-h">
            <span class="lbl">Server</span>
            <span class="path">/var/www</span>
            <span class="lock"><Icon name="lock" size={11} /> sftp</span>
          </header>
          <div class="cols"><span>Name</span><span class="r">Size</span><span class="r">Modified</span></div>
          <div class="rows">
            {#each remoteRows as row (row.name)}
              <div class="row">
                <span class="nm" class:dir={row.dir}>{row.name}</span>
                <span class="r tnum">{row.size}</span>
                <span class="r tnum">{row.when}</span>
              </div>
            {/each}
          </div>
          <footer class="pane-f">2 files, 2 folders</footer>
        </section>
      </div>

      <div class="queue">
        <div class="q-h">
          <strong>Transfers</strong>
          <span class="dim">1 of 2</span>
          <span class="grow"></span>
          <span class="dim tnum">4.2 MB/s</span>
        </div>
        <div class="q-row">
          <span class="nm">styles.css</span>
          <span class="bar"><i></i></span>
          <span class="dim tnum pct">68%</span>
        </div>
        <div class="q-row dim">
          <span class="nm">index.html</span>
          <span class="waiting">Waiting</span>
        </div>
      </div>
    </div>
  </div>

  <div class="statusbar">
    <span class="lock"><Icon name="lock" size={11} /> deploy@example.com</span>
    <span class="grow"></span>
    <span class="dim">Vault unlocked</span>
    <span class="dim mono">0.1.0</span>
  </div>
</div>

<style>
  .frame {
    --f-line: #e4e4dc;
    --f-chrome: #f2f2ed;
    --f-body: #fbfbf9;
    --f-ink: #22262c;
    --f-ink-2: #6b7178;
    --f-ink-3: #969ca3;

    border: 1px solid var(--rule-strong);
    border-radius: 8px;
    overflow: hidden;
    background: var(--f-body);
    color: var(--f-ink);
    font-size: 11.5px;
    line-height: 1.45;
    box-shadow:
      0 1px 2px rgba(20, 23, 28, 0.05),
      0 22px 48px -24px rgba(20, 23, 28, 0.28);
    user-select: none;
  }

  .titlebar,
  .statusbar {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--f-chrome);
    border-bottom: 1px solid var(--f-line);
    padding: 0 11px;
    height: 32px;
  }
  .statusbar {
    border-bottom: none;
    border-top: 1px solid var(--f-line);
    height: 25px;
    font-size: 10.5px;
  }
  .dots {
    display: inline-flex;
    gap: 5px;
  }
  .dots i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #d6d6cd;
  }
  .brand {
    font-family: var(--font-display);
    font-weight: 700;
    margin-left: 4px;
  }
  .tab {
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 3px 8px;
    border-radius: 3px;
    background: var(--accent-wash);
    color: var(--accent-deep);
  }
  .newbtn {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 10.5px;
    background: var(--ink);
    color: #fff;
    padding: 4px 10px;
    border-radius: 3px;
  }
  .grow {
    flex: 1;
  }

  .body {
    display: flex;
    align-items: stretch;
    height: 322px;
  }

  .side {
    width: 138px;
    flex: none;
    border-right: 1px solid var(--f-line);
    padding: 6px 0;
    background: var(--f-chrome);
  }
  .side-h {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--f-ink-3);
    margin: 10px 0 4px;
    padding: 0 11px;
  }
  .bm {
    padding: 3px 11px;
    color: var(--f-ink-2);
  }
  .bm.on {
    background: var(--accent-wash);
    color: var(--accent-deep);
    box-shadow: inset 2px 0 0 var(--accent);
    font-weight: 500;
  }

  .panes {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .pane-row {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--f-body);
    padding: 0;
    border-top: none;
  }
  .pane + .pane {
    border-left: 1px solid var(--f-line);
  }

  .pane-h {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 27px;
    padding: 0 11px;
    border-bottom: 1px solid var(--f-line);
    background: var(--f-chrome);
  }
  .lbl {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--f-ink-3);
  }
  .path {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--f-ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lock {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--seal);
    font-family: var(--font-mono);
    font-size: 9.5px;
  }
  .statusbar .lock {
    margin-left: 0;
    font-size: 10px;
  }

  .cols,
  .row {
    display: grid;
    grid-template-columns: 1fr 60px 64px;
    gap: 8px;
    padding: 0 11px;
    align-items: center;
    height: 23px;
  }
  .cols {
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--f-ink-3);
    border-bottom: 1px solid var(--f-line);
  }
  .rows {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .row + .row {
    border-top: 1px solid #f1f1eb;
  }
  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--f-ink);
  }
  .nm.dir {
    color: var(--accent-deep);
    font-weight: 500;
  }
  .r {
    text-align: right;
    color: var(--f-ink-3);
  }
  .pane-f {
    height: 23px;
    display: flex;
    align-items: center;
    padding: 0 11px;
    border-top: 1px solid var(--f-line);
    background: var(--f-chrome);
    color: var(--f-ink-3);
    font-size: 10px;
  }

  .queue {
    border-top: 1px solid var(--f-line);
    flex: none;
  }
  .q-h {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 27px;
    padding: 0 11px;
    background: var(--f-chrome);
    border-bottom: 1px solid var(--f-line);
  }
  .q-row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 24px;
    padding: 0 11px;
  }
  .q-row .nm {
    width: 84px;
    flex: none;
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .bar {
    flex: 1;
    min-width: 50px;
    height: 4px;
    border-radius: 999px;
    background: var(--wash);
    overflow: hidden;
  }
  /* A slow crawl, so the shot reads as live without being distracting. */
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    width: 68%;
    animation: crawl 7s ease-in-out infinite;
  }
  @keyframes crawl {
    0%,
    100% {
      width: 61%;
    }
    50% {
      width: 79%;
    }
  }
  .pct {
    width: 30px;
    text-align: right;
  }
  .waiting {
    font-size: 10.5px;
  }
  .dim {
    color: var(--f-ink-3);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .tnum {
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 660px) {
    .side {
      display: none;
    }
    .pane + .pane {
      display: none;
    }
    .body {
      height: 280px;
    }
  }
</style>
