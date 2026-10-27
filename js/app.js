if ('serviceWorker' in navigator) { window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js')); }

const firebaseConfig = {
  apiKey: "AIzaSyC6x_ZHvaH62i-tSHn7WnU7kf0hLrXuF6Q",
  authDomain: "cifra-5dc56.firebaseapp.com",
  projectId: "cifra-5dc56",
  storageBucket: "cifra-5dc56.firebasestorage.app",
  messagingSenderId: "766558242122",
  appId: "1:766558242122:web:7543073620560017d6adb3",
  measurementId: "G-5L3F28M330"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let inventory = [], clients = [], documents = [], payables = [], receivables = [], settings = {};
let currentItems = [], docTotals = {}, editDocId = null, editInvId = null, currentUser = null;
let exchangeRates = { USD: 1, DOP: 58.5, EUR: 0.92 };

async function fetchRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    exchangeRates.USD = 1;
    exchangeRates.DOP = data.rates.DOP;
    exchangeRates.EUR = data.rates.EUR;
    document.getElementById('rate-info').innerText = `Tasa del día: 1 USD = ${exchangeRates.DOP.toFixed(2)} DOP`;
    updateAllViews();
  } catch(e) { document.getElementById('rate-info').innerText = `Tasa offline (Datos guardados).`; }
}

function fMoney(val, specificCurrency = null) { 
  const cur = specificCurrency || document.getElementById('currency').value;
  let symbol = '$'; if(cur === 'DOP') symbol = 'RD$'; else if(cur === 'EUR') symbol = '€';
  return symbol + val.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); 
}

window.onload = () => {
  if(localStorage.getItem('marg_theme') === 'light') document.body.classList.add('light-mode');
  fetchRates();
  auth.onAuthStateChanged(user => {
    if (user) { currentUser = user; loadCloudData(); } 
    else { showView('view-auth'); }
  });
};

function toggleAuthForm() {
  const l = document.getElementById('form-login'); const r = document.getElementById('form-register');
  if(l.style.display === 'none') { l.style.display = 'block'; r.style.display = 'none'; } else { l.style.display = 'none'; r.style.display = 'block'; }
}

async function register() {
  const e = document.getElementById('reg-email').value, p = document.getElementById('reg-pass').value, n = document.getElementById('reg-name').value, ph = document.getElementById('reg-phone').value, id = document.getElementById('reg-id').value, dob = document.getElementById('reg-dob').value, loc = document.getElementById('reg-loc').value;
  if(!e || !p || !n) return showToast("Faltan datos obligatorios");
  try {
    showView('view-loading');
    const cred = await auth.createUserWithEmailAndPassword(e, p);
    await db.collection('users').doc(cred.user.uid).set({ name: n, phone: ph, documentId: id, dob: dob, location: loc, role: 'admin' });
  } catch(err) { showView('view-auth'); showToast(err.message); }
}

async function login() {
  const e = document.getElementById('log-email').value, p = document.getElementById('log-pass').value;
  if(!e || !p) return showToast("Ingresa credenciales");
  try { showView('view-loading'); await auth.signInWithEmailAndPassword(e, p); } catch(err) { showView('view-auth'); showToast("Error de acceso"); }
}

function logout() { auth.signOut().then(() => { location.reload(); }); }

async function loadCloudData() {
  showView('view-loading');
  const uid = currentUser.uid;
  const profile = await db.collection('users').doc(uid).get();
  if(profile.exists) {
    const pData = profile.data();
    const h = new Date().getHours(); const saludo = h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches';
    document.getElementById('greeting').innerText = `${saludo}, ${pData.name} 👋`;
    document.getElementById('user-display').innerText = pData.name;
    document.getElementById('user-loc').innerText = pData.location || '';
  }

  db.collection('users').doc(uid).collection('inventory').onSnapshot(snap => { inventory = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); updateSelects(); });
  db.collection('users').doc(uid).collection('clients').onSnapshot(snap => { clients = snap.docs.map(d => ({id: d.id, ...d.data()})); renderClients(); updateSelects(); });
  db.collection('users').doc(uid).collection('documents').onSnapshot(snap => { documents = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); });
  db.collection('users').doc(uid).collection('payables').onSnapshot(snap => { payables = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); });
  db.collection('users').doc(uid).collection('receivables').onSnapshot(snap => { receivables = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); });
  
  const setSnap = await db.collection('users').doc(uid).collection('config').doc('settings').get();
  if(setSnap.exists) { settings = setSnap.data(); document.getElementById('set-color').value = settings.color||'#111827'; document.getElementById('set-font').value = settings.font||'Helvetica'; document.getElementById('set-inv-tpl').value = settings.tplInv||'modern'; document.getElementById('set-biz-name').value = settings.name||''; document.getElementById('set-biz-id').value = settings.id||''; document.getElementById('set-biz-address').value = settings.address||''; }

  showView('view-app');
}

