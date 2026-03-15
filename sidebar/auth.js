async function handleAuth() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode'); // 'register' or 'verify'
    const statusEl = document.getElementById('status');
    const titleEl = document.getElementById('title');

    try {
        if (mode === 'register') {
            titleEl.textContent = 'Enabling Biometrics';
            await register();
        } else {
            titleEl.textContent = 'Verifying Identity';
            await verify();
        }
        // Success: Wait a moment for UX then close
        statusEl.textContent = 'Success! Closing...';
        setTimeout(() => window.close(), 1000);
    } catch (err) {
        console.error('Auth Error:', err);
        statusEl.textContent = 'Error: ' + err.message;
        // Keep window open for a bit so user can see error
        setTimeout(() => window.close(), 3000);
    }
}

async function register() {
    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const userID = new Uint8Array(16);
    window.crypto.getRandomValues(userID);

    const options = {
        publicKey: {
            challenge: challenge.buffer,
            rp: { name: "Wildcard Extension" },
            user: {
                id: userID.buffer,
                name: "user@wildcard",
                displayName: "Wildcard User",
            },
            pubKeyCredParams: [
                { alg: -7, type: "public-key" },
                { alg: -257, type: "public-key" }
            ],
            authenticatorSelection: {
                authenticatorAttachment: "platform",
                userVerification: "required"
            },
            timeout: 60000,
            attestation: "none"
        }
    };

    const credential = await navigator.credentials.create(options);
    if (!credential) throw new Error('Failed to create credential');

    const credentialId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
    await chrome.storage.local.set({
        webAuthnEnabled: true,
        webAuthnCredentialId: credentialId,
        webAuthnResult: { success: true, timestamp: Date.now(), mode: 'register' }
    });
}

async function verify() {
    const data = await chrome.storage.local.get(['webAuthnCredentialId']);
    if (!data.webAuthnCredentialId) throw new Error('No credential registered');

    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const idBytes = Uint8Array.from(atob(data.webAuthnCredentialId), c => c.charCodeAt(0));

    const options = {
        publicKey: {
            challenge: challenge.buffer,
            allowCredentials: [{
                id: idBytes.buffer,
                type: 'public-key',
            }],
            userVerification: "required",
            timeout: 60000,
        }
    };

    const assertion = await navigator.credentials.get(options);
    if (!assertion) throw new Error('Verification failed');

    await chrome.storage.local.set({
        webAuthnResult: { success: true, timestamp: Date.now(), mode: 'verify' }
    });
}

window.onload = handleAuth;
