import { expect, type Page, test } from '@playwright/test';

const unauthorized = {
  status: 401,
  contentType: 'application/json',
  body: JSON.stringify({
    error: { code: 'UNAUTHORIZED', message: 'Je bent niet ingelogd.', requestId: 'r' },
  }),
};

function tenantAs(page: Page, name: string | null) {
  return page.route('**/api/tenant', (route) =>
    name === null
      ? route.fulfill(unauthorized)
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ name, defaultVatRateBps: 2100 }),
        }),
  );
}

// The dashboard also asks for the connections (the notice to renew one);
// without a session-backed API in these tests, none by default.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/connections', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
});

test('sends visitors without a session to the login page', async ({ page }) => {
  await tenantAs(page, null);
  await page.goto('/');
  await expect(page).toHaveURL(/\/inloggen$/);
  await expect(page.getByRole('heading', { name: 'Inloggen' })).toBeVisible();
});

test('shows the tenant name on the dashboard', async ({ page }) => {
  await tenantAs(page, 'Installatiebedrijf Jansen');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Vandaag' })).toBeVisible();
  await expect(page.getByText('Installatiebedrijf Jansen')).toBeVisible();
});

test('asks to renew an expired connection on the dashboard', async ({ page }) => {
  await tenantAs(page, 'Installatiebedrijf Jansen');
  await page.route('**/api/connections', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: '0199a1b2-0000-7000-8000-000000000001',
          provider: 'gmail',
          status: 'expired',
          statusReason: 'invalid_grant',
          accountLabel: 'info@jansen.example',
          lastSyncedAt: null,
          receivedMailCount: 3,
          connectedAt: '2026-10-05T10:00:00.000Z',
          canManage: true,
        },
      ]),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(
    'De koppeling met Gmail (info@jansen.example) werkt niet meer.',
  );
  await expect(page.getByRole('link', { name: 'Koppeling vernieuwen' })).toHaveAttribute(
    'href',
    '/koppelingen',
  );
});

test('logs in with JSON and opens the dashboard', async ({ page }) => {
  let loggedIn = false;
  await page.route('**/api/tenant', (route) =>
    loggedIn
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ name: 'Hoveniers De Vries', defaultVatRateBps: 2100 }),
        })
      : route.fulfill(unauthorized),
  );
  await page.route('**/api/auth/sign-in/email', async (route) => {
    expect(route.request().headers()['content-type']).toContain('application/json');
    expect(route.request().postDataJSON()).toEqual({
      email: 'a@example.test',
      password: 'een-lang-wachtwoord',
    });
    loggedIn = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"redirect":false}',
    });
  });

  await page.goto('/inloggen');
  await page.getByLabel('E-mailadres').fill('a@example.test');
  await page.getByLabel('Wachtwoord').fill('een-lang-wachtwoord');
  await page.getByRole('button', { name: 'Inloggen' }).click();

  await expect(page.getByText('Hoveniers De Vries')).toBeVisible();
});

test('shows a calm message for a wrong password', async ({ page }) => {
  await page.route('**/api/auth/sign-in/email', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"code":"INVALID_EMAIL_OR_PASSWORD"}',
    }),
  );
  await page.goto('/inloggen');
  await page.getByLabel('E-mailadres').fill('a@example.test');
  await page.getByLabel('Wachtwoord').fill('verkeerd-wachtwoord');
  await page.getByRole('button', { name: 'Inloggen' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Dit e-mailadres en wachtwoord horen niet bij elkaar.',
  );
});
