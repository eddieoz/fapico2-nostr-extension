(() => {
  // src/worker/dispatch.js
  function attachPortListener(port) {
    port.onMessage.addListener(() => {
    });
  }

  // src/worker/worker.js
  chrome.runtime.onConnect.addListener(attachPortListener);
})();
