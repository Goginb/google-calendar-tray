'use strict';

function createTrayClickActions({ singleClick, doubleClick, delayMs }) {
  let pendingClick = null;
  let ignoreClicksUntil = 0;

  return {
    click() {
      if (Date.now() < ignoreClicksUntil || pendingClick) return;
      pendingClick = setTimeout(() => {
        pendingClick = null;
        singleClick();
      }, delayMs);
    },
    doubleClick() {
      clearTimeout(pendingClick);
      pendingClick = null;
      ignoreClicksUntil = Date.now() + delayMs;
      doubleClick();
    },
    dispose() {
      clearTimeout(pendingClick);
      pendingClick = null;
    }
  };
}

module.exports = { createTrayClickActions };
