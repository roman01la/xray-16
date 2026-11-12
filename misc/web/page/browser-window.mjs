export function installBrowserWindowMode() {
  if (window.xrayBrowserFullscreen) return;
  // A release iframe uses its top-level element for fullscreen and keyboard lock.
  const target = window.frameElement ?? document.documentElement;
  const owner = target.ownerDocument;
  if (!owner.fullscreenEnabled || !target.requestFullscreen) return;
  const keyboard = owner.defaultView.navigator.keyboard;
  const isFullscreen = () => owner.fullscreenElement === target;
  let locked = false, pending = false, active = true;
  const syncKeyboard = async () => {
    if (!active || !isFullscreen()) {
      if (locked) {
        keyboard.unlock();
        locked = false;
      }
      return;
    }
    if (locked || pending || !keyboard?.lock) return;
    pending = true;
    try {
      await keyboard.lock(['Escape']);
      if (active && isFullscreen()) locked = true;
      else keyboard.unlock();
    } catch { /* Fullscreen also works when Keyboard Lock is unavailable. */ }
    finally { pending = false; }
  };
  window.xrayBrowserFullscreen = {
    isActive: isFullscreen,
    async set(enabled) {
      try {
        if (enabled && !isFullscreen()) await target.requestFullscreen();
        if (!enabled && isFullscreen()) await owner.exitFullscreen();
      } catch (error) {
        console.warn('Could not change the game window mode:', error);
      }
    },
  };
  owner.addEventListener('fullscreenchange', syncKeyboard);
  window.addEventListener('pagehide', () => {
    active = false;
    owner.removeEventListener('fullscreenchange', syncKeyboard);
    syncKeyboard();
  });
  window.addEventListener('pageshow', () => {
    active = true;
    owner.addEventListener('fullscreenchange', syncKeyboard);
    syncKeyboard();
  });
  syncKeyboard();
}
