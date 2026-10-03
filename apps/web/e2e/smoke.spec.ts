import { expect, test } from '@playwright/test';

test('dashboard loads and shows the API status', async ({ page }) => {
  await page.route('**/api/system/status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }),
  );

  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Vandaag' })).toBeVisible();
  await expect(page.getByText('Verbonden met EffectiefAI.')).toBeVisible();
});

test('shows a calm message when the API is unreachable', async ({ page }) => {
  await page.route('**/api/system/status', (route) => route.abort());

  await page.goto('/');

  await expect(page.getByText('De server is even niet bereikbaar.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible();
});
