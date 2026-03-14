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

    // 1. Initial application from storage
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
})();
