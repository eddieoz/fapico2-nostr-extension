// US-1696/US-1697 — the MAIN-world provider chunk. (Canary for US-1689; the
// NIP-07 + nip44 surface lands with the story's tests. The never-clobber
// rule is asserted here from the first commit.)
(function () {
  if (window.nostr) return false;
  window.nostr = {};
  return true;
})();
