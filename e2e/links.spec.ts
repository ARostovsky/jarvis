import { test, expect } from '@playwright/test';

test('chat markdown renders http(s) links, also in table cells; other schemes stay text', async ({ page }) => {
  await page.goto('/');
  const html = await page.evaluate(() => {
    const d = document.createElement('div');
    d.append(...(window as any).renderMd('see [run](https://x.io/runs/1) and https://y.io/a, `https://no.io`\n\n| id |\n|---|\n| [cell](https://x.io/c) |\n\n[bad](javascript:alert(1))'));
    return d.innerHTML;
  });
  expect(html).toContain('<a href="https://x.io/runs/1" target="_blank" rel="noopener noreferrer">run</a>');
  expect(html).toContain('<a href="https://y.io/a" target="_blank" rel="noopener noreferrer">https://y.io/a</a>,'); // comma stays outside
  expect(html).toContain('<code>https://no.io</code>');
  expect(html).toMatch(/<td><a href="https:\/\/x.io\/c"[^>]*>cell<\/a><\/td>/);
  expect(html).toContain('[bad](javascript:alert(1))');
  expect(html).not.toContain('href="javascript');
});