function updateAllViews() { renderDashboard(); renderAccounting(); renderQuotes(); renderInvoices(); renderInv(); renderPayables(); renderReceivables(); }
function showView(id) { document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); document.getElementById(id).classList.add('active'); }
function toggleSidebar() { const s = document.getElementById('sidebar'), o = document.getElementById('sidebar-overlay'); const open = s.classList.contains('open'); s.classList.toggle('open', !open); o.style.display = open ? 'none' : 'block'; }
function navTo(id, btn) { document.querySelectorAll('.app-section').forEach(s => s.classList.remove('active')); document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('active')); document.getElementById(id).classList.add('active'); if(btn) btn.classList.add('active'); toggleSidebar(); window.scrollTo(0,0); }
function toggleTheme() { const isLight = document.body.classList.toggle('light-mode'); localStorage.setItem('marg_theme', isLight ? 'light' : 'dark'); }
function showToast(msg) { const t = document.getElementById("toast"); t.innerText = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 3000); }
function compressImage(file, callback) { const r = new FileReader(); r.onload = e => { const img = new Image(); img.onload = () => { const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); let w = img.width, h = img.height; const max = 250; if(w > h) { if(w > max) { h *= max/w; w = max; } } else { if(h > max) { w *= max/h; h = max; } } canvas.width = w; canvas.height = h; ctx.drawImage(img, 0, 0, w, h); callback(canvas.toDataURL('image/jpeg', 0.7)); }; img.src = e.target.result; }; r.readAsDataURL(file); }

function getRef(col) { return db.collection('users').doc(currentUser.uid).collection(col); }

// SISTEMA DE KARDEX Y MOVIMIENTOS
async function logMovement(prodId, prodName, change, newStock, description) {
  if (change === 0) return;
  await getRef('inventory_movements').add({
    productId: prodId,
    productName: prodName,
    change: change,
    stockAfter: newStock,
    description: description,
    date: new Date().toISOString()
  });
}

