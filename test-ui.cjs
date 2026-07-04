const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
  page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url(), request.failure().errorText));

  await page.goto('http://127.0.0.1:5175/t/table-1', { waitUntil: 'networkidle0' });
  
  // Click on Feedback button
  await page.click('.feedback-action');
  
  // Click 2-star rating
  await page.waitForSelector('.rating-stars button');
  const stars = await page.$$('.rating-stars button');
  if (stars.length > 1) {
    await stars[1].click(); // click 2 stars
  } else {
    console.log('No stars found');
  }
  
  // Check if form appears
  await page.waitForSelector('form.feedback-form');
  
  // Fill text area just in case
  await page.type('textarea[placeholder*="подробнее"]', 'Test feedback from script');

  // Click submit
  await Promise.all([
    page.waitForResponse(res => res.url().includes('/api/public/feedback') && res.request().method() === 'POST'),
    page.click('form.feedback-form button[type="submit"]')
  ]).then(([res]) => {
    console.log('API RESPONSE STATUS:', res.status());
  }).catch(e => console.log('API RESPONSE ERROR:', e.message));
  
  // Wait a bit
  await new Promise(r => setTimeout(r, 2000));
  
  // Check if success text is there
  const success = await page.evaluate(() => {
    return document.body.innerText.includes('Спасибо за ваш отзыв');
  });
  
  console.log('Negative feedback success:', success);
  
  await browser.close();
})();
