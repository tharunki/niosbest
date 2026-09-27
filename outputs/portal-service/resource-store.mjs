import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const subjects = {
  '10':['Hindi','English','Mathematics','Science','Social Science','Data Entry Operations'],
  '12':['Hindi','English','Mathematics','Physics','Chemistry','Biology','Economics','Business Studies','Accountancy','History','Geography','Political Science','Data Entry Operations']
};
export const catalogue = Object.entries(subjects).flatMap(([level,names])=>names.flatMap(subject=>Object.entries({tma:249,study:499,pyq:399}).map(([kind,price])=>({
  id:kind+'-'+level+'-'+subject.toLowerCase().replaceAll(' ','-'),kind,level,subject,price,
  title:'Class '+level+' '+subject+' '+({tma:'Solved TMA',study:'Study material',pyq:'PYQs'}[kind])
}))));
const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};
const auditId=()=>`audit_${randomBytes(9).toString('hex')}`;

// The main Razorpay webhook is intentionally shared by course and PDF purchases.
// This helper validates and records only a resource order that was explicitly
// tagged when it was created. It never trusts an amount, product, or user ID
// supplied by the webhook beyond using the locally stored order as the source
// of truth.
export function captureResourceOrder(state,capture){
  const orderId=String(capture?.notes?.academyResourceOrderId||'');
  if(!orderId)return null;
  const order=(state.resourceOrders||[]).find(item=>item.id===orderId&&item.provider==='razorpay');
  if(!order)fail(404,'Resource payment order not found.');
  if(!order.providerOrderId||String(capture.order_id||'')!==order.providerOrderId)fail(409,'Resource payment order mismatch.');
  if(capture.status!=='captured'||Number(capture.amount)!==Number(order.amount)||String(capture.currency||'').toUpperCase()!==String(order.currency||'').toUpperCase())fail(409,'Captured resource payment amount or currency does not match this order.');
  if(!capture.id)fail(422,'The resource payment is missing its provider reference.');
  if(order.status==='CAPTURED'){
    if(order.providerReference&&order.providerReference!==capture.id)fail(409,'A different payment was already recorded for this resource order.');
    return {order,duplicate:true};
  }
  order.status='CAPTURED';order.providerReference=capture.id;order.capturedAt=new Date().toISOString();
  state.audit??=[];state.audit.push({id:auditId(),action:'store.payment-captured',orderId:order.id,userId:order.userId,providerReference:capture.id,at:order.capturedAt,source:'razorpay-webhook'});
  return {order,duplicate:false};
}

