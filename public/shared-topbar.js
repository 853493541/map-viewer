(() => {
  const sections = [
    {
      label: 'Resources',
      pages: [
        ['/cdn-resource-browser.html', 'CDN Browser'],
        ['/client-monitor.html', 'Client Monitor'],
      ],
    },
    {
      label: 'Maps',
      pages: [
        ['/editor.html', 'Editor'],
        ['/export-reader.html', 'Export Reader'],
        ['/actor-viewer.html', 'Actor Viewer'],
        ['/mesh-inspector.html', 'Mesh Inspector'],
        ['/collision-test-mode.html', 'Collision Test'],
      ],
    },
    {
      label: 'Animation',
      pages: [
        ['/actor-animation-player.html', 'Animation Player'],
        ['/client-monitor-animation-player.html', 'Monitor Player'],
        ['/pss.html', 'PSS'],
      ],
    },
    {
      label: 'Sound',
      pages: [
        ['/ability-matcher.html', 'Ability Matcher'],
        ['/ability-tani-sound.html', 'TANI-SOUND'],
        ['/wwise-soundbanks.html', 'Soundbanks'],
      ],
    },
  ];
  const pages = sections.flatMap((section) => section.pages);

  function normalizedPath() {
    const path = window.location.pathname || '/';
    return path === '/' ? '/index.html' : path;
  }

  function findCurrentSection() {
    const current = normalizedPath();
    return sections.find((section) => section.pages.some(([href]) => href === current));
  }

  function buildNav() {
    const current = normalizedPath();
    const section = findCurrentSection();
    if (!section) return null;
    const nav = document.createElement('nav');
    nav.className = 'jx3-page-nav';
    nav.setAttribute('aria-label', section.label);
    const label = document.createElement('span');
    label.className = 'jx3-page-nav__label';
    label.textContent = section.label;
    nav.append(label);
    for (const [href, text] of section.pages) {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = text;
      if (href === current) {
        link.className = 'active';
        link.setAttribute('aria-current', 'page');
      }
      nav.append(link);
    }
    return nav;
  }

  function createHomeLink() {
    const link = document.createElement('a');
    link.className = 'jx3-topbar-home';
    link.href = '/index.html';
    link.setAttribute('aria-label', 'Home');
    link.title = 'Home';
    link.textContent = 'JX3';
    return link;
  }

  function findHost() {
    return document.querySelector('#global-header')
      || document.querySelector('.app > header')
      || document.querySelector('body > header')
      || document.querySelector('header');
  }

  function pageTitle() {
    const match = pages.find(([href]) => href === normalizedPath());
    return match?.[1] || document.title || 'JX3 Page';
  }

  function removeLegacyNav(host) {
    host.querySelectorAll('nav.page-nav, nav.nav, nav.gh-links').forEach((nav) => nav.remove());
  }

  function ensureTitle(host) {
    const existing = host.querySelector('.brand, .title, .gh-title, h1');
    if (existing) {
      existing.classList.add('jx3-topbar-title');
      existing.textContent = host.id === 'global-header' ? 'JX3 Web Map Viewer' : pageTitle();
      return existing;
    }
    const title = document.createElement('div');
    title.className = 'jx3-topbar-title';
    title.textContent = pageTitle();
    host.prepend(title);
    return title;
  }

  function installTopbar() {
    if (!document.body || document.querySelector('.jx3-page-nav')) return;
    let host = findHost();
    if (!host) {
      host = document.createElement('header');
      document.body.prepend(host);
    }
    host.classList.add('jx3-topbar-host');
    if (host.id === 'global-header') {
      host.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'jx3-topbar-title gh-title';
      title.textContent = 'JX3 Web Map Viewer';
      host.append(createHomeLink(), title);
      const nav = buildNav();
      if (nav) host.append(nav);
      return;
    }
    removeLegacyNav(host);
    const title = ensureTitle(host);
    title.insertAdjacentElement('beforebegin', createHomeLink());
    const nav = buildNav();
    if (nav) title.insertAdjacentElement('afterend', nav);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installTopbar, { once: true });
  } else {
    installTopbar();
  }
})();
