// Playwright config for Brain-PKA E2E tests.
// Tests target the deployed Cloudflare Pages app (brain-pka.pages.dev).
// To run against a local dev server instead, override BASE_URL.
import { defineConfig, devices } from '@playwright/test';

// ── Cloudflare Access Service Token ────────────────────────────────
// brain-pka.pages.dev sits behind a Cloudflare Access policy that
// redirects unauthenticated requests to the SSO login. For automation
// (Playwright, CI), Cloudflare expects two custom headers signed
// against a Service Token configured in Zero Trust → Access → Service
// Auth. Create one, then set:
//
//   CF_ACCESS_CLIENT_ID     = <Service Token's "Client ID">
//   CF_ACCESS_CLIENT_SECRET = <Service Token's "Client Secret">
//
// Also: in the Access policy that protects the app, ADD a rule
// "Include: Service Token = <your-token-name>" — otherwise the headers
// authenticate the request but no policy includes it.
//
// Both vars must be present, otherwise the headers are skipped and the
// app behaves as for any unauthenticated visitor (302 to SSO).
const cfClientId = process.env.CF_ACCESS_CLIENT_ID;
const cfClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const cfHeaders =
  cfClientId && cfClientSecret
    ? {
        'CF-Access-Client-Id': cfClientId,
        'CF-Access-Client-Secret': cfClientSecret,
      }
    : undefined;

if (!cfHeaders && !process.env.BASE_URL?.startsWith('http://localhost')) {
  // Console-warning during test run so failures are easier to debug
  console.warn(
    '⚠️  CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET not set. ' +
      'Tests against brain-pka.pages.dev will hit the Cloudflare Access SSO ' +
      'redirect and likely time out. Set both env vars, or use ' +
      'BASE_URL=http://localhost:7823 for local testing.'
  );
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.BASE_URL || 'https://brain-pka.pages.dev',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Inject the Service Token on every request — page navigations AND
    // XHR/fetch calls from the app (e.g. /api/recipes) both go through
    // Cloudflare Access, so both need the headers.
    extraHTTPHeaders: cfHeaders,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
