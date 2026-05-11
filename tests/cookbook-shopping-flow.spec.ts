// E2E test: open the cookbook, scale first recipe to 4 portions,
// add it to the shopping list, verify the success toast.
//
// Aims at the LIVE site by default (see playwright.config.ts → baseURL).
// Override with BASE_URL=http://localhost:7823 npx playwright test when
// running against a local dev server.
//
// Run:   cd PKM && npx playwright test
// Watch: cd PKM && npx playwright test --debug=cli  (per playwright-cli skill)

import { test, expect } from '@playwright/test';

test.describe('Cookbook shopping flow', () => {
  test('add first recipe to shopping list for 4 persons', async ({ page }) => {
    await page.goto('/cookbook.html');

    // The Rezepte tab is the default landing. Wait for the recipe grid
    // to finish hydrating from /api/recipes — visible <article.recipe>
    // is our signal. Tolerant timeout because cold Cloudflare Workers
    // can need a moment.
    const firstRecipe = page.locator('article.recipe').first();
    await firstRecipe.waitFor({ state: 'visible', timeout: 20_000 });

    // Capture metadata for the post-action toast assertion. The recipe
    // card stores its base portion count + ingredients-JSON inline; we
    // read base servings to compute the expected scale factor.
    const baseServings = Number(await firstRecipe.getAttribute('data-base'));
    expect(baseServings).toBeGreaterThan(0);

    // Click the "4 persons" preset on this recipe. The preset row is
    // scoped to this card so we don't accidentally hit another recipe.
    const preset4 = firstRecipe.locator('button.preset[data-servings="4"]');
    await expect(preset4).toBeVisible();
    await preset4.click();

    // Inline state updates: data-servings should now be "4" and the
    // preset should be marked active.
    await expect(firstRecipe).toHaveAttribute('data-servings', '4');
    await expect(preset4).toHaveClass(/\bactive\b/);

    // Trigger the shopping-list submit.
    const shopBtn = firstRecipe.locator('button.add-to-shop-btn');
    await expect(shopBtn).toBeVisible();
    await shopBtn.click();

    // Toast assertion. cookbook.html's `toast()` builds a free-floating
    // <div> with success styling (background #1f3a25) and the message:
    //   "✓ N Zutaten für 4 Pers. zur Einkaufsliste hinzugefügt"
    // It auto-removes after 3s so we have to grab it fast.
    const successToast = page
      .locator('div')
      .filter({ hasText: /✓\s+\d+\s+Zutaten\s+für\s+4\s+Pers\./ })
      .first();
    await expect(successToast).toBeVisible({ timeout: 5_000 });

    // Visual confirmation that it's the green (success) toast, not
    // the red error one (which would be #3a1f1f).
    const bgColor = await successToast.evaluate(
      (el) => getComputedStyle(el as HTMLElement).backgroundColor
    );
    // #1f3a25 = rgb(31, 58, 37) — accept either notation
    expect(bgColor).toMatch(/rgb\(\s*31,\s*58,\s*37\s*\)|#1f3a25/i);
  });
});
