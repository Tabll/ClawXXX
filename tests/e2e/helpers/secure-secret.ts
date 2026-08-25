import type { Page } from '@playwright/test';

/** Set a closed-shadow credential field through the E2E-only preload bridge. */
export async function fillSecureSecret(page: Page, testId: string, value: string): Promise<void> {
  await page.getByTestId(testId).evaluate((element, nextValue) => {
    const id = element.getAttribute('data-clawx-secret-id');
    const setValue = window.clawxSecureSecrets?.setValueForTesting;
    if (!id || typeof setValue !== 'function') {
      throw new Error('Secure test input bridge is unavailable');
    }
    setValue(id, nextValue);
  }, value);
}
