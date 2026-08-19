const { chromium } = require('/home/yu/Agents/paihuo/node_modules/playwright');

(async () => {
  const url = process.env.E2E_URL || 'http://127.0.0.1:18081';
  const token = 't';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  // 登录
  await page.goto(`${url}/login`);
  await page.fill('input[type=password], input[type=text], input[name=token]', token).catch(() => {});
  await page.click('button:has-text("登录"), button[type=submit]').catch(() => {});
  await page.waitForURL(/\/$|\/dashboard|\/board|\/tasks/, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // 角色页
  await page.goto(`${url}/roles`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/roles-list.png', fullPage: true });

  // 新建角色
  await page.getByRole('button', { name: /新建角色/ }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/role-create-default.png', fullPage: true });

  // 勾选 Runtime = pi 后默认字段（最常用的新建路径）
  await page.getByRole('button', { name: '保存角色' }).isVisible();
  await page.screenshot({ path: '/tmp/role-create-pi.png', fullPage: true });

  // 打开编排委托
  const deleg = page.getByText('编排委托（delegation）').first();
  await deleg.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/role-create-delegation.png', fullPage: true });

  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
