import { fakeBrowser } from "@webext-core/fake-browser";

// the dashboard reads extension storage through @wxt-dev/browser
// outside an extension we point that at wxt's in-memory fake instead
export const browser = fakeBrowser;
