function setupHeaderMenu(container) {
  const menu = container.querySelector('[data-nav-menu]');
  const toggle = container.querySelector('[data-nav-toggle]');
  if (!menu || !toggle) return;

  let open = false;
  const media = window.matchMedia ? window.matchMedia('(max-width: 860px)') : null;

  const setOpen = (value) => {
    open = Boolean(value);
    menu.classList.toggle('is-open', open);
    toggle.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('nav-menu-open', open);
  };

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(!open);
  });

  document.addEventListener('click', (event) => {
    if (!open) return;
    if (container.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      setOpen(false);
    }
  });

  menu.querySelectorAll('a, button').forEach((node) => {
    node.addEventListener('click', () => {
      if (media && !media.matches) return;
      window.setTimeout(() => setOpen(false), 0);
    });
  });

  if (media) {
    const handleMediaChange = (event) => {
      if (!event.matches) setOpen(false);
    };
    if (media.addEventListener) {
      media.addEventListener('change', handleMediaChange);
    } else if (media.addListener) {
      media.addListener(handleMediaChange);
    }
  }
}

async function loadFunctionHeader() {
  const container = document.getElementById('app-header');
  if (!container) return;
  try {
    const res = await fetch('/static/common/html/function-header.html?v=1.6.1');
    if (!res.ok) return;
    container.innerHTML = await res.text();
    const logoutBtn = container.querySelector('#function-logout-btn');
    if (logoutBtn) {
      logoutBtn.classList.add('hidden');
      try {
        const verify = await fetch('/v1/function/verify', { method: 'GET' });
        if (verify.status === 401) {
          logoutBtn.classList.remove('hidden');
        }
      } catch (e) {
        // Ignore verification errors and keep it hidden
      }
    }
    if (window.I18n) {
      I18n.applyToDOM(container);
      var toggle = container.querySelector('#lang-toggle');
      if (toggle) toggle.textContent = I18n.getLang() === 'zh' ? 'EN' : '中';
    }
    const path = window.location.pathname;
    const links = container.querySelectorAll('a[data-nav]');
    links.forEach((link) => {
      const target = link.getAttribute('data-nav') || '';
      if (target && path.startsWith(target)) {
        link.classList.add('active');
      }
    });
    setupHeaderMenu(container);
  } catch (e) {
    // Fail silently to avoid breaking page load
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadFunctionHeader);
} else {
  loadFunctionHeader();
}
