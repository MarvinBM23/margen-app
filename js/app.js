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
let currentItems = [], docTotals = {}, editDocId = null, editInvId = null, currentUser = null, currentBusinessId = null, currentUserRole = 'Cajero';
let exchangeRates = { USD: 1, DOP: 58.5, EUR: 0.92 };
let isRegistering = false;

async function fetchRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    exchangeRates.USD = 1; exchangeRates.DOP = data.rates.DOP; exchangeRates.EUR = data.rates.EUR;
    const rateInfo = document.getElementById('rate-info');
    if(rateInfo) rateInfo.innerText = `Tasa del día: 1 USD = ${exchangeRates.DOP.toFixed(2)} DOP`;
    updateAllViews();
  } catch(e) { 
    const rateInfo = document.getElementById('rate-info');
    if(rateInfo) rateInfo.innerText = `Tasa offline (Datos guardados).`; 
  }
}

function fMoney(val, specificCurrency = null) { 
  const curEl = document.getElementById('currency');
  const cur = specificCurrency || (curEl ? curEl.value : 'DOP');
  let symbol = '$'; if(cur === 'DOP') symbol = 'RD$'; else if(cur === 'EUR') symbol = '€';
  return symbol + val.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); 
}

window.onload = () => {
  if(localStorage.getItem('marg_theme') === 'light') document.body.classList.add('light-mode');
  fetchRates();
  auth.onAuthStateChanged(user => { 
    if (user) { 
      currentUser = user; 
      if(!isRegistering) loadCloudData(); 
    } else { 
      showView('view-auth'); 
    } 
  });
};

function toggleAuthForm() {
  const l = document.getElementById('form-login'); const r = document.getElementById('form-register');
  if(!l || !r) return;
  if(l.style.display === 'none') { l.style.display = 'block'; r.style.display = 'none'; } else { l.style.display = 'none'; r.style.display = 'block'; }
}

async function register() {
  const eEl = document.getElementById('reg-email'), pEl = document.getElementById('reg-pass'), nEl = document.getElementById('reg-name');
  const phEl = document.getElementById('reg-phone'), idEl = document.getElementById('reg-id'), dobEl = document.getElementById('reg-dob'), locEl = document.getElementById('reg-loc');
  
  if(!eEl || !pEl || !nEl || !locEl) return;
  const e = eEl.value, p = pEl.value, n = nEl.value, ph = phEl ? phEl.value : '', id = idEl ? idEl.value : '', dob = dobEl ? dobEl.value : '', loc = locEl.value;

  if(!e || !p || !n || !loc) return showToast("Faltan datos (Incluye Ubicación/Negocio)");
  try {
    isRegistering = true;
    showView('view-loading'); 
    const cred = await auth.createUserWithEmailAndPassword(e, p);
    const bizRef = db.collection('businesses').doc(); 
    await db.collection('users').doc(cred.user.uid).set({ name: n, phone: ph, documentId: id, dob: dob, businessId: bizRef.id, role: 'Dueño' });
    await bizRef.set({ name: loc, ownerId: cred.user.uid, createdAt: Date.now() });
    await bizRef.collection('config').doc('counters').set({ invoiceCount: 0, quoteCount: 0 });
    isRegistering = false;
    loadCloudData();
  } catch(err) { 
    isRegistering = false;
    showView('view-auth'); 
    showToast(err.message); 
  }
}

async function login() {
  const eEl = document.getElementById('log-email'), pEl = document.getElementById('log-pass');
  if(!eEl || !pEl) return;
  const e = eEl.value, p = pEl.value;
  if(!e || !p) return showToast("Ingresa credenciales");
  try { showView('view-loading'); await auth.signInWithEmailAndPassword(e, p); } catch(err) { showView('view-auth'); showToast("Error de acceso"); }
}

function logout() { auth.signOut().then(() => { location.reload(); }); }