// INVENTARIO
function saveInv() { 
  const n = document.getElementById('i-name').value, c = parseFloat(document.getElementById('i-cost').value)||0, p = parseFloat(document.getElementById('i-price').value)||0, s = parseInt(document.getElementById('i-stock').value)||0, f = document.getElementById('i-img').files[0]; 
  if(!n) return; 
  const cb = async (imgData) => { 
    const data = { name:n, cost:c, price:p, stock:s, img: imgData };
    let change = s;
    let desc = "Inventario inicial";
    
    if(editInvId) { 
      const oldProd = inventory.find(i => i.id === editInvId);
      change = s - (oldProd ? oldProd.stock : 0);
      desc = "Ajuste manual de inventario";
      await getRef('inventory').doc(editInvId).update(data); 
      logMovement(editInvId, n, change, s, desc);
    } else { 
      const newDoc = await getRef('inventory').add(data); 
      logMovement(newDoc.id, n, change, s, desc);
    } 
    clearInvForm(); showToast("Guardado en Nube"); 
  }; 
  if(f) compressImage(f, cb); else cb(editInvId ? inventory.find(i=>i.id===editInvId).img : null); 
}
function delInv(id) { getRef('inventory').doc(id).delete(); }
function editInv(id) { const i = inventory.find(x => x.id === id); if(!i) return; document.getElementById('i-name').value = i.name; document.getElementById('i-cost').value = i.cost; document.getElementById('i-price').value = i.price; document.getElementById('i-stock').value = i.stock; editInvId = id; document.getElementById('inv-form-title').innerText = "Editar Producto"; document.getElementById('btn-save-inv').innerText = "Actualizar Nube"; window.scrollTo(0,0); }
function clearInvForm() { document.getElementById('i-name').value=''; document.getElementById('i-cost').value='0'; document.getElementById('i-price').value='0'; document.getElementById('i-stock').value='0'; document.getElementById('i-img').value=''; editInvId = null; document.getElementById('inv-form-title').innerText = "Añadir Producto"; document.getElementById('btn-save-inv').innerText = "Guardar Nube"; }
function renderInv() { document.getElementById('inventory-list').innerHTML = inventory.map(i => `<div class="item-row"><div style="display:flex; gap:10px; align-items:center;">${i.img ? `<img src="${i.img}" class="prod-img">` : '<div class="prod-img"></div>'}<div><strong>${i.name}</strong><br><small>Venta: ${fMoney(i.price)} | Stock: ${i.stock}</small></div></div><div style="display:flex; gap:5px;"><button class="btn-small btn-outline" onclick="editInv('${i.id}')">✏️</button><button class="btn-small" style="background:var(--danger); border:none; color:#fff;" onclick="delInv('${i.id}')">✖</button></div></div>`).join(''); }

// CLIENTES CON RNC
function saveClient() { const n = document.getElementById('c-name').value, e = document.getElementById('c-email').value, a = document.getElementById('c-address').value, rnc = document.getElementById('c-rnc').value; if(!n) return; getRef('clients').add({name:n, email:e, address:a, rnc: rnc}); document.getElementById('c-name').value=''; document.getElementById('c-email').value=''; document.getElementById('c-address').value=''; document.getElementById('c-rnc').value=''; showToast("Cliente Guardado"); }
function delClient(id) { getRef('clients').doc(id).delete(); }
function renderClients() { document.getElementById('client-list').innerHTML = clients.map(c => `<div class="item-row"><div><strong>${c.name}</strong><br><small>${c.rnc ? 'RNC: '+c.rnc+' | ' : ''}${c.email} | ${c.address}</small></div><button class="btn-small" style="background:var(--danger); border:none; color:#fff;" onclick="delClient('${c.id}')">✖</button></div>`).join(''); }
function updateSelects() { document.getElementById('dl-clients').innerHTML = clients.map(c => `<option value="${c.name}">`).join(''); document.getElementById('doc-product-select').innerHTML = inventory.map(i => `<option value="${i.id}">${i.name} (${fMoney(i.price)})</option>`).join(''); }

function savePayable() { const c = document.getElementById('p-concept').value, a = parseFloat(document.getElementById('p-amount').value), d = document.getElementById('p-date').value; if(!c || isNaN(a) || a<=0) return; getRef('payables').add({concept: c, amount: a, date: d, status: 'Pendiente'}); document.getElementById('p-concept').value=''; document.getElementById('p-amount').value='0'; showToast("Registrado"); }
function togglePayableStatus(id, stat) { getRef('payables').doc(id).update({status: stat}); }
function delPayable(id) { getRef('payables').doc(id).delete(); }
function renderPayables() { document.getElementById('payables-list').innerHTML = payables.map(p => `<div class="item-row"><div><strong>${p.concept}</strong><br><small>${p.date ? 'Vence: '+p.date : 'Sin fecha'} | ${fMoney(p.amount)}</small></div><div style="display:flex;gap:5px;align-items:center;"><select style="font-size:11px;padding:2px;" onchange="togglePayableStatus('${p.id}', this.value)"><option value="Pendiente" ${p.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagado" ${p.status==='Pagado'?'selected':''}>Pagado</option></select><button class="btn-small" style="background:var(--danger);border:none;color:#fff;" onclick="delPayable('${p.id}')">✖</button></div></div>`).join('') || '<p style="color:var(--muted);font-size:13px;">No hay cuentas.</p>'; }

