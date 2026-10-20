"""Regenerates frontend/demo.html from frontend/dashboard.html + tools/demo-shim.js.

Run after ANY change to dashboard.html:   python3 tools/build_demo.py

The demo is the real dashboard code with three things swapped: login (a fake admin session), the backend
(canned responses in demo-shim.js) and storage (a private throwaway IndexedDB reseeded on every visit).
Never edit demo.html by hand -- the next run overwrites it.
"""
import re, sys
import os
HERE = os.path.dirname(os.path.abspath(__file__))
FE = os.path.join(HERE, '..', 'frontend') + os.sep
dash = open(FE + 'dashboard.html', encoding='utf-8').read()

# 1. the sandbox shim (fake login + fake backend + private throwaway database) lives in tools/demo-shim.js
shim = open(os.path.join(HERE, 'demo-shim.js'), encoding='utf-8').read().rstrip()
# leaving the demo should go to the marketing page, not a login form
out = dash

# 2. head: demo-specific title / SEO tags instead of noindex
out = out.replace('<title>Dashboard — OKV Business Management System</title>\n<meta name="robots" content="noindex, nofollow">',
'''<title>Live Demo — OKV Business Management System</title>
<meta name="description" content="Try OKV Business Management System with sample data — explore sales, inventory, reports and more before you sign up. No account needed.">
<link rel="canonical" href="https://YOUR-DOMAIN-HERE.com/demo.html">
<meta property="og:title" content="Live Demo — OKV Business Management System">
<meta property="og:description" content="Try OKV Business Management System with sample data before you sign up. No account needed.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://YOUR-DOMAIN-HERE.com/demo.html">''')

# 3. topbar: demo badge + exit button + sample-data banner
out = out.replace('<span class="badge bg-light text-dark border" id="whoami">',
                  '<span class="badge" style="background:#c69a3d;color:#fff">LIVE DEMO</span>\n      <span class="badge bg-light text-dark border" id="whoami">')
out = out.replace('id="logoutBtn">Log out</button>', 'id="logoutBtn">Exit demo</button>')
out = out.replace('  <div id="panelHost"></div>',
'''  <div class="alert alert-warning mb-3 d-flex justify-content-between align-items-center flex-wrap gap-2" style="border-radius:10px">
    <span>Sample data — nothing you add here is saved or sent.</span>
    <a href="pricing.html" class="fw-semibold">Start your free trial →</a>
  </div>
  <div id="panelHost"></div>''', 1)
out = out.replace("document.getElementById('logoutBtn').addEventListener('click', () => { clearSession(); window.location.href = 'login.html'; });",
                  "document.getElementById('logoutBtn').addEventListener('click', () => { window.location.href = 'index.html'; });")

# 4. inject shim right after app-common.js
out = out.replace('<script src="app-common.js"></script>\n<script>',
                  '<script src="app-common.js"></script>\n<script>\n' + shim + '\n</script>\n<script>', 1)
assert 'DEMO SHIM' in out
# first paint must wait for the sample data, otherwise a first-time visitor sees an all-zero dashboard
assert out.rstrip().endswith('refreshCurrentSection();\n</script>\n</body>\n</html>')
out = out.rstrip()[:-len('refreshCurrentSection();\n</script>\n</body>\n</html>')] + 'DEMO_READY.then(() => refreshCurrentSection());\n</script>\n</body>\n</html>\n'
# demo POS cart must never collide with a real signed-in session's cart
out = out.replace("okv_pos_cart", "okv_demo_pos_cart")
# "Get started now" popup (after ~8s, once)
cta = '''<div class="modal fade" id="demoCtaModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">
  <div class="modal-header"><h5 class="modal-title">Like what you see?</h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
  <div class="modal-body"><p class="mb-2">Everything here is a working preview. Start your <strong>7-day free trial</strong> to run your own business on it — your data, your team, your reports.</p><p class="text-muted small mb-0">No card needed to start.</p></div>
  <div class="modal-footer"><button class="btn btn-outline-secondary" data-bs-dismiss="modal">Keep exploring</button><a class="btn btn-gold" href="pricing.html">Get started now</a></div>
</div></div></div>
'''
out = out.replace('<div id="printArea"></div>', cta + '<div id="printArea"></div>', 1)
out = out.replace("DEMO_READY.then(() => refreshCurrentSection());", '''DEMO_READY.then(() => refreshCurrentSection());
// One-time "Get started now" nudge ~8s in. Never interrupts: waits (and retries) while a modal is open or a field is being typed in.
(function scheduleDemoCta() {
  let shown = false;
  function tryShow() {
    if (shown) return;
    const a = document.activeElement;
    const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.id !== 'posScanInput';
    if (document.querySelector('.modal.show') || typing) { setTimeout(tryShow, 8000); return; }
    shown = true; new bootstrap.Modal(document.getElementById('demoCtaModal')).show();
  }
  setTimeout(tryShow, 8000);
})();''', 1)
# 5. gentler polling in the demo
out = out.replace('startAutoSync(30000);', 'startAutoSync(60000);')
open(FE + 'demo.html', 'w', encoding='utf-8').write(out)
print('demo rebuilt', len(out))
