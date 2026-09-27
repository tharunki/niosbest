const productId=new URLSearchParams(location.search).get('product');
const buy=document.getElementById('buy'),statusText=document.getElementById('status'),download=document.getElementById('download');
let payment=null,receipt=null;
async function api(path,data){const r=await fetch(path,data?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{});const body=await r.json();if(!r.ok)throw new Error(body.error||'Request failed');return body}
function unlock(path){download.href=path;download.hidden=false;buy.hidden=true;statusText.textContent='Payment confirmed. Your PDF is ready to download.'}
async function finish(){try{const result=await api('/api/store/orders/'+payment.id+'/complete',receipt||{});unlock(result.download)}catch(e){statusText.textContent=e.message;buy.textContent='Retry payment verification';buy.disabled=false}}
async function load(){
  try{
    const products=await api('/api/store/catalogue'),product=products.find(p=>p.id===productId);
    if(!product)throw new Error('Resource not found.');
    document.getElementById('title').textContent=product.title;document.getElementById('price').textContent='₹'+product.price;
    const session=await fetch('/api/auth/me');
    if(!session.ok){buy.textContent='Sign in to continue';buy.disabled=false;buy.onclick=()=>location.href='/login?resource='+encodeURIComponent(productId);return}
    if(product.owned){unlock('/api/store/downloads/'+product.id);return}
    if(!product.available){buy.textContent='PDF not uploaded yet';statusText.textContent='The academy must upload this subject PDF before purchase. You will not be charged.';return}
    buy.textContent='Pay ₹'+product.price;buy.disabled=false;
    buy.onclick=async()=>{
      buy.disabled=true;statusText.textContent='Preparing secure checkout…';
      try{
        if(receipt){await finish();return}
        payment=await api('/api/store/orders',{productId});
        if(payment.owned){unlock('/api/store/downloads/'+productId);return}
        if(payment.provider==='mock'){
          buy.disabled=false;buy.textContent='Simulate test payment — no real charge';
          statusText.textContent='Development checkout only. Live payments are not enabled.';
          buy.onclick=()=>{buy.disabled=true;finish()};return;
        }
        if(!window.Razorpay)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://checkout.razorpay.com/v1/checkout.js';script.onload=resolve;script.onerror=()=>reject(new Error('Payment checkout could not load.'));document.head.append(script)});
        const checkout=new Razorpay({key:payment.keyId,order_id:payment.orderId,amount:payment.amount,currency:'INR',name:'NIOS Best Academy',description:product.title,handler:async result=>{receipt=result;await finish()},modal:{ondismiss:()=>{buy.disabled=false;statusText.textContent='Payment cancelled. You have not been granted download access.'}}});checkout.open();
      }catch(e){statusText.textContent=e.message;buy.disabled=false}
    };
  }catch(e){statusText.textContent=e.message;buy.textContent='Unavailable'}
}
load();