function saveReceivable() { const c = document.getElementById('r-concept').value, a = parseFloat(document.getElementById('r-amount').value), d = document.getElementById('r-date').value; if(!c || isNaN(a) || a<=0) return; getRef('receivables').add({concept: c, amount: a, date: d, status: 'Pendiente'}); document.getElementById('r-concept').value=''; document.getElementById('r-amount').value='0'; showToast("Guardado"); }
function toggleReceivableStatus(id, stat) { getRef('receivables').doc(id).update({status: stat}); }
function delReceivable(id) { getRef('receivables').doc(id).delete(); }
function renderReceivables() { document.getElementById('receivables-list').innerHTML = receivables.map(r => `<div class="item-row"><div><strong>${r.concept}</strong><br><small>${r.date ? 'Vence: '+r.date : 'Sin fecha'} | ${fMoney(r.amount)}</small></div><div style="display:flex;gap:5px;align-items:center;"><select style="font-size:11px;padding:2px;" onchange="toggleReceivableStatus('${r.id}', this.value)"><option value="Pendiente" ${r.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagado" ${r.status==='Pagado'?'selected':''}>Pagado</option></select><button class="btn-small" style="background:var(--danger);border:none;color:#fff;" onclick="delReceivable('${r.id}')">✖</button></div></div>`).join('') || '<p style="color:var(--muted);font-size:13px;">No hay cuentas.</p>'; }

// GENERADOR DE DOCUMENTOS
function openDocBuilder(type) { clearDoc(); document.getElementById('doc-type').value = type; toggleDocUI(); document.getElementById('doc-title-label').innerText = `Nueva ${type}`; navTo('sec-doc-builder'); }
function toggleDocUI() { const type = document.getElementById('doc-type').value; document.getElementById('div-factura-options').style.display = type === 'Factura' ? 'flex' : 'none'; document.getElementById('btn-facturar-cot').style.display = type === 'Cotización' ? 'block' : 'none'; document.getElementById('btn-save-doc').innerText = type === 'Cotización' ? 'Guardar Cotización' : 'Guardar Factura'; }
function startFromProd(type, prodId) { openDocBuilder(type); const p = inventory.find(x => x.id === prodId); if(p) { currentItems = [{id: p.id, name: p.name, cost: p.cost, price: p.price, qty: 1}]; renderDocItems(); calcDoc(); } }
function fillClientData() { const name = document.getElementById('doc-client-name').value; const c = clients.find(x => x.name === name); if(c) { document.getElementById('doc-client-email').value = c.email; document.getElementById('doc-client-phone').value = c.address; document.getElementById('doc-client-rnc').value = c.rnc || ''; } }
function addDocItem() { const id = document.getElementById('doc-product-select').value, qty = parseFloat(document.getElementById('doc-qty').value); if(!id||isNaN(qty) || qty<=0) return; const prod = inventory.find(i => i.id === id); currentItems.push({id: prod.id, name: prod.name, cost: prod.cost, price: prod.price, qty}); document.getElementById('doc-qty').value='1'; renderDocItems(); calcDoc(); }
function delDocItem(idx) { currentItems.splice(idx,1); renderDocItems(); calcDoc(); }
function renderDocItems() { document.getElementById('doc-items-list').innerHTML = currentItems.map((item, idx) => `<div class="item-row"><span style="font-size:13px;">${item.qty}x <strong>${item.name}</strong></span><div>${fMoney(item.price * item.qty)} <button style="background:none;border:none;color:var(--danger);margin-left:10px;" onclick="delDocItem(${idx})">✖</button></div></div>`).join(''); }