const checkout=(order,keyId)=>({id:order.id,provider:order.provider,amount:order.amount,orderId:order.providerOrderId,keyId:order.provider==='razorpay'?keyId:undefined});
export async function resourceStore(request,response,url,ctx) {
  const path=url.pathname, method=request.method;
  if(!path.startsWith('/api/store/'))return false;
  const {readState,updateState,readSession,requireAdmin,body,send,storage,filePayload,uid,isProduction}=ctx;
  const state=await readState(), products=state.storeFiles||{}, orders=state.resourceOrders||[];
  const session=readSession(request);
  const user=()=>{if(!session)fail(401,'Sign in to purchase this PDF.');return session.sub};
  const owned=id=>orders.some(o=>o.userId===session?.sub&&o.productId===id&&o.status==='CAPTURED');
  const product=id=>catalogue.find(p=>p.id===id)||fail(404,'Resource not found.');
  if(method==='GET'&&path==='/api/store/catalogue'){
    send(response,200,catalogue.map(p=>({...p,available:Boolean(products[p.id]),owned:owned(p.id)})));return true;
  }
  const upload=path.match(/^\/api\/store\/files\/([^/]+)$/);
  if(method==='PUT'&&upload){
    requireAdmin(request);const p=product(upload[1]),file=filePayload(await body(request));
    if(file.mimeType!=='application/pdf'||file.bytes.subarray(0,5).toString()!=='%PDF-')fail(422,'Upload a genuine PDF file.');
    const key='store/'+p.id+'/'+uid('pdf')+'.pdf';await storage.put(key,file.bytes,'application/pdf');
    await updateState(s=>{s.storeFiles??={};s.storeFiles[p.id]={key,fileName:file.fileName};s.audit.push({id:uid('audit'),action:'store.pdf-uploaded',productId:p.id,at:new Date().toISOString()})});
    send(response,200,{available:true});return true;
  }
  const download=path.match(/^\/api\/store\/downloads\/([^/]+)$/);
  if(method==='GET'&&download){
    user();const p=product(download[1]);
    if(!owned(p.id))fail(403,'Purchase this resource before downloading.');
    const file=products[p.id];if(!file)fail(404,'PDF not available.');
    const stored=await storage.get(file.key);
    response.writeHead(200,{'content-type':'application/pdf','cache-control':'private, no-store','content-disposition':'attachment; filename="'+p.id+'.pdf"'});
    response.end(stored.bytes);return true;
  }
  if(method==='POST'&&path==='/api/store/orders'){
    const userId=user(),p=product((await body(request)).productId);
    if(!products[p.id])fail(409,'The academy has not uploaded this PDF yet. You have not been charged.');
    if(owned(p.id)){send(response,200,{owned:true});return true}
    const provider=process.env.PAYMENT_PROVIDER||'mock';
    if(!['mock','razorpay'].includes(provider)||(isProduction&&provider==='mock'))fail(503,'Live payments are not configured.');
    const existing=orders.find(item=>item.userId===userId&&item.productId===p.id&&item.provider===provider&&item.status==='CREATED'&&(provider!=='razorpay'||item.providerOrderId));
    if(existing){send(response,200,{...checkout(existing,process.env.RAZORPAY_KEY_ID),reused:true});return true}
    const order={id:uid('resource'),userId,productId:p.id,amount:p.price*100,currency:'INR',status:'CREATED',provider};
    await updateState(s=>{s.resourceOrders??=[];s.resourceOrders.push(order);s.audit??=[];s.audit.push({id:uid('audit'),action:'store.payment-order-created',orderId:order.id,userId,productId:p.id,at:new Date().toISOString()})});
    if(provider==='razorpay'){
      if(!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)fail(503,'Razorpay is not configured.');
      let upstream;
      try{upstream=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{authorization:'Basic '+Buffer.from(process.env.RAZORPAY_KEY_ID+':'+process.env.RAZORPAY_KEY_SECRET).toString('base64'),'content-type':'application/json'},body:JSON.stringify({amount:order.amount,currency:'INR',receipt:order.id,notes:{academyResourceOrderId:order.id}}),signal:AbortSignal.timeout(15000)})}catch{upstream=null}
      if(!upstream?.ok){await updateState(s=>{const current=(s.resourceOrders||[]).find(item=>item.id===order.id);if(current){current.status='FAILED';current.failureReason='provider-order-creation-failed';current.updatedAt=new Date().toISOString()}});fail(502,'Could not create payment order.');}
      order.providerOrderId=(await upstream.json()).id;
      if(!order.providerOrderId){await updateState(s=>{const current=(s.resourceOrders||[]).find(item=>item.id===order.id);if(current){current.status='FAILED';current.failureReason='provider-order-id-missing';current.updatedAt=new Date().toISOString()}});fail(502,'Payment provider did not return an order ID.');}
      await updateState(s=>{const current=(s.resourceOrders||[]).find(item=>item.id===order.id);if(current){current.providerOrderId=order.providerOrderId;current.updatedAt=new Date().toISOString()}});
    }
    send(response,201,checkout(order,process.env.RAZORPAY_KEY_ID));return true;
  }
  const complete=path.match(/^\/api\/store\/orders\/([^/]+)\/complete$/);
  if(method==='POST'&&complete){
    const userId=user(),order=orders.find(o=>o.id===complete[1]&&o.userId===userId);
    if(!order)fail(404,'Order not found.');
    if(order.status!=='CAPTURED'){
      let providerReference=null;
      if(order.provider==='mock'){if(isProduction||(process.env.PAYMENT_PROVIDER||'mock')!=='mock')fail(403,'Test payment is disabled.')}
      else {
        const input=await body(request),secret=process.env.RAZORPAY_KEY_SECRET;
        if(!secret||input.razorpay_order_id!==order.providerOrderId)fail(403,'Payment order mismatch.');
        const expected=createHmac('sha256',secret).update(order.providerOrderId+'|'+input.razorpay_payment_id).digest('hex');
        const supplied=String(input.razorpay_signature||'');
        if(supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))fail(403,'Invalid payment signature.');
        const upstream=await fetch('https://api.razorpay.com/v1/payments/'+encodeURIComponent(input.razorpay_payment_id),{headers:{authorization:'Basic '+Buffer.from(process.env.RAZORPAY_KEY_ID+':'+secret).toString('base64')},signal:AbortSignal.timeout(15000)});
        if(!upstream.ok)fail(502,'Could not verify payment.');
        const paid=await upstream.json();
        if(paid.status!=='captured'||paid.amount!==order.amount||paid.currency!=='INR'||paid.order_id!==order.providerOrderId)fail(409,'Payment is not captured for the correct amount yet. Retry verification shortly.');
        providerReference=String(input.razorpay_payment_id||'');
      }
      await updateState(s=>{const current=s.resourceOrders.find(o=>o.id===order.id);if(!current)fail(404,'Order not found.');if(current.status==='CAPTURED')return;current.status='CAPTURED';current.providerReference=providerReference||current.providerReference||null;current.capturedAt=new Date().toISOString();s.audit.push({id:uid('audit'),action:'store.payment-captured',orderId:order.id,userId,providerReference:current.providerReference,at:current.capturedAt,source:order.provider==='razorpay'?'browser-verification':'development-mock'})});
    }
    send(response,200,{download:'/api/store/downloads/'+order.productId});return true;
  }
  send(response,404,{error:'Store endpoint not found.'});return true;
}
