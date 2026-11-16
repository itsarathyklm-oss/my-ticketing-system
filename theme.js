// theme.js - dark mode for every page.
// The device setting decides by default; My Profile can pin Light or Dark, and that
// choice is remembered per browser. The attribute is set before the page paints so
// there is no white flash when dark mode is active.
(function () {
    var KEY = 'sarathyTheme';
    var root = document.documentElement;
    var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    var DARK = {
        bg: '#0e1319',
        surface: '#161d26',
        surface2: '#1b232d',
        border: '#2a3441',
        text: '#e4ebf3',
        muted: '#9aa8b8',
        dim: '#7c8b9c'
    };

    var CSS = [
        'html[data-theme="dark"]{color-scheme:dark;background:' + DARK.bg + ';}',

        // ---- shell -------------------------------------------------------
        // background-color (not the background shorthand) so pages that paint a
        // background image, like the login and submit forms, keep their photo.
        'html[data-theme="dark"] body{background-color:' + DARK.bg + ' !important;color:' + DARK.text + ' !important;}',
        'html[data-theme="dark"] .main-content{background:' + DARK.bg + ' !important;scrollbar-color:#3a4757 ' + DARK.bg + ';}',
        'html[data-theme="dark"] .top-navbar{background:#131a22 !important;border-bottom-color:#232d39 !important;}',
        'html[data-theme="dark"] .page-title{color:' + DARK.text + ' !important;}',
        'html[data-theme="dark"] .hamburger-btn span{background:#cbd5e0 !important;}',
        'html[data-theme="dark"] .notification-btn{background:#1a222c !important;border-color:' + DARK.border + ' !important;color:#cbd5e0 !important;}',
        'html[data-theme="dark"] .notification-btn:hover{background:#202a35 !important;}',
        'html[data-theme="dark"] .content-body{background:transparent !important;}',

        // ---- panels and cards -------------------------------------------
        'html[data-theme="dark"] .metric-card,',
        'html[data-theme="dark"] .branch-panel-card,',
        'html[data-theme="dark"] .chart-card,',
        'html[data-theme="dark"] .ticket-card,',
        'html[data-theme="dark"] .inbox-card,',
        'html[data-theme="dark"] .assignment-info,',
        'html[data-theme="dark"] .comments-section,',
        'html[data-theme="dark"] .confirm-box,',
        'html[data-theme="dark"] .admin-toast,',
        'html[data-theme="dark"] .notification-menu,',
        'html[data-theme="dark"] .staff-popover{background:' + DARK.surface + ' !important;border-color:' + DARK.border + ' !important;color:' + DARK.text + ' !important;box-shadow:0 10px 30px rgba(0,0,0,.55) !important;}',
        'html[data-theme="dark"] .ticket-card.ticket-escalated{background:#1d1a14 !important;}',
        'html[data-theme="dark"] .ticket-card.ticket-high-priority{background:#211518 !important;border-color:#7f2b2b !important;}',

        // ---- text --------------------------------------------------------
        'html[data-theme="dark"] .metric-label,html[data-theme="dark"] .metric-subtitle,',
        'html[data-theme="dark"] .assignment-label,html[data-theme="dark"] .comments-header,',
        'html[data-theme="dark"] .inbox-meta,html[data-theme="dark"] .staff-pop-meta,',
        'html[data-theme="dark"] .pagination-info,html[data-theme="dark"] .form-subtitle{color:' + DARK.dim + ' !important;}',
        'html[data-theme="dark"] .metric-value,html[data-theme="dark"] .ticket-title,',
        'html[data-theme="dark"] .ticket-desc,html[data-theme="dark"] .assignment-value,',
        'html[data-theme="dark"] .comment-item,html[data-theme="dark"] .comment-item strong,',
        'html[data-theme="dark"] .inbox-subject,html[data-theme="dark"] .inbox-body,',
        'html[data-theme="dark"] .branch-panel-card h2,html[data-theme="dark"] .branch-panel-card h3,',
        'html[data-theme="dark"] .chart-card h3,html[data-theme="dark"] .staff-pop-name,',
        'html[data-theme="dark"] .staff-pop-row,html[data-theme="dark"] .notification-item,',
        'html[data-theme="dark"] .notification-item strong,html[data-theme="dark"] .admin-toast-title{color:' + DARK.text + ' !important;}',
        'html[data-theme="dark"] .staff-pop-foot,html[data-theme="dark"] .staff-pop-head,',
        'html[data-theme="dark"] .admin-toast-message,html[data-theme="dark"] .staff-pop-empty,',
        'html[data-theme="dark"] .notification-empty{color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] .staff-pop-head,html[data-theme="dark"] .staff-pop-foot{background:#131a22 !important;border-color:' + DARK.border + ' !important;}',
        'html[data-theme="dark"] .staff-pop-row{border-bottom-color:#202a35 !important;}',
        'html[data-theme="dark"] .notification-item{border-bottom-color:#202a35 !important;}',
        'html[data-theme="dark"] .notification-item.unread{background:#16222e !important;}',
        'html[data-theme="dark"] .notification-head{border-bottom-color:' + DARK.border + ' !important;color:' + DARK.text + ' !important;}',
        'html[data-theme="dark"] .assignment-row + .assignment-row{border-top-color:#222c38 !important;}',
        'html[data-theme="dark"] .comment-item{border-bottom-color:#222c38 !important;}',

        // ---- form controls ----------------------------------------------
        'html[data-theme="dark"] input:not([type="checkbox"]):not([type="radio"]),',
        'html[data-theme="dark"] select,html[data-theme="dark"] textarea{background:#10161d !important;color:' + DARK.text + ' !important;border-color:#33414f !important;}',
        'html[data-theme="dark"] input::placeholder,html[data-theme="dark"] textarea::placeholder{color:#6f7f90 !important;}',
        'html[data-theme="dark"] input:focus,html[data-theme="dark"] select:focus,html[data-theme="dark"] textarea:focus{background:#0c1117 !important;border-color:#4b8bd6 !important;}',
        'html[data-theme="dark"] .comment-attach-btn{background:#1b232d !important;border-color:' + DARK.border + ' !important;color:' + DARK.text + ' !important;}',
        'html[data-theme="dark"] .attachment-name-tag{color:' + DARK.muted + ' !important;}',

        // ---- tables ------------------------------------------------------
        'html[data-theme="dark"] .branch-table th{background:#111820 !important;color:' + DARK.muted + ' !important;border-bottom-color:' + DARK.border + ' !important;}',
        'html[data-theme="dark"] .branch-table td{color:' + DARK.text + ' !important;border-bottom-color:#202a35 !important;}',
        'html[data-theme="dark"] .branch-table.tbl-cards tr{background:' + DARK.surface + ' !important;border-color:' + DARK.border + ' !important;}',
        'html[data-theme="dark"] .branch-table.tbl-cards td[data-label]::before{color:' + DARK.dim + ' !important;}',
        'html[data-theme="dark"] .branch-open-link{color:#8ab4f8 !important;}',

        // ---- buttons and pills ------------------------------------------
        'html[data-theme="dark"] .staff-pill,html[data-theme="dark"] .status-pill{background:#1a222c !important;border-color:' + DARK.border + ' !important;color:#cbd5e0 !important;}',
        'html[data-theme="dark"] .staff-pill:hover{border-color:#3a4757 !important;}',
        'html[data-theme="dark"] .status-pill-count{background:#232d39 !important;color:#e4ebf3 !important;}',
        'html[data-theme="dark"] .page-btn{background:#1a222c !important;border-color:' + DARK.border + ' !important;color:#cbd5e0 !important;}',
        'html[data-theme="dark"] .page-btn:hover:not(:disabled){background:#232d39 !important;}',
        'html[data-theme="dark"] .page-btn.active{background:#2f6fbf !important;border-color:#2f6fbf !important;color:#fff !important;}',
        'html[data-theme="dark"] .admin-action-banner{background:#241c12 !important;border-color:#8a5a1d !important;border-left-color:#b4453f !important;color:#f0c48a !important;}',
        'html[data-theme="dark"] .admin-action-warning{background:#241c12 !important;border-color:#8a5a1d !important;border-left-color:#b4453f !important;color:#f0c48a !important;}',

        // ---- checklist modal (checklist.js) -----------------------------
        'html[data-theme="dark"] .chk-m{background:' + DARK.surface + ' !important;}',
        'html[data-theme="dark"] .chk-prog-top{color:' + DARK.dim + ' !important;}',
        'html[data-theme="dark"] .chk-bar{background:#232d39 !important;}',
        'html[data-theme="dark"] .chk-item{background:#131a22 !important;border-color:#33414f !important;}',
        'html[data-theme="dark"] .chk-item.done{background:#12211a !important;border-color:#2f6b4a !important;}',
        'html[data-theme="dark"] .chk-item.na{background:#181d24 !important;}',
        'html[data-theme="dark"] .chk-lab{color:' + DARK.text + ' !important;}',
        'html[data-theme="dark"] .chk-hint,html[data-theme="dark"] .chk-saving,html[data-theme="dark"] .chk-f-note,html[data-theme="dark"] .chk-na-note{color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] .chk-ta{background:#0c1117 !important;color:' + DARK.text + ' !important;border-color:#33414f !important;}',
        'html[data-theme="dark"] .chk-na{background:#1b232d !important;border-color:' + DARK.border + ' !important;color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] .chk-f{border-top-color:#232d39 !important;}',

        // ---- login page --------------------------------------------------
        'html[data-theme="dark"] .login-card{background:' + DARK.surface + ' !important;}',
        // .login-body stays transparent so the card's own 14px radius still clips the
        // bottom corners; painting it separately squared them off.

        'html[data-theme="dark"] .login-body label{color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] .badge-hole{background:#232d39 !important;}',
        'html[data-theme="dark"] .login-error{background:#3a1c1c !important;color:#f3b4b4 !important;}',

        // ---- public ticket form -----------------------------------------
        'html[data-theme="dark"] .ticket-card{background:' + DARK.surface + ' !important;}',
        'html[data-theme="dark"] .ticket-body{background:' + DARK.surface + ' !important;}',
        'html[data-theme="dark"] .ticket-perforation{border-top-color:#33414f !important;}',
        'html[data-theme="dark"] .ticket-perforation::before,html[data-theme="dark"] .ticket-perforation::after{background:' + DARK.bg + ' !important;}',
        'html[data-theme="dark"] h2.form-title{color:' + DARK.text + ' !important;}',
        'html[data-theme="dark"] .ticket-body label{color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] .tab-switch{background:#131a22 !important;}',
        'html[data-theme="dark"] .tab-btn{color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] .tab-btn.active{background:#1b232d !important;color:#ff7b7b !important;}',

        // ---- inline neutral backgrounds / borders / text ----------------
        'html[data-theme="dark"] [style*="background:#ffffff"],html[data-theme="dark"] [style*="background:#fff;"],',
        'html[data-theme="dark"] [style*="background:#fdfcfb"],html[data-theme="dark"] [style*="background:#faf9f7"],',
        'html[data-theme="dark"] [style*="background:#f9fafb"],html[data-theme="dark"] [style*="background:#f8f9fa"],',
        'html[data-theme="dark"] [style*="background:#f7fafc"],html[data-theme="dark"] [style*="background:#f1f5f9"],',
        'html[data-theme="dark"] [style*="background:#edf2f7"],html[data-theme="dark"] [style*="background:#f4f3f1"],',
        'html[data-theme="dark"] [style*="background:white"]{background:' + DARK.surface + ' !important;}',
        'html[data-theme="dark"] [style*="border:1px solid #e2e8f0"],html[data-theme="dark"] [style*="border:1px solid #cbd5e0"],',
        'html[data-theme="dark"] [style*="border:1px solid #edf2f7"],html[data-theme="dark"] [style*="border-top:1px solid #edf2f7"],',
        'html[data-theme="dark"] [style*="border-bottom:1px solid #edf2f7"],html[data-theme="dark"] [style*="border:1.5px solid #e5e1de"],',
        'html[data-theme="dark"] [style*="border:1px solid #e5e1de"]{border-color:#33414f !important;}',
        'html[data-theme="dark"] [style*="color:#2d3748"],html[data-theme="dark"] [style*="color:#1e2229"],',
        'html[data-theme="dark"] [style*="color:#1a202c"],html[data-theme="dark"] [style*="color:#000"]{color:' + DARK.text + ' !important;}',
        'html[data-theme="dark"] [style*="color:#4a5568"]{color:#b9c6d4 !important;}',
        'html[data-theme="dark"] [style*="color:#718096"],html[data-theme="dark"] [style*="color:#6b7280"]{color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] [style*="color:#a0aec0"]{color:' + DARK.dim + ' !important;}',
        'html[data-theme="dark"] [style*="color:#8a8f98"]{color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] [style*="background:#fde8e8"]{background:#3a1c1c !important;color:#f3b4b4 !important;}',
        'html[data-theme="dark"] [style*="background:#d9f4e5"]{background:#12281c !important;color:#9fdcb9 !important;}',

        // ---- intro splash: always a white stage, whatever the theme ------
        // The logo video is cut on white; darkening the overlay behind it made it look
        // like a bright box floating in a dark page, so this stays white in both themes.
        'html[data-theme="dark"] #sarathyIntroOverlay{background:#ffffff !important;}',
        'html[data-theme="dark"] #sarathyIntroOverlay video{background:#ffffff !important;}',

        // ---- appearance switch (My Profile) ------------------------------
        '.theme-switch{display:inline-flex;gap:6px;margin-top:10px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:4px;}',
        '.theme-switch button{border:none;background:none;padding:7px 14px;border-radius:7px;font-size:12.5px;font-weight:600;color:#4a5568;cursor:pointer;}',
        '.theme-switch button.active{background:#0056b3;color:#fff;}',
        'html[data-theme="dark"] .theme-switch{background:#10161d !important;border-color:#33414f !important;}',
        'html[data-theme="dark"] .theme-switch button{color:' + DARK.muted + ' !important;}',
        'html[data-theme="dark"] .theme-switch button.active{background:#2f6fbf !important;color:#fff !important;}'
    ].join('');

    // Light is the out-of-the-box look; System stays available for anyone who picks it,
    // and a stored choice is always respected.
    function stored() {
        try {
            var saved = localStorage.getItem(KEY);
            return (saved === 'light' || saved === 'dark' || saved === 'system') ? saved : 'light';
        } catch (e) { return 'light'; }
    }

    function resolve(mode) {
        if (mode === 'dark' || mode === 'light') return mode;
        return media && media.matches ? 'dark' : 'light';
    }

    function syncSwitch(mode) {
        var buttons = document.querySelectorAll('.theme-switch button[data-theme-mode]');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('active', buttons[i].getAttribute('data-theme-mode') === mode);
        }
    }

    function applyCharts(dark) {
        if (!window.Chart || !window.Chart.defaults) return;
        window.Chart.defaults.color = dark ? DARK.muted : '#666';
        window.Chart.defaults.borderColor = dark ? DARK.border : 'rgba(0,0,0,0.1)';
        if (typeof window.loadReportCharts === 'function') {
            var reports = document.getElementById('viewReports');
            if (reports && reports.classList.contains('active')) window.loadReportCharts();
        }
    }

    function apply(mode) {
        mode = mode || stored();
        var effective = resolve(mode);
        root.setAttribute('data-theme', effective);
        root.setAttribute('data-theme-mode', mode);
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', effective === 'dark' ? '#151a21' : '#e53e3e');
        syncSwitch(mode);
        applyCharts(effective === 'dark');
    }

    var style = document.createElement('style');
    style.id = 'theme-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    apply(stored());

    if (media) {
        var onChange = function () { if (stored() === 'system') apply('system'); };
        if (media.addEventListener) media.addEventListener('change', onChange);
        else if (media.addListener) media.addListener(onChange);
    }

    document.addEventListener('DOMContentLoaded', function () { syncSwitch(stored()); });
    // Chart.js is loaded after this file, so its palette is applied once the page is ready.
    window.addEventListener('load', function () { apply(stored()); });

    window.SarathyTheme = {
        current: function () { return { mode: stored(), effective: resolve(stored()) }; },
        set: function (mode) {
            if (['light', 'dark', 'system'].indexOf(mode) === -1) mode = 'system';
            try { localStorage.setItem(KEY, mode); } catch (e) {}
            apply(mode);
        }
    };
})();
