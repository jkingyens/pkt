function showSuccessUI(btn) {
    btn.style.background = '#28a745';
    btn.innerText = 'Permission Granted!';
    
    // Remove any existing status
    const existingStatus = document.getElementById('status-box');
    if (existingStatus) existingStatus.remove();

    const status = document.createElement('div');
    status.id = 'status-box';
    status.style.marginTop = '20px';
    status.style.padding = '15px';
    status.style.borderRadius = '8px';
    status.style.background = 'rgba(40, 167, 69, 0.1)';
    status.style.border = '1px solid rgba(40, 167, 69, 0.2)';
    
    status.innerHTML = `
        <p style="color: #28a745; font-weight: 700; margin: 0 0 8px 0; font-size: 16px;">✓ Recording Ready</p>
        <p style="color: var(--text-secondary); margin: 0; font-size: 14px; line-height: 1.4;">
            Recording will start automatically in the sidebar.
        </p>
        <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(0,0,0,0.05);">
            <p style="color: #856404; background: #fff3cd; padding: 10px; border-radius: 4px; border: 1px solid #ffeeba; margin-bottom: 8px; font-size: 13px;">
                <strong>IMPORTANT:</strong> If you granted <strong>"one-time"</strong> access, please keep this tab open until you finish recording.
            </p>
            <p style="color: var(--text-secondary); margin: 0; font-size: 13px;">
                If you granted <strong>permanent</strong> access, you can safely close this tab now.
            </p>
        </div>
        <p style="color: var(--text-secondary); margin: 15px 0 0 0; font-size: 12px; opacity: 0.8;">
            This tab will close automatically when recording stops in the sidebar.
        </p>
    `;
    btn.parentNode.insertBefore(status, btn.nextSibling);
}

// Simple click handler
document.getElementById('requestBtn').addEventListener('click', async () => {
    const btn = document.getElementById('requestBtn');
    const originalText = btn.innerText;
    
    try {
        btn.disabled = true;
        btn.innerText = 'Requesting...';
        
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach(t => t.stop());
        
        // Notify background that permission was granted
        chrome.runtime.sendMessage({ action: 'PERMISSION_GRANTED' });
        
        showSuccessUI(btn);
    } catch (err) {
        btn.disabled = false;
        btn.innerText = originalText;
        alert('Permission denied. Please check your browser settings and try again.');
        console.error(err);
    }
});
