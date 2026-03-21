export async function initTheme() {
    const { theme = 'system' } = await chrome.storage.local.get('theme');
    applyTheme(theme);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.theme) {
            applyTheme(changes.theme.newValue);
        }
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        chrome.storage.local.get('theme').then(({ theme = 'system' }) => {
            if (theme === 'system') applyTheme('system');
        });
    });
}

function applyTheme(theme) {
    let isDark = false;
    if (theme === 'dark') {
        isDark = true;
    } else if (theme === 'system') {
        isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    
    if (isDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
}
