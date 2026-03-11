(function() {
    const toggleBtn = document.getElementById('format-toggle');
    const container = document.getElementById('slide-container');
    const formatText = document.getElementById('format-text');
    const slideList = document.getElementById('slide-list');
    
    if (!toggleBtn || !container) return;

    // Toggle Layout Logic
    toggleBtn.onclick = () => {
        const isTitle = container.classList.contains('layout-title');
        if (isTitle) {
            container.classList.remove('layout-title');
            container.classList.add('layout-content');
            formatText.textContent = 'Switch to Title';
        } else {
            container.classList.remove('layout-content');
            container.classList.add('layout-title');
            formatText.textContent = 'Switch to Content';
        }
    };

    // Smart Bullet Handling
    if (slideList) {
        slideList.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                // Let the browser handle creating the new LI, 
                // but we can add logic here if we need specific bullet behavior.
                // MutationObserver in viewer.js will pick up the change.
            }
        });
    }

    // Interactive edit feedback (optional)
    console.log('Slide editor initialized');
})();
