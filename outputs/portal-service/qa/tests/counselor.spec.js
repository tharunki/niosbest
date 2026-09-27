import {test,expect} from '@playwright/test';
import {login} from './helpers.js';
test('student assistant opens, answers, clears, and closes',async({page})=>{
 await login(page,'STUDENT');await page.goto('/dashboard');
 await page.getByRole('button',{name:/Ask Mira/}).click();
 const panel=page.locator('#studentAssistant');
 await expect(panel).toBeVisible();
 await panel.getByRole('button',{name:'TMA help',exact:true}).click();
 await expect(panel.locator('.counselor-log')).toContainText('official NIOS TMA');
 await panel.getByRole('textbox',{name:'Your question'}).fill('<img src=x onerror=alert(1)>');
 await panel.getByRole('button',{name:'Send',exact:true}).click();
 await expect(panel.locator('.counselor-log')).toContainText('<img src=x onerror=alert(1)>');
 await expect(panel.locator('.counselor-log img')).toHaveCount(0);
 await panel.getByRole('button',{name:'New chat'}).click();
 await expect(panel.locator('.counselor-message')).toHaveCount(1);
 await panel.getByRole('button',{name:'Close assistant'}).click();
 await expect(panel).toBeHidden();
});

test('Mira blocks private values in the browser and grounds deadline guidance',async({page})=>{
 await login(page,'STUDENT');await page.goto('/dashboard');
 let counselorRequests=0;
 await page.route('**/api/counselor', async route=>{
   counselorRequests+=1;
   await route.continue();
 });
 await page.getByRole('button',{name:/Ask Mira/}).click();
 const panel=page.locator('#studentAssistant');
 const input=panel.getByRole('textbox',{name:'Your question'});
 await input.fill('My OTP is 123456');
 await panel.getByRole('button',{name:'Send',exact:true}).click();
 await expect(panel.locator('.counselor-log')).toContainText('Private information was not sent');
 await expect(panel.locator('.counselor-log')).not.toContainText('123456');
 expect(counselorRequests).toBe(0);
 await input.fill('When is the hall ticket deadline?');
 await panel.getByRole('button',{name:'Send',exact:true}).click();
 await expect(panel.locator('.counselor-log')).toContainText('do not invent official deadlines');
 await expect(panel.locator('a[href="https://sdmis.nios.ac.in/"]')).toBeVisible();
 expect(counselorRequests).toBe(1);
});
test('anonymous counselor requests are denied',async({request})=>{
 const r=await request.post('/api/counselor',{data:{message:'Admission status'}});
 expect(r.status()).toBe(401);
});
