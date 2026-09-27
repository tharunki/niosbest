import {test,expect} from '@playwright/test';
import {login} from './helpers.js';
test('student assistant opens, answers, clears, and closes',async({page})=>{
 await login(page,'STUDENT');await page.goto('/dashboard');
 await page.getByRole('button',{name:'✦ Student assistant'}).click();
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
test('anonymous counselor requests are denied',async({request})=>{
 const r=await request.post('/api/counselor',{data:{message:'Admission status'}});
 expect(r.status()).toBe(401);
});