async function loadCloudData() {
  try {
    showView('view-loading');
    const profile = await db.collection('users').doc(currentUser.uid).get();
    
    if(!profile.exists) { 
      // Si el usuario existe en Auth pero no tiene documento en Firestore, lo creamos de emergencia
      currentBusinessId = currentUser.uid;
      await db.collection('users').doc(currentUser.uid).set({ name: currentUser.email.split('@')[0], businessId: currentBusinessId, role: 'Dueño' });
      await db.collection('businesses').doc(currentBusinessId).set({ name: 'Mi Negocio', ownerId: currentUser.uid, createdAt: Date.now() });
    } else {
      const pData = profile.data();
      currentBusinessId = pData.businessId;
      if(!currentBusinessId) {
        currentBusinessId = currentUser.uid;
        await db.collection('users').doc(currentUser.uid).update({ businessId: currentBusinessId, role: 'Dueño' });
        await db.collection('businesses').doc(currentBusinessId).set({ name: pData.location || 'Mi Negocio', ownerId: currentUser.uid, createdAt: Date.now() });
      }
    }

    const userDoc = await db.collection('users').doc(currentUser.uid).get();
    const pData = userDoc.data();
    currentUserRole = pData.role || 'Cajero';
    currentBusinessId = pData.businessId;

    const bizSnap = await db.collection('businesses').doc(currentBusinessId).get();
    const bizName = bizSnap.exists ? bizSnap.data().name : 'Empresa';

    const h = new Date().getHours(); const saludo = h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches';
    const greetEl = document.getElementById('greeting'), userDisp = document.getElementById('user-display'), userLoc = document.getElementById('user-loc');
    if(greetEl) greetEl.innerText = `${saludo}, ${pData.name} 👋`;
    if(userDisp) userDisp.innerText = pData.name;
    if(userLoc) userLoc.innerText = `${bizName} (${currentUserRole})`;

    const isAdmin = ['Dueño', 'Administrador'].includes(currentUserRole);
    const navAcc = document.getElementById('nav-accounting'), navSet = document.getElementById('nav-settings'), adminPanel = document.getElementById('admin-team-panel'), myCode = document.getElementById('t-my-code');
    if(navAcc) navAcc.style.display = isAdmin ? 'block' : 'none';
    if(navSet) navSet.style.display = isAdmin ? 'block' : 'none';
    if(adminPanel) adminPanel.style.display = isAdmin ? 'block' : 'none';
    if(myCode) myCode.innerText = currentBusinessId;

    if (isAdmin) {
      db.collection('users').where('businessId', '==', currentBusinessId).onSnapshot(snap => {
        const team = snap.docs.map(d => ({id: d.id, ...d.data()}));
        const teamList = document.getElementById('team-list');
        if(teamList) {
          teamList.innerHTML = team.map(member => `
            <div class="item-row">
              <div><strong>${member.name}</strong><br><small>${member.role}</small></div>
              ${member.id !== currentUser.uid && currentUserRole === 'Dueño' ? `<select style="font-size:11px; padding:2px; margin-left:10px;" onchange="changeRole('${member.id}', this.value)"><option value="Cajero" ${member.role==='Cajero'?'selected':''}>Cajero</option><option value="Administrador" ${member.role==='Administrador'?'selected':''}>Admin</option></select>` : ''}
            </div>
          `).join('');
        }
      });
    }

    db.collection('businesses').doc(currentBusinessId).collection('inventory').onSnapshot(snap => { inventory = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); updateSelects(); });
    db.collection('businesses').doc(currentBusinessId).collection('clients').onSnapshot(snap => { clients = snap.docs.map(d => ({id: d.id, ...d.data()})); renderClients(); updateSelects(); });
    db.collection('businesses').doc(currentBusinessId).collection('documents').onSnapshot(snap => { documents = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); });
    db.collection('businesses').doc(currentBusinessId).collection('payables').onSnapshot(snap => { payables = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); });
    db.collection('businesses').doc(currentBusinessId).collection('receivables').onSnapshot(snap => { receivables = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); });
    
    const setSnap = await db.collection('businesses').doc(currentBusinessId).collection('config').doc('settings').get();
    if(setSnap.exists) { 
      settings = setSnap.data(); 
      const setColor = document.getElementById('set-color'), setFont = document.getElementById('set-font'), setTpl = document.getElementById('set-inv-tpl'), setBizName = document.getElementById('set-biz-name'), setBizId = document.getElementById('set-biz-id'), setBizAddr = document.getElementById('set-biz-address');
      if(setColor) setColor.value = settings.color||'#111827'; 
      if(setFont) setFont.value = settings.font||'Helvetica'; 
      if(setTpl) setTpl.value = settings.tplInv||'modern'; 
      if(setBizName) setBizName.value = settings.name||''; 
      if(setBizId) setBizId.value = settings.id||''; 
      if(setBizAddr) setBizAddr.value = settings.address||''; 
    }

    showView('view-app');
  } catch (err) {
    console.error("Error al cargar datos en la nube:", err);
    showToast("Error al sincronizar datos");
    showView('view-auth');
  }
}

function updateAllViews() { renderDashboard(); renderAccounting(); renderQuotes(); renderInvoices(); renderInv(); renderPayables(); renderReceivables(); }
function showView(id) { 
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); 
  const target = document.getElementById(id);
  if(target) target.classList.add('active'); 
}
function toggleSidebar() { const s = document.getElementById('sidebar'), o = document.getElementById('sidebar-overlay'); if(!s || !o) return; const open = s.classList.contains('open'); s.classList.toggle('open', !open); o.style.display = open ? 'none' : 'block'; }
function navTo(id, btn) { document.querySelectorAll('.app-section').forEach(s => s.classList.remove('active')); document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('active')); const target = document.getElementById(id); if(target) target.classList.add('active'); if(btn) btn.classList.add('active'); toggleSidebar(); window.scrollTo(0,0); }
function toggleTheme() { const isLight = document.body.classList.toggle('light-mode'); localStorage.setItem('marg_theme', isLight ? 'light' : 'dark'); }
function showToast(msg) { const t = document.getElementById("toast"); if(!t) return; t.innerText = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 3000); }
function compressImage(file, callback) { const r = new FileReader(); r.onload = e => { const img = new Image(); img.onload = () => { const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); let w = img.width, h = img.height; const max = 250; if(w > h) { if(w > max) { h *= max/w; w = max; } } else { if(h > max) { w *= max/h; h = max; } } canvas.width = w; canvas.height = h; ctx.drawImage(img, 0, 0, w, h); callback(canvas.toDataURL('image/jpeg', 0.7)); }; img.src = e.target.result; }; r.readAsDataURL(file); }

async function joinBusiness() {
  const codeEl = document.getElementById('t-join-code');
  if(!codeEl) return;
  const code = codeEl.value.trim();
  if(!code) return;
  if(!confirm("¿Seguro que deseas unirte a esta empresa? Perderás acceso a tu espacio actual.")) return;
  try {
    showView('view-loading');
    await db.collection('users').doc(currentUser.uid).update({ businessId: code, role: 'Cajero' });
    location.reload();
  } catch(e) { showToast("Error al vincular cuenta"); showView('view-app'); }
}

