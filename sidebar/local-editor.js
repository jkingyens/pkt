(function() {
    const btn = document.getElementById('edit-toggle-btn');
    const content = document.getElementById('editable-content');
    const icon = document.getElementById('btn-icon');
    const text = document.getElementById('btn-text');
    
    if (!btn || !content) return;

    let isEditing = false;
    
    btn.onclick = () => {
        isEditing = !isEditing;
        content.contentEditable = isEditing;
        
        if (isEditing) {
            btn.classList.add('active');
            if (icon) icon.textContent = '✅';
            if (text) text.textContent = 'Finish Editing';
            content.focus();
        } else {
            btn.classList.remove('active');
            if (icon) icon.textContent = '✏️';
            if (text) text.textContent = 'Edit Page';
            // Success feedback
            console.log('Saved changes:', content.innerHTML);
            
            // Dispatch a custom event so the viewer can potentially catch it
            window.dispatchEvent(new CustomEvent('page-edited', { 
                detail: { html: content.innerHTML } 
            }));
        }
    };
})();