function calcDoc() {
  const cur = document.getElementById('currency').value;
  const subtotal = currentItems.reduce((s, i) => s + (i.price * i.qty), 0), totalCost = currentItems.reduce((s, i) => s + (i.cost * i.qty), 0);
  const taxPct = parseFloat(document.getElementById('doc-tax').value)||0, discPct = parseFloat(document.getElementById('doc-disc').value)||0;
  let total = subtotal, labor = 0;
  labor = (parseFloat(document.getElementById('doc-hours').value)||0) * (parseFloat(document.getElementById('doc-rate').value)||0); 
  total += labor; 
  const discAmt = total * (discPct/100); total -= discAmt; const taxAmt = total * (taxPct/100); total += taxAmt;
  const profit = total - taxAmt - totalCost; 
  docTotals = { subtotal, discAmt, taxAmt, total, taxPct, discPct, labor, profit, totalCost, currency: cur, exchangeRate: exchangeRates[cur] || 1 }; 
  document.getElementById('s-sub').innerText = fMoney(subtotal); document.getElementById('s-total-label').innerText = document.getElementById('doc-type').value === 'Factura' ? 'Total:' : 'Sugerido:'; document.getElementById('s-final').innerText = fMoney(total);
}

async function convertAndSave() { document.getElementById('doc-type').value = 'Factura'; toggleDocUI(); saveDoc(true); }

async function getSequentialNumber(type) {
  const counterRef = db.collection('users').doc(currentUser.uid).collection('config').doc('counters');
  return await db.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);
    const field = type === 'Factura' ? 'invoiceCount' : 'quoteCount';
    const prefix = type === 'Factura' ? 'FAC-' : 'COT-';
    let newCount = 1;
    if (!counterDoc.exists) { transaction.set(counterRef, { [field]: newCount }, { merge: true }); } 
    else { newCount = (counterDoc.data()[field] || 0) + 1; transaction.update(counterRef, { [field]: newCount }); }
    return `${prefix}${newCount.toString().padStart(4, '0')}`;
  });
}

// LOGICA CENTRAL DE GUARDADO E INVENTARIO
async function saveDoc(isConverting = false) {
  const name = document.getElementById('doc-client-name').value, type = document.getElementById('doc-type').value; 
  if(!name || currentItems.length === 0) { showToast("Faltan datos en el documento"); return; }
  
  const oldDoc = editDocId ? documents.find(d => d.id === editDocId) : null; 
  let docNum = oldDoc ? oldDoc.num : '';
  
  // VALIDACIÓN DE STOCK (Evita guardado si hay inventario negativo)
  let stockUpdates = [];
  if (type === 'Factura') {
    for (const item of currentItems) {
      const prod = inventory.find(x => x.id === item.id);
      if (!prod) continue;
      
      let oldQty = 0;
      // Si estamos editando una factura (no convirtiendo de cotización)
      if (oldDoc && oldDoc.type === 'Factura' && !isConverting) {
        const oldItem = oldDoc.items.find(x => x.id === item.id);
        if (oldItem) oldQty = oldItem.qty;
      }
      
      const qtyDifference = item.qty - oldQty; // Cuánto MÁS estamos facturando ahora
      
      // Bloqueador de Inventario Negativo
      if (qtyDifference > 0 && prod.stock < qtyDifference) {
        showToast(`Stock insuficiente para: ${item.name}. Disponibles: ${prod.stock}`);
        return; // DETIENE EL GUARDADO COMPLETAMENTE
      }
      
      if (qtyDifference !== 0) {
        stockUpdates.push({ id: prod.id, name: prod.name, change: -qtyDifference, newStock: prod.stock - qtyDifference, desc: oldDoc && !isConverting ? `Edición Fac. ${docNum || 'Pendiente'}` : `Venta Fac. ${docNum || 'Pendiente'}` });
      }
    }
    
    // Restaurar productos que fueron eliminados de la lista al editar una factura
    if (oldDoc && oldDoc.type === 'Factura' && !isConverting) {
      for (const oldItem of oldDoc.items) {
        if (!currentItems.find(x => x.id === oldItem.id)) {
          const prod = inventory.find(x => x.id === oldItem.id);
          if (prod) { stockUpdates.push({ id: prod.id, name: prod.name, change: oldItem.qty, newStock: prod.stock + oldItem.qty, desc: `Restaurado de Fac. ${docNum}` }); }
        }
      }
    }
  }

  // Genera el número transaccional si pasó las validaciones y es documento nuevo
  if (!oldDoc || (oldDoc.type === 'Cotización' && type === 'Factura')) {
    showToast("Generando correlativo seguro...");
    docNum = await getSequentialNumber(type);
    // Actualizamos las descripciones del kardex con el número oficial
    stockUpdates.forEach(update => { update.desc = update.desc.replace('Pendiente', docNum); });
  }

  // APLICA LAS ACTUALIZACIONES DE INVENTARIO Y REGISTRA EN EL KARDEX
  for (const update of stockUpdates) {
    await getRef('inventory').doc(update.id).update({ stock: update.newStock });
    await logMovement(update.id, update.name, update.change, update.newStock, update.desc);
  }
  
  const pm = document.getElementById('doc-payment').value; let finalStatus = 'Activa';
  if (type === 'Factura') { if (pm === 'Crédito') finalStatus = 'Crédito'; else if (pm === 'Efectivo' || pm === 'Transferencia') finalStatus = 'Pagada'; else finalStatus = 'Pendiente'; }
  if (oldDoc && oldDoc.type === 'Factura' && !isConverting) finalStatus = oldDoc.status;
  
  const doc = { 
    num: docNum, type, date: new Date().toLocaleDateString(), dueDate: document.getElementById('doc-due-date').value, paymentMethod: pm, 
    client: { name, rnc: document.getElementById('doc-client-rnc').value, email: document.getElementById('doc-client-email').value, phone: document.getElementById('doc-client-phone').value }, 
    items: [...currentItems], totals: docTotals, status: finalStatus 
  };
  
  if(editDocId && !isConverting) { await getRef('documents').doc(editDocId).update(doc); } else { await getRef('documents').add(doc); }
  showToast("Guardado Exitosamente"); navTo(type === 'Factura' ? 'sec-invoices' : 'sec-quotes');
}