async function changeRole(userId, newRole) {
  try { await db.collection('users').doc(userId).update({ role: newRole }); showToast("Rol actualizado"); } 
  catch(e) { showToast("Error de permisos"); }
}

function getRef(col) { return db.collection('businesses').doc(currentBusinessId).collection(col); }

async function logMovement(prodId, prodName, change, newStock, description) {
  if (change === 0) return;
  await getRef('inventory_movements').add({ productId: prodId, productName: prodName, change: change, stockAfter: newStock, description: description, date: new Date().toISOString() });
}

function saveInv() { 
  const n = document.getElementById('i-name').value, c = parseFloat(document.getElementById('i-cost').value)||0, p = parseFloat(document.getElementById('i-price').value)||0, s = parseInt(document.getElementById('i-stock').value)||0, f = document.getElementById('i-img').files[0]; 
  if(!n) return; 
  const cb = async (imgData) => { 
    const data = { name:n, cost:c, price:p, stock:s, img: imgData };
    let change = s; let desc = "Inventario inicial";
    if(editInvId) { 
      const oldProd = inventory.find(i => i.id === editInvId);
      change = s - (oldProd ? oldProd.stock : 0); desc = "Ajuste manual de inventario";
      await getRef('inventory').doc(editInvId).update(data); logMovement(editInvId, n, change, s, desc);
    } else { const newDoc = await getRef('inventory').add(data); logMovement(newDoc.id, n, change, s, desc); } 
    clearInvForm(); showToast("Guardado en Nube"); 
  }; 
  if(f) compressImage(f, cb); else cb(editInvId ? inventory.find(i=>i.id===editInvId).img : null); 
}
function delInv(id) { getRef('inventory').doc(id).delete(); }
function editInv(id) { const i = inventory.find(x => x.id === id); if(!i) return; document.getElementById('i-name').value = i.name; document.getElementById('i-cost').value = i.cost; document.getElementById('i-price').value = i.price; document.getElementById('i-stock').value = i.stock; editInvId = id; document.getElementById('inv-form-title').innerText = "Editar Producto"; document.getElementById('btn-save-inv').innerText = "Actualizar Nube"; window.scrollTo(0,0); }
function clearInvForm() { document.getElementById('i-name').value=''; document.getElementById('i-cost').value='0'; document.getElementById('i-price').value='0'; document.getElementById('i-stock').value='0'; document.getElementById('i-img').value=''; editInvId = null; document.getElementById('inv-form-title').innerText = "Añadir Producto"; document.getElementById('btn-save-inv').innerText = "Guardar Nube"; }
function renderInv() { const el = document.getElementById('inventory-list'); if(el) el.innerHTML = inventory.map(i => `<div class="item-row"><div style="display:flex; gap:10px; align-items:center;">${i.img ? `<img src="${i.img}" class="prod-img">` : '<div class="prod-img"></div>'}<div><strong>${i.name}</strong><br><small>Venta: ${fMoney(i.price)} | Stock: ${i.stock}</small></div></div><div style="display:flex; gap:5px;"><button class="btn-small btn-outline" onclick="editInv('${i.id}')">✏️</button><button class="btn-small" style="background:var(--danger); border:none; color:#fff;" onclick="delInv('${i.id}')">✖</button></div></div>`).join(''); }

function closeModal(id) { const modal = document.getElementById(id); if(modal) modal.classList.remove('active'); }
function openClientProfile(id) {
  const c = clients.find(x => x.id === id); if(!c) return;
  document.getElementById('mc-name').innerText = c.name; document.getElementById('mc-contact').innerText = `${c.rnc ? 'RNC: '+c.rnc+' | ' : ''}${c.phone||c.address}`;
  let bought = 0, owed = 0; const cDocs = documents.filter(d => d.client.name === c.name && d.type === 'Factura'); let htmlDocs = '';
  const targetCurrency = document.getElementById('currency').value; const targetRate = exchangeRates[targetCurrency] || 1;
  cDocs.forEach(d => {
    const dRate = d.totals.exchangeRate || 1; const localVal = (d.totals.total / dRate) * targetRate; 
    if (d.status === 'Pagada') bought += localVal; if (['Crédito', 'Sin Pagar', 'Pendiente'].includes(d.status)) owed += localVal;
    htmlDocs += `<div class="item-row" style="padding:6px;"><span style="font-size:12px;"><strong>${d.num}</strong><br>${d.date}</span><div style="text-align:right;"><span class="badge ${d.status==='Pagada'?'factura':''}">${d.status}</span><br><strong style="font-size:12px; color:var(--accent);">${fMoney(localVal)}</strong></div></div>`;
  });
  document.getElementById('mc-bought').innerText = fMoney(bought); document.getElementById('mc-owed').innerText = fMoney(owed); document.getElementById('mc-docs').innerHTML = htmlDocs || '<p style="font-size:12px; color:var(--muted); text-align:center;">No hay facturas.</p>'; document.getElementById('modal-client').classList.add('active');
}

