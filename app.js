(async()=>{
  const result=document.getElementById('result');
  try {
    const r=await fetch('/api/config'); const c=await r.json();
    document.getElementById('config').textContent=`Patrocínio: ${c.prices_kz.advertising_sponsorship} Kz · Selo azul: ${c.prices_kz.blue_badge} Kz · Número Multicaixa Express: ${c.payment_phone}`;
  } catch { document.getElementById('config').textContent='Não foi possível carregar a configuração.'; }
  document.getElementById('paymentForm').addEventListener('submit',async e=>{
    e.preventDefault(); result.textContent='A enviar...';
    try {
      const r=await fetch('/api/payments',{method:'POST',body:new FormData(e.target)});
      const data=await r.json();
      result.textContent=r.ok?`${data.message}\nNúmero do pedido: ${data.request_id}\nGuarda este número.`:(data.error||'Falha no envio.');
      if(r.ok)e.target.reset();
    } catch { result.textContent='Erro de ligação. Tenta novamente.'; }
  });
})();
