(function() {
    const toggleBtn = document.getElementById('format-toggle');
    const container = document.getElementById('slide-container');
    const formatText = document.getElementById('format-text');
    const slideList = document.getElementById('slide-list');
    
    if (!toggleBtn || !container) return;

    // Toggle Layout Logic with smooth transitions
    toggleBtn.onclick = () => {
        const isTitle = container.classList.contains('layout-title');
        if (isTitle) {
            container.classList.remove('layout-title');
            container.classList.add('layout-content');
            if (formatText) formatText.textContent = 'Switch to Title';
        } else {
            container.classList.remove('layout-content');
            container.classList.add('layout-title');
            if (formatText) formatText.textContent = 'Switch to Content';
        }
    };

    // Ensure list items are easy to create and edit
    if (slideList) {
        slideList.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                // If the list is empty, browsers sometimes create DIVs or Ps
                // instead of LIs. We want LIs.
                const selection = window.getSelection();
                const range = selection.getRangeAt(0);
                const li = range.commonAncestorContainer.closest ? range.commonAncestorContainer.closest('li') : null;
                
                if (!li && slideList.children.length === 0) {
                   e.preventDefault();
                   const newLi = document.createElement('li');
                   newLi.innerHTML = 'New item';
                   slideList.appendChild(newLi);
                   
                   // Move cursor to new LI
                   const newRange = document.createRange();
                   newRange.selectNodeContents(newLi);
                   newRange.collapse(false);
                   selection.removeAllRanges();
                   selection.addRange(newRange);
                }
            }
        });
    }

    console.log('Slide editor initialized');
})();