function saveClient() { const n = document.getElementById('c-name').value, e = document.getElementById('c-email').value, a = document.getElementById('c-address').value, rnc = document.getElementById('c-rnc').value; if(!n) return; getRef('clients').add({name:n, email:e, address:a, rnc: rnc, timestamp: Date.now()}); document.getElementById('c-name').value=''; document.getElementById('c-email').value=''; document.getElementById('c-address').value=''; document.getElementById('c-rnc').value=''; showToast("Cliente Guardado"); }
function delClient(id) { getRef('clients').doc(id).delete(); }
function renderClients() { const el = document.getElementById('client-list'); if(el) el.innerHTML = clients.map(c => `<div class="item-row"><div><strong>${c.name}</strong><br><small>${c.rnc ? 'RNC: '+c.rnc+' | ' : ''}${c.email} | ${c.address}</small></div><div style="display:flex;gap:5px;"><button class="btn-small btn-outline" onclick="openClientProfile('${c.id}')">Ver Perfil</button><button class="btn-small" style="background:var(--danger); border:none; color:#fff;" onclick="delClient('${c.id}')">✖</button></div></div>`).join(''); }
function updateSelects() { 
  const dl = document.getElementById('dl-clients'), ps = document.getElementById('doc-product-select');
  if(dl) dl.innerHTML = clients.map(c => `<option value="${c.name}">`).join(''); 
  if(ps) ps.innerHTML = inventory.map(i => `<option value="${i.id}">${i.name} (${fMoney(i.price)})</option>`).join(''); 
}

function savePayable() { const c = document.getElementById('p-concept').value, a = parseFloat(document.getElementById('p-amount').value), d = document.getElementById('p-date').value; if(!c || isNaN(a) || a<=0) return; getRef('payables').add({concept: c, amount: a, date: d, status: 'Pendiente', timestamp: Date.now()}); document.getElementById('p-concept').value=''; document.getElementById('p-amount').value='0'; showToast("Registrado"); }
function togglePayableStatus(id, stat) { getRef('payables').doc(id).update({status: stat}); }
function delPayable(id) { getRef('payables').doc(id).delete(); }
function renderPayables() { const el = document.getElementById('payables-list'); if(el) el.innerHTML = payables.map(p => `<div class="item-row"><div><strong>${p.concept}</strong><br><small>${p.date ? 'Vence: '+p.date : 'Sin fecha'} | ${fMoney(p.amount)}</small></div><div style="display:flex;gap:5px;align-items:center;"><select style="font-size:11px;padding:2px;" onchange="togglePayableStatus('${p.id}', this.value)"><option value="Pendiente" ${p.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagado" ${p.status==='Pagado'?'selected':''}>Pagado</option></select><button class="btn-small" style="background:var(--danger);border:none;color:#fff;" onclick="delPayable('${p.id}')">✖</button></div></div>`).join('') || '<p style="color:var(--muted);font-size:13px;">No hay cuentas.</p>'; }

function saveReceivable() { const c = document.getElementById('r-concept').value, a = parseFloat(document.getElementById('r-amount').value), d = document.getElementById('r-date').value; if(!c || isNaN(a) || a<=0) return; getRef('receivables').add({concept: c, amount: a, date: d, status: 'Pendiente', timestamp: Date.now()}); document.getElementById('r-concept').value=''; document.getElementById('r-amount').value='0'; showToast("Guardado"); }
function toggleReceivableStatus(id, stat) { getRef('receivables').doc(id).update({status: stat}); }
function delReceivable(id) { getRef('receivables').doc(id).delete(); }
function renderReceivables() { const el = document.getElementById('receivables-list'); if(el) el.innerHTML = receivables.map(r => `<div class="item-row"><div><strong>${r.concept}</strong><br><small>${r.date ? 'Vence: '+r.date : 'Sin fecha'} | ${fMoney(r.amount)}</small></div><div style="display:flex;gap:5px;align-items:center;"><select style="font-size:11px;padding:2px;" onchange="toggleReceivableStatus('${r.id}', this.value)"><option value="Pendiente" ${r.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagado" ${r.status==='Pagado'?'selected':''}>Pagado</option></select><button class="btn-small" style="background:var(--danger);border:none;color:#fff;" onclick="delReceivable('${r.id}')">✖</button></div></div>`).join('') || '<p style="color:var(--muted);font-size:13px;">No hay cuentas.</p>'; }

function openDocBuilder(type) { clearDoc(); const dt = document.getElementById('doc-type'); if(dt) dt.value = type; toggleDocUI(); const lbl = document.getElementById('doc-title-label'); if(lbl) lbl.innerText = `Nueva ${type}`; navTo('sec-doc-builder'); }
function toggleDocUI() { const typeEl = document.getElementById('doc-type'); if(!typeEl) return; const type = typeEl.value; const dmo = document.getElementById('div-factura-options'), bfc = document.getElementById('btn-facturar-cot'), bsd = document.getElementById('btn-save-doc'); if(dmo) dmo.style.display = type === 'Factura' ? 'flex' : 'none'; if(bfc) bfc.style.display = type === 'Cotización' ? 'block' : 'none'; if(bsd) bsd.innerText = type === 'Cotización' ? 'Guardar Cotización' : 'Guardar Factura'; }
function startFromProd(type, prodId) { openDocBuilder(type); const p = inventory.find(x => x.id === prodId); if(p) { currentItems = [{id: p.id, name: p.name, cost: p.cost, price: p.price, qty: 1}]; renderDocItems(); calcDoc(); } }
function fillClientData() { const nameEl = document.getElementById('doc-client-name'); if(!nameEl) return; const name = nameEl.value; const c = clients.find(x => x.name === name); if(c) { const ce = document.getElementById('doc-client-email'), cp = document.getElementById('doc-client-phone'), cr = document.getElementById('doc-client-rnc'); if(ce) ce.value = c.email; if(cp) cp.value = c.address; if(cr) cr.value = c.rnc || ''; } }
function addDocItem() { const idEl = document.getElementById('doc-product-select'), qtyEl = document.getElementById('doc-qty'); if(!idEl || !qtyEl) return; const id = idEl.value, qty = parseFloat(qtyEl.value); if(!id||isNaN(qty) || qty<=0) return; const prod = inventory.find(i => i.id === id); if(prod) { currentItems.push({id: prod.id, name: prod.name, cost: prod.cost, price: prod.price, qty}); qtyEl.value='1'; renderDocItems(); calcDoc(); } }
function delDocItem(idx) { currentItems.splice(idx,1); renderDocItems(); calcDoc(); }
function renderDocItems() { const el = document.getElementById('doc-items-list'); if(el) el.innerHTML = currentItems.map((item, idx) => `<div class="item-row"><span style="font-size:13px;">${item.qty}x <strong>${item.name}</strong></span><div>${fMoney(item.price * item.qty)} <button style="background:none;border:none;color:var(--danger);margin-left:10px;" onclick="delDocItem(${idx})">✖</button></div></div>`).join(''); }

