(() => {
  // src/provider/provider.js
  (function() {
    if (window.nostr) return false;
    window.nostr = {};
    return true;
  })();
})();
