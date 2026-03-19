/**
 * Shared Theme Initialization and Synchronization
 * Ensures consistent light/dark theme across all extension pages.
 */
(function() {
    function applyTheme(theme) {
        let activeTheme = theme;
        if (activeTheme === 'system') {
            activeTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }

        if (activeTheme === 'dark') {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    }

    // 0. Immediate signal from parent if in an iframe
    try {
        if (window.parent && window.parent.document && window.parent.document.body) {
            if (window.parent.document.body.classList.contains('dark-mode')) {
                document.body.classList.add('dark-mode');
            } else {
                document.body.classList.remove('dark-mode');
            }
        }
    } catch (e) {
        // Parent might be cross-origin or not accessible yet
    }

    // 0.5. Listen for messages from parent (for real-time sync in iframes)
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'THEME_CHANGE') {
            applyTheme(event.data.theme);
        }
    });

    // 1. Initial application from storage
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['theme'], (result) => {
            applyTheme(result.theme || 'system');
        });

        // 2. Listen for storage changes (real-time sync)
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.theme) {
                applyTheme(changes.theme.newValue);
            }
        });

        // 3. Listen for system preference changes
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            chrome.storage.local.get(['theme'], (result) => {
                if (!result.theme || result.theme === 'system') {
                    applyTheme('system');
                }
            });
        });
    }
})();