function calcDoc() {
  const subtotal = currentItems.reduce((s, i) => s + (i.price * i.qty), 0), totalCost = currentItems.reduce((s, i) => s + (i.cost * i.qty), 0);
  const taxEl = document.getElementById('doc-tax'), discEl = document.getElementById('doc-disc'), hoursEl = document.getElementById('doc-hours'), rateEl = document.getElementById('doc-rate');
  const taxPct = taxEl ? parseFloat(taxEl.value)||0 : 0, discPct = discEl ? parseFloat(discEl.value)||0 : 0;
  let total = subtotal, labor = 0; 
  if(hoursEl && rateEl) labor = (parseFloat(hoursEl.value)||0) * (parseFloat(rateEl.value)||0); 
  total += labor; const discAmt = total * (discPct/100); total -= discAmt; const taxAmt = total * (taxPct/100); total += taxAmt; const profit = total - taxAmt - totalCost; 
  const curEl = document.getElementById('currency'); const cur = curEl ? curEl.value : 'DOP';
  docTotals = { subtotal, discAmt, taxAmt, total, taxPct, discPct, labor, profit, totalCost, currency: cur, exchangeRate: exchangeRates[cur] || 1 }; 
  const sSub = document.getElementById('s-sub'), sTotLbl = document.getElementById('s-total-label'), sFin = document.getElementById('s-final'), docType = document.getElementById('doc-type');
  if(sSub) sSub.innerText = fMoney(subtotal); 
  if(sTotLbl) sTotLbl.innerText = docType && docType.value === 'Factura' ? 'Total:' : 'Sugerido:'; 
  if(sFin) sFin.innerText = fMoney(total);
}

async function convertAndSave() { const dt = document.getElementById('doc-type'); if(dt) dt.value = 'Factura'; toggleDocUI(); saveDoc(true); }

async function getSequentialNumber(type) {
  const counterRef = db.collection('businesses').doc(currentBusinessId).collection('config').doc('counters');
  return await db.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);
    const field = type === 'Factura' ? 'invoiceCount' : 'quoteCount'; const prefix = type === 'Factura' ? 'FAC-' : 'COT-'; let newCount = 1;
    if (!counterDoc.exists) { transaction.set(counterRef, { [field]: newCount }, { merge: true }); } else { newCount = (counterDoc.data()[field] || 0) + 1; transaction.update(counterRef, { [field]: newCount }); }
    return `${prefix}${newCount.toString().padStart(4, '0')}`;
  });
}

async function saveDoc(isConverting = false) {
  const nameEl = document.getElementById('doc-client-name'), typeEl = document.getElementById('doc-type');
  if(!nameEl || !typeEl) return;
  const name = nameEl.value, type = typeEl.value; 
  if(!name || currentItems.length === 0) { showToast("Faltan datos en el documento"); return; }
  const oldDoc = editDocId ? documents.find(d => d.id === editDocId) : null; let docNum = oldDoc ? oldDoc.num : '';
  
  let stockUpdates = [];
  if (type === 'Factura') {
    for (const item of currentItems) {
      const prod = inventory.find(x => x.id === item.id); if (!prod) continue;
      let oldQty = 0; if (oldDoc && oldDoc.type === 'Factura' && !isConverting) { const oldItem = oldDoc.items.find(x => x.id === item.id); if (oldItem) oldQty = oldItem.qty; }
      const qtyDifference = item.qty - oldQty; 
      if (qtyDifference > 0 && prod.stock < qtyDifference) { showToast(`Stock insuficiente para: ${item.name}. Disponibles: ${prod.stock}`); return; }
      if (qtyDifference !== 0) { stockUpdates.push({ id: prod.id, name: prod.name, change: -qtyDifference, newStock: prod.stock - qtyDifference, desc: oldDoc && !isConverting ? `Edición Fac. ${docNum || 'Pendiente'}` : `Venta Fac. ${docNum || 'Pendiente'}` }); }
    }
    if (oldDoc && oldDoc.type === 'Factura' && !isConverting) {
      for (const oldItem of oldDoc.items) {
        if (!currentItems.find(x => x.id === oldItem.id)) {
          const prod = inventory.find(x => x.id === oldItem.id);
          if (prod) { stockUpdates.push({ id: prod.id, name: prod.name, change: oldItem.qty, newStock: prod.stock + oldItem.qty, desc: `Restaurado de Fac. ${docNum}` }); }
        }
      }
    }
  }

  if (!oldDoc || (oldDoc.type === 'Cotización' && type === 'Factura')) {
    showToast("Generando correlativo seguro...");
    docNum = await getSequentialNumber(type); stockUpdates.forEach(update => { update.desc = update.desc.replace('Pendiente', docNum); });
  }

  for (const update of stockUpdates) { await getRef('inventory').doc(update.id).update({ stock: update.newStock }); await logMovement(update.id, update.name, update.change, update.newStock, update.desc); }
  
  const pmEl = document.getElementById('doc-payment'), dueDateEl = document.getElementById('doc-due-date'), rncEl = document.getElementById('doc-client-rnc'), emailEl = document.getElementById('doc-client-email'), phoneEl = document.getElementById('doc-client-phone');
  const pm = pmEl ? pmEl.value : 'Efectivo'; let finalStatus = 'Activa';
  if (type === 'Factura') { if (pm === 'Crédito') finalStatus = 'Crédito'; else if (pm === 'Efectivo' || pm === 'Transferencia') finalStatus = 'Pagada'; else finalStatus = 'Pendiente'; }
  if (oldDoc && oldDoc.type === 'Factura' && !isConverting) finalStatus = oldDoc.status;
  
  const doc = { 
    num: docNum, type, date: new Date().toLocaleDateString(), timestamp: Date.now(), dueDate: dueDateEl ? dueDateEl.value : '', paymentMethod: pm, 
    client: { name, rnc: rncEl ? rncEl.value : '', email: emailEl ? emailEl.value : '', phone: phoneEl ? phoneEl.value : '' }, 
    items: [...currentItems], totals: docTotals, status: finalStatus 
  };
  
  if(editDocId && !isConverting) { await getRef('documents').doc(editDocId).update(doc); } else { await getRef('documents').add(doc); }
  showToast("Guardado Exitosamente"); navTo(type === 'Factura' ? 'sec-invoices' : 'sec-quotes');
}