function editDoc(id) {
  const d = documents.find(x => x.id === id); if(!d) return; openDocBuilder(d.type); document.getElementById('doc-title-label').innerText = "Editando " + d.num; editDocId = d.id;
  if(d.dueDate) document.getElementById('doc-due-date').value = d.dueDate;
  if(d.paymentMethod) document.getElementById('doc-payment').value = d.paymentMethod;
  document.getElementById('doc-client-name').value = d.client.name; document.getElementById('doc-client-rnc').value = d.client.rnc || ''; document.getElementById('doc-client-email').value = d.client.email; document.getElementById('doc-client-phone').value = d.client.phone;
  currentItems = [...d.items]; document.getElementById('doc-tax').value = d.totals.taxPct; document.getElementById('doc-disc').value = d.totals.discPct; renderDocItems(); calcDoc();
}
function clearDoc() { editDocId = null; document.getElementById('doc-client-name').value=''; document.getElementById('doc-client-rnc').value=''; document.getElementById('doc-client-email').value=''; document.getElementById('doc-client-phone').value=''; currentItems=[]; renderDocItems(); calcDoc(); }
function changeStatus(id, newStatus) { getRef('documents').doc(id).update({status: newStatus}); }
function delDoc(id) { getRef('documents').doc(id).delete(); }

