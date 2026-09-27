import { CONFIG } from './config.js';
function script(src, key) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.async = true; el.crossOrigin = 'anonymous';
    if (key) el.dataset.clerkPublishableKey = key;
    el.onload = resolve; el.onerror = () => reject(new Error('Sign-in could not load. Please try again.'));
    document.head.append(el);
  });
}
export async function initAuth(onChange) {
  const key = CONFIG.clerkPublishableKey;
  if (!key) throw new Error('Sign-in is being connected. You can start choosing your team below.');
  const domain = atob(key.split('_')[2]).replace(/\$$/, '');
  await script(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await script(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, key);
  let clerk = window.Clerk;
  if (typeof clerk === 'function') clerk = new clerk(key);
  await clerk.load({ publishableKey: key, ui: { ClerkUI: window.__internal_ClerkUICtor }, appearance: { variables: { colorPrimary: '#193d31', colorBackground: '#fffdf8', colorText: '#24382f', borderRadius: '14px', fontFamily: 'DM Sans, sans-serif' } } });
  const client = {
    get user() { return clerk.user ? { id: clerk.user.id, name: clerk.user.firstName || clerk.user.fullName || 'Castaway' } : null; },
    token: () => clerk.session?.getToken(),
    signIn: () => clerk.openSignIn({ forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href }),
    signOut: () => clerk.signOut({ redirectUrl: location.origin + location.pathname }),
    account: () => clerk.openUserProfile(),
  };
  clerk.addListener(() => onChange(client.user));
  return client;
}