function editDoc(id) {
  const d = documents.find(x => x.id === id); if(!d) return; openDocBuilder(d.type); const titleLbl = document.getElementById('doc-title-label'); if(titleLbl) titleLbl.innerText = "Editando " + d.num; editDocId = d.id;
  const dueDateEl = document.getElementById('doc-due-date'), pmEl = document.getElementById('doc-payment'), nameEl = document.getElementById('doc-client-name'), rncEl = document.getElementById('doc-client-rnc'), emailEl = document.getElementById('doc-client-email'), phoneEl = document.getElementById('doc-client-phone');
  if(dueDateEl && d.dueDate) dueDateEl.value = d.dueDate; if(pmEl && d.paymentMethod) pmEl.value = d.paymentMethod;
  if(nameEl) nameEl.value = d.client.name; if(rncEl) rncEl.value = d.client.rnc || ''; if(emailEl) emailEl.value = d.client.email; if(phoneEl) phoneEl.value = d.client.phone;
  currentItems = [...d.items]; const taxEl = document.getElementById('doc-tax'), discEl = document.getElementById('doc-disc');
  if(taxEl) taxEl.value = d.totals.taxPct; if(discEl) discEl.value = d.totals.discPct; renderDocItems(); calcDoc();
}

function clearDoc() { 
  editDocId = null; 
  const nameEl = document.getElementById('doc-client-name'), rncEl = document.getElementById('doc-client-rnc'), emailEl = document.getElementById('doc-client-email'), phoneEl = document.getElementById('doc-client-phone');
  if(nameEl) nameEl.value=''; if(rncEl) rncEl.value=''; if(emailEl) emailEl.value=''; if(phoneEl) phoneEl.value=''; 
  currentItems=[]; renderDocItems(); calcDoc(); 
}

function changeStatus(id, newStatus) { getRef('documents').doc(id).update({status: newStatus}); }

async function delDoc(id) { 
  if(!confirm("¿Estás seguro de eliminar este documento?")) return;
  const docToDel = documents.find(x => x.id === id); if(!docToDel) return;
  if (docToDel.type === 'Factura') {
    showToast("Restaurando stock...");
    for (const item of docToDel.items) {
      const prod = inventory.find(x => x.id === item.id);
      if (prod) { const newStock = prod.stock + item.qty; await getRef('inventory').doc(prod.id).update({ stock: newStock }); await logMovement(prod.id, prod.name, item.qty, newStock, `Eliminación Fac. ${docToDel.num}`); }
    }
  }
  await getRef('documents').doc(id).delete(); showToast("Documento eliminado correctamente");
}