function renderDocList(type, containerId) {
  document.getElementById(containerId).innerHTML = documents.filter(d => d.type === type).map(d => `
    <div class="card" style="margin-bottom:10px;"><div style="display:flex; justify-content:space-between; margin-bottom:5px;"><div><span class="badge ${d.type.toLowerCase()}">${d.num}</span> 
    ${d.type==='Factura' ? `<select style="width:auto; padding:2px; font-size:11px; margin-left:5px;" onchange="changeStatus('${d.id}', this.value)"><option value="Sin Pagar" ${d.status==='Sin Pagar'?'selected':''}>Sin Pagar</option><option value="Crédito" ${d.status==='Crédito'?'selected':''}>Crédito</option><option value="Pendiente" ${d.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagada" ${d.status==='Pagada'?'selected':''}>Pagada</option></select>` : ''}</div>
    <strong style="color:var(--accent);">${fMoney(d.totals.total, d.totals.currency || 'USD')}</strong></div><strong>${d.client.name}</strong> <small style="color:var(--muted)">| ${d.date}</small>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;"><button class="btn btn-outline btn-small" onclick="genPDF('${d.id}')">📄 PDF</button><button class="btn btn-outline btn-small" onclick="editDoc('${d.id}')">✏️ Editar</button><button class="btn btn-small" style="background:transparent;border:1px solid var(--danger);color:var(--danger);" onclick="delDoc('${d.id}')">Borrar</button></div></div>`).join('') || '<p style="color:var(--muted); text-align:center;">No hay documentos.</p>';
}
function renderQuotes() { renderDocList('Cotización', 'quote-list'); } function renderInvoices() { renderDocList('Factura', 'invoice-list'); }

function renderDashboard() {
  const targetCurrency = document.getElementById('currency').value;
  const targetRate = exchangeRates[targetCurrency] || 1;
  let fTot = 0, arTot = 0;
  
  documents.forEach(d => { 
    const docRate = d.totals.exchangeRate || 1;
    const normalizedUSD = d.totals.total / docRate; 
    const valueInCurrentSelected = normalizedUSD * targetRate; 

    if(d.type === 'Factura' && d.status === 'Pagada') fTot += valueInCurrentSelected; 
    if(d.type === 'Factura' && ['Crédito', 'Sin Pagar', 'Pendiente'].includes(d.status)) arTot += valueInCurrentSelected;
  });
  
  receivables.filter(r => r.status === 'Pendiente').forEach(r => arTot += r.amount); 
  
  document.getElementById('dash-inv-total').innerText = fMoney(fTot); document.getElementById('dash-quo-total').innerText = fMoney(arTot);
  document.getElementById('dash-inv-cards').innerHTML = inventory.map(i => `<div class="prod-card">${i.img ? `<img src="${i.img}">` : `<div style="width:100%;height:80px;background:var(--bg);border-radius:8px;margin-bottom:8px;"></div>`}<h4>${i.name}</h4><p>${fMoney(i.price)}<br>Stock: ${i.stock}</p><div class="btn-group"><button class="btn btn-outline" onclick="startFromProd('Cotización', '${i.id}')">Cotizar</button><button class="btn btn-primary" onclick="startFromProd('Factura', '${i.id}')">Facturar</button></div></div>`).join('') || '<p style="font-size:12px; color:var(--muted);">Vacío.</p>';
}

function renderAccounting() {
  const targetCurrency = document.getElementById('currency').value;
  const targetRate = exchangeRates[targetCurrency] || 1;
  let prof = 0, taxes = 0, invNet = 0, ar = 0, ap = 0;
  
  documents.forEach(d => {
    const docRate = d.totals.exchangeRate || 1;
    const localProfit = ((d.totals.profit || 0) / docRate) * targetRate;
    const localTax = (d.totals.taxAmt / docRate) * targetRate;
    const localTotal = (d.totals.total / docRate) * targetRate;

    if(d.type === 'Factura' && d.status === 'Pagada') { prof += localProfit; taxes += localTax; }
    if(d.type === 'Factura' && ['Crédito', 'Sin Pagar', 'Pendiente'].includes(d.status)) ar += localTotal;
  });

  receivables.filter(r => r.status === 'Pendiente').forEach(r => ar += r.amount); 
  payables.filter(p => p.status === 'Pendiente').forEach(p => ap += p.amount);
  inventory.forEach(i => invNet += (i.cost * i.stock));
  
  document.getElementById('acc-profit').innerText = fMoney(prof); document.getElementById('acc-tax').innerText = fMoney(taxes); document.getElementById('acc-inv-value').innerText = fMoney(invNet); document.getElementById('acc-ar').innerText = fMoney(ar); document.getElementById('acc-ap').innerText = fMoney(ap);
}

function handleLogoUpload(e) { const r = new FileReader(); r.onload = evt => { settings.logo = evt.target.result; saveSettings(true); }; r.readAsDataURL(e.target.files[0]); }
async function saveSettings(silent=false) { settings.color = document.getElementById('set-color').value; settings.font = document.getElementById('set-font').value; settings.tplInv = document.getElementById('set-inv-tpl').value; settings.name = document.getElementById('set-biz-name').value; settings.id = document.getElementById('set-biz-id').value; settings.address = document.getElementById('set-biz-address').value; await db.collection('users').doc(currentUser.uid).collection('config').doc('settings').set(settings); if(!silent) showToast("Configuración Nube Guardada"); }

function genPDF(id) {
  const d = documents.find(x => x.id === id); if(!d) return; showToast("Generando..."); 
  const cur = d.totals.currency || 'USD'; 
  const w = document.getElementById('pdf-wrapper'), c = document.getElementById('pdf-container'), h = document.getElementById('pdf-header'); c.style.fontFamily = settings.font;
  if(settings.tplInv === 'modern') { h.style.background = settings.color; h.style.color = '#fff'; h.style.borderBottom = 'none'; document.getElementById('pdf-type').style.color = '#fff'; document.getElementById('pdf-total-row').style.color = settings.color; } else { h.style.background = 'transparent'; h.style.color = '#000'; h.style.borderBottom = `4px solid ${settings.color}`; document.getElementById('pdf-type').style.color = settings.color; document.getElementById('pdf-total-row').style.color = settings.color; }
  document.getElementById('pdf-logo-img').src = settings.logo || ''; document.getElementById('pdf-logo-img').style.display = settings.logo ? 'block' : 'none';
  document.getElementById('pdf-biz-name').innerText = settings.name; document.getElementById('pdf-biz-meta').innerHTML = `${settings.id?'RNC: '+settings.id+'<br>':''}${settings.address}`;
  document.getElementById('pdf-type').innerText = d.type; document.getElementById('pdf-meta').innerHTML = `<strong>Nº:</strong> ${d.num}<br><strong>Fecha:</strong> ${d.date}${d.dueDate?'<br><strong>Vence:</strong> '+d.dueDate:''}${d.paymentMethod ? '<br><strong>Pago:</strong> '+d.paymentMethod : ''}`;
  document.getElementById('pdf-cli-name').innerText = d.client.name; 
  document.getElementById('pdf-cli-meta').innerHTML = `${d.client.rnc?'RNC/Cédula: '+d.client.rnc+'<br>':''}${d.client.email}<br>${d.client.phone}`;
  const st = document.getElementById('pdf-status-stamp'); if(d.type==='Factura' && d.status==='Pagada') st.innerHTML = '<h2 style="color:#22c55e;border:4px solid #22c55e;padding:10px;transform:rotate(-15deg);display:inline-block;">PAGADA</h2>'; else st.innerHTML = '';
  
  let table = d.items.map(i => `<tr><td>${i.name}</td><td style="text-align:center;">${i.qty}</td><td style="text-align:right;">${fMoney(i.price, cur)}</td><td style="text-align:right;">${fMoney(i.price * i.qty, cur)}</td></tr>`).join('');
  if(d.totals.labor > 0) table += `<tr><td>Servicios / Mano de Obra</td><td style="text-align:center;">-</td><td style="text-align:right;">-</td><td style="text-align:right;">${fMoney(d.totals.labor, cur)}</td></tr>`;
  document.getElementById('pdf-table-body').innerHTML = table;
  
  document.getElementById('pdf-sub').innerText = fMoney(d.totals.subtotal, cur); document.getElementById('pdf-disc').innerText = `-${fMoney(d.totals.discAmt, cur)}`; document.getElementById('pdf-row-disc').style.display = d.totals.discAmt>0?'flex':'none'; document.getElementById('pdf-tax').innerText = `+${fMoney(d.totals.taxAmt, cur)}`; document.getElementById('pdf-row-tax').style.display = d.totals.taxAmt>0?'flex':'none'; document.getElementById('pdf-total').innerText = fMoney(d.totals.total, cur); document.getElementById('pdf-total-label').innerText = d.type==='Factura'?'Total:':'Sugerido:';
  w.style.display = 'block'; html2pdf().set({ margin:0, filename:`${d.num}.pdf`, image:{type:'jpeg',quality:1}, html2canvas:{scale:2}, jsPDF:{unit:'in',format:'letter',orientation:'portrait'} }).from(c).save().then(() => { w.style.display = 'none'; showToast("¡Descargado!"); });
}
