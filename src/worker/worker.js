// US-1689 scaffold canary for the service-worker entry. The dispatch spine
// (US-1692) replaces this wiring; the structure — one port listener, one
// device owner — is fixed here so the manifest never changes shape.
import { attachPortListener } from './dispatch.js';

chrome.runtime.onConnect.addListener(attachPortListener);