function renderDocList(type, containerId) {
  const container = document.getElementById(containerId);
  if(!container) return;
  container.innerHTML = documents.filter(d => d.type === type).map(d => `
    <div class="card" style="margin-bottom:10px;"><div style="display:flex; justify-content:space-between; margin-bottom:5px;"><div><span class="badge ${d.type.toLowerCase()}">${d.num}</span> 
    ${d.type==='Factura' ? `<select style="width:auto; padding:2px; font-size:11px; margin-left:5px;" onchange="changeStatus('${d.id}', this.value)"><option value="Sin Pagar" ${d.status==='Sin Pagar'?'selected':''}>Sin Pagar</option><option value="Crédito" ${d.status==='Crédito'?'selected':''}>Crédito</option><option value="Pendiente" ${d.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagada" ${d.status==='Pagada'?'selected':''}>Pagada</option></select>` : ''}</div>
    <strong style="color:var(--accent);">${fMoney(d.totals.total, d.totals.currency || 'USD')}</strong></div><strong>${d.client.name}</strong> <small style="color:var(--muted)">| ${d.date}</small>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;"><button class="btn btn-outline btn-small" onclick="genPDF('${d.id}')">📄 PDF</button><button class="btn btn-outline btn-small" onclick="editDoc('${d.id}')">✏️ Editar</button>${currentUserRole === 'Dueño' ? `<button class="btn btn-small" style="background:transparent;border:1px solid var(--danger);color:var(--danger);" onclick="delDoc('${d.id}')">Borrar</button>` : ''}</div></div>`).join('') || '<p style="color:var(--muted); text-align:center;">No hay documentos.</p>';
}
function renderQuotes() { renderDocList('Cotización', 'quote-list'); } 
function renderInvoices() { renderDocList('Factura', 'invoice-list'); }

function filterByDate(docsArray) {
  const filterEl = document.getElementById('dash-filter');
  const filter = filterEl ? filterEl.value : 'month';
  if (filter === 'all') return docsArray; const now = new Date();
  return docsArray.filter(d => {
    const dateObj = d.timestamp ? new Date(d.timestamp) : new Date(d.date); if (isNaN(dateObj)) return true; 
    if (filter === 'today') return dateObj.getDate() === now.getDate() && dateObj.getMonth() === now.getMonth() && dateObj.getFullYear() === now.getFullYear();
    if (filter === 'month') return dateObj.getMonth() === now.getMonth() && dateObj.getFullYear() === now.getFullYear();
    if (filter === 'year') return dateObj.getFullYear() === now.getFullYear(); return true;
  });
}

function renderDashboard() {
  const targetCurrency = document.getElementById('currency').value; const targetRate = exchangeRates[targetCurrency] || 1;
  let fTot = 0, arTot = 0; const filteredDocs = filterByDate(documents); const filteredReceivables = filterByDate(receivables);
  filteredDocs.forEach(d => { 
    const docRate = d.totals.exchangeRate || 1; const normalizedUSD = d.totals.total / docRate; const valueInCurrentSelected = normalizedUSD * targetRate; 
    if(d.type === 'Factura' && d.status === 'Pagada') fTot += valueInCurrentSelected; if(d.type === 'Factura' && ['Crédito', 'Sin Pagar', 'Pendiente'].includes(d.status)) arTot += valueInCurrentSelected;
  });
  filteredReceivables.filter(r => r.status === 'Pendiente').forEach(r => arTot += r.amount); 
  
  const invTotEl = document.getElementById('dash-inv-total'), quoTotEl = document.getElementById('dash-quo-total'), invCardsEl = document.getElementById('dash-inv-cards');
  if(invTotEl) invTotEl.innerText = fMoney(fTot); 
  if(quoTotEl) quoTotEl.innerText = fMoney(arTot);
  if(invCardsEl) invCardsEl.innerHTML = inventory.map(i => `<div class="prod-card">${i.img ? `<img src="${i.img}">` : `<div style="width:100%;height:80px;background:var(--bg);border-radius:8px;margin-bottom:8px;"></div>`}<h4>${i.name}</h4><p>${fMoney(i.price)}<br>Stock: ${i.stock}</p><div class="btn-group"><button class="btn btn-outline" onclick="startFromProd('Cotización', '${i.id}')">Cotizar</button><button class="btn btn-primary" onclick="startFromProd('Factura', '${i.id}')">Facturar</button></div></div>`).join('') || '<p style="font-size:12px; color:var(--muted);">Vacío.</p>';
}

function renderAccounting() {
  const targetCurrency = document.getElementById('currency').value; const targetRate = exchangeRates[targetCurrency] || 1;
  let prof = 0, taxes = 0, invNet = 0, ar = 0, ap = 0;
  const filteredDocs = filterByDate(documents); const filteredReceivables = filterByDate(receivables); const filteredPayables = filterByDate(payables);
  filteredDocs.forEach(d => {
    const docRate = d.totals.exchangeRate || 1; const localProfit = ((d.totals.profit || 0) / docRate) * targetRate; const localTax = (d.totals.taxAmt / docRate) * targetRate; const localTotal = (d.totals.total / docRate) * targetRate;
    if(d.type === 'Factura' && d.status === 'Pagada') { prof += localProfit; taxes += localTax; } if(d.type === 'Factura' && ['Crédito', 'Sin Pagar', 'Pendiente'].includes(d.status)) ar += localTotal;
  });
  filteredReceivables.filter(r => r.status === 'Pendiente').forEach(r => ar += r.amount); filteredPayables.filter(p => p.status === 'Pendiente').forEach(p => ap += p.amount); inventory.forEach(i => invNet += (i.cost * i.stock));
  
  const accProf = document.getElementById('acc-profit'), accTax = document.getElementById('acc-tax'), accInvVal = document.getElementById('acc-inv-value'), accAr = document.getElementById('acc-ar'), accAp = document.getElementById('acc-ap');
  if(accProf) accProf.innerText = fMoney(prof); if(accTax) accTax.innerText = fMoney(taxes); if(accInvVal) accInvVal.innerText = fMoney(invNet); if(accAr) accAr.innerText = fMoney(ar); if(accAp) accAp.innerText = fMoney(ap);
}

function handleLogoUpload(e) { const r = new FileReader(); r.onload = evt => { settings.logo = evt.target.result; saveSettings(true); }; r.readAsDataURL(e.target.files[0]); }
async function saveSettings(silent=false) { 
  const setColor = document.getElementById('set-color'), setFont = document.getElementById('set-font'), setTpl = document.getElementById('set-inv-tpl'), setBizName = document.getElementById('set-biz-name'), setBizId = document.getElementById('set-biz-id'), setBizAddr = document.getElementById('set-biz-address');
  settings.color = setColor ? setColor.value : '#111827'; 
  settings.font = setFont ? setFont.value : 'Helvetica'; 
  settings.tplInv = setTpl ? setTpl.value : 'modern'; 
  settings.name = setBizName ? setBizName.value : ''; 
  settings.id = setBizId ? setBizId.value : ''; 
  settings.address = setBizAddr ? setBizAddr.value : ''; 
  await db.collection('businesses').doc(currentBusinessId).collection('config').doc('settings').set(settings); 
  if(!silent) showToast("Configuración Nube Guardada"); 
}

function genPDF(id) {
  const d = documents.find(x => x.id === id); if(!d) return; showToast("Generando..."); const cur = d.totals.currency || 'USD'; 
  const w = document.getElementById('pdf-wrapper'), c = document.getElementById('pdf-container'), h = document.getElementById('pdf-header'); if(!w || !c || !h) return;
  c.style.fontFamily = settings.font;
  const pdfType = document.getElementById('pdf-type'), pdfTotalRow = document.getElementById('pdf-total-row'), pdfLogoImg = document.getElementById('pdf-logo-img'), pdfBizName = document.getElementById('pdf-biz-name'), pdfBizMeta = document.getElementById('pdf-biz-meta'), pdfMeta = document.getElementById('pdf-meta'), pdfCliName = document.getElementById('pdf-cli-name'), pdfCliMeta = document.getElementById('pdf-cli-meta'), pdfStatusStamp = document.getElementById('pdf-status-stamp'), pdfTableBody = document.getElementById('pdf-table-body'), pdfSub = document.getElementById('pdf-sub'), pdfDisc = document.getElementById('pdf-disc'), pdfRowDisc = document.getElementById('pdf-row-disc'), pdfTax = document.getElementById('pdf-tax'), pdfRowTax = document.getElementById('pdf-row-tax'), pdfTotal = document.getElementById('pdf-total'), pdfTotalLabel = document.getElementById('pdf-total-label');

  if(settings.tplInv === 'modern') { 
    h.style.background = settings.color; h.style.color = '#fff'; h.style.borderBottom = 'none'; if(pdfType) pdfType.style.color = '#fff'; if(pdfTotalRow) pdfTotalRow.style.color = settings.color; 
  } else { 
    h.style.background = 'transparent'; h.style.color = '#000'; h.style.borderBottom = `4px solid ${settings.color}`; if(pdfType) pdfType.style.color = settings.color; if(pdfTotalRow) pdfTotalRow.style.color = settings.color; 
  }
  if(pdfLogoImg) { pdfLogoImg.src = settings.logo || ''; pdfLogoImg.style.display = settings.logo ? 'block' : 'none'; }
  if(pdfBizName) pdfBizName.innerText = settings.name; if(pdfBizMeta) pdfBizMeta.innerHTML = `${settings.id?'RNC: '+settings.id+'<br>':''}${settings.address}`;
  if(pdfType) pdfType.innerText = d.type; if(pdfMeta) pdfMeta.innerHTML = `<strong>Nº:</strong> ${d.num}<br><strong>Fecha:</strong> ${d.date}${d.dueDate?'<br><strong>Vence:</strong> '+d.dueDate:''}${d.paymentMethod ? '<br><strong>Pago:</strong> '+d.paymentMethod : ''}`;
  if(pdfCliName) pdfCliName.innerText = d.client.name; if(pdfCliMeta) pdfCliMeta.innerHTML = `${d.client.rnc?'RNC/Cédula: '+d.client.rnc+'<br>':''}${d.client.email}<br>${d.client.phone}`;
  if(pdfStatusStamp) { if(d.type==='Factura' && d.status==='Pagada') pdfStatusStamp.innerHTML = '<h2 style="color:#22c55e;border:4px solid #22c55e;padding:10px;transform:rotate(-15deg);display:inline-block;">PAGADA</h2>'; else pdfStatusStamp.innerHTML = ''; }
  
  let table = d.items.map(i => `<tr><td>${i.name}</td><td style="text-align:center;">${i.qty}</td><td style="text-align:right;">${fMoney(i.price, cur)}</td><td style="text-align:right;">${fMoney(i.price * i.qty, cur)}</td></tr>`).join('');
  if(d.totals.labor > 0) table += `<tr><td>Servicios / Mano de Obra</td><td style="text-align:center;">-</td><td style="text-align:right;">-</td><td style="text-align:right;">${fMoney(d.totals.labor, cur)}</td></tr>`;
  if(pdfTableBody) pdfTableBody.innerHTML = table;
  
  if(pdfSub) pdfSub.innerText = fMoney(d.totals.subtotal, cur); 
  if(pdfDisc) pdfDisc.innerText = `-${fMoney(d.totals.discAmt, cur)}`; 
  if(pdfRowDisc) pdfRowDisc.style.display = d.totals.discAmt>0?'flex':'none'; 
  if(pdfTax) pdfTax.innerText = `+${fMoney(d.totals.taxAmt, cur)}`; 
  if(pdfRowTax) pdfRowTax.style.display = d.totals.taxAmt>0?'flex':'none'; 
  if(pdfTotal) pdfTotal.innerText = fMoney(d.totals.total, cur); 
  if(pdfTotalLabel) pdfTotalLabel.innerText = d.type==='Factura'?'Total:':'Sugerido:';
  
  w.style.display = 'block'; 
  html2pdf().set({ margin:0, filename:`${d.num}.pdf`, image:{type:'jpeg',quality:1}, html2canvas:{scale:2}, jsPDF:{unit:'in',format:'letter',orientation:'portrait'} }).from(c).save().then(() => { w.style.display = 'none'; showToast("¡Descargado!"); });
}
