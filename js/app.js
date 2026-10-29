if ('serviceWorker' in navigator) { 
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration failed:', err));
  }); 
}

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

let inventory = [], clients = [], documents = [], payables = [], receivables = [], movements = [], settings = {};
let currentItems = [], docTotals = {}, editDocId = null, editInvId = null, currentUser = null, currentBusinessId = null, currentUserRole = 'Cajero';
let currentAbonoDocId = null, lastCuadreData = { cash: 0, transfer: 0, card: 0, total: 0, txs: [] };
let exchangeRates = { USD: 1, DOP: 58.5, EUR: 0.92 };
let isRegistering = false;
let html5QrScanner = null, scanTargetMode = 'doc';

const NCF_LABELS = {
  'B01': 'Factura de Crédito Fiscal',
  'B02': 'Factura de Consumo',
  'B14': 'Comprobante Régimen Especial',
  'B15': 'Comprobante Gubernamental',
  'Interna': 'Factura Comercial'
};

// GENERADOR DE SERIE ÚNICA PARA PRODUCTOS (SN-XXXXXX)
function generateUniqueSerial() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SN-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function fetchRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    exchangeRates.USD = 1; 
    exchangeRates.DOP = data.rates.DOP; 
    exchangeRates.EUR = data.rates.EUR;
    const rateInfo = document.getElementById('rate-info');
    if(rateInfo) rateInfo.innerText = `Tasa del día: 1 USD = ${exchangeRates.DOP.toFixed(2)} DOP`;
    updateAllViews();
  } catch(e) { 
    const rateInfo = document.getElementById('rate-info');
    if(rateInfo) rateInfo.innerText = `Tasa offline (${exchangeRates.DOP} DOP).`; 
  }
}

function fMoney(val, specificCurrency = null) { 
  const curEl = document.getElementById('currency');
  const cur = specificCurrency || (curEl ? curEl.value : 'DOP');
  let symbol = '$'; 
  if(cur === 'DOP') symbol = 'RD$'; 
  else if(cur === 'EUR') symbol = '€';
  return symbol + (Number(val) || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); 
}

function getDocPaid(d) {
  if (d.type !== 'Factura') return 0;
  if (Array.isArray(d.payments) && d.payments.length > 0) {
    return d.payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  }
  if (typeof d.paidAmount === 'number') return d.paidAmount;
  return d.status === 'Pagada' ? (d.totals?.total || 0) : 0;
}

function getDocBalance(d) {
  if (d.type !== 'Factura') return 0;
  const total = d.totals?.total || 0;
  return Math.max(0, total - getDocPaid(d));
}

// CÁLCULO DE MARGEN Y PRECIO
function calcPriceFromMargin() {
  const cost = parseFloat(document.getElementById('i-cost')?.value) || 0;
  const marginPct = parseFloat(document.getElementById('i-margin')?.value) || 0;
  const price = cost * (1 + (marginPct / 100));
  const priceEl = document.getElementById('i-price');
  if (priceEl) priceEl.value = price > 0 ? price.toFixed(2) : '0';
}

function calcMarginFromPrice() {
  const cost = parseFloat(document.getElementById('i-cost')?.value) || 0;
  const price = parseFloat(document.getElementById('i-price')?.value) || 0;
  const marginEl = document.getElementById('i-margin');
  if (!marginEl) return;
  if (cost > 0) {
    const margin = ((price - cost) / cost) * 100;
    marginEl.value = Math.round(margin);
  } else {
    marginEl.value = '0';
  }
}

// =========================================================
// ESCÁNER DE CÓDIGO DE BARRAS / IMEI POR CÁMARA
// =========================================================
function startBarcodeScan(mode = 'doc') {
  scanTargetMode = mode;
  const modal = document.getElementById('modal-scanner');
  if (modal) modal.classList.add('active');
  const statusEl = document.getElementById('scanner-status');
  if (statusEl) {
    if (mode === 'inv-imei') statusEl.innerText = "Apunta la cámara al IMEI del equipo...";
    else if (mode === 'inv-barcode') statusEl.innerText = "Apunta la cámara al código de barras/SKU...";
    else statusEl.innerText = "Escanea IMEI, Código de barras o Serie para añadir...";
  }

  if (html5QrScanner) {
    html5QrScanner.clear().catch(() => {});
  }

  html5QrScanner = new Html5Qrcode("reader");
  const config = { fps: 10, qrbox: { width: 260, height: 160 } };

  html5QrScanner.start(
    { facingMode: "environment" },
    config,
    (decodedText) => {
      onBarcodeScanned(decodedText.trim());
      stopBarcodeScan();
    },
    () => {}
  ).catch(err => {
    showToast("No se pudo iniciar la cámara: " + err);
    stopBarcodeScan();
  });
}

function stopBarcodeScan() {
  if (html5QrScanner) {
    html5QrScanner.stop().then(() => {
      html5QrScanner.clear();
      html5QrScanner = null;
    }).catch(() => { html5QrScanner = null; });
  }
  const modal = document.getElementById('modal-scanner');
  if (modal) modal.classList.remove('active');
}

function onBarcodeScanned(code) {
  if (!code) return;

  if (scanTargetMode === 'inv-imei') {
    const imeiEl = document.getElementById('i-imei');
    if (imeiEl) imeiEl.value = code;
    showToast(`IMEI asignado: ${code}`);
    return;
  }

  if (scanTargetMode === 'inv-barcode') {
    const barEl = document.getElementById('i-barcode');
    if (barEl) barEl.value = code;
    showToast(`Código asignado: ${code}`);
    return;
  }

  // Modo Documento: Busca en el inventario por IMEI, Serie Única (SN) o Código de Barras
  const prod = inventory.find(i => 
    (i.imei && i.imei.trim().toLowerCase() === code.toLowerCase()) ||
    (i.serial && i.serial.trim().toLowerCase() === code.toLowerCase()) ||
    (i.barcode && i.barcode.trim().toLowerCase() === code.toLowerCase()) ||
    i.id === code
  );

  if (prod) {
    const existing = currentItems.find(x => x.id === prod.id);
    if (existing) {
      existing.qty += 1;
    } else {
      currentItems.push({ 
        id: prod.id, 
        name: prod.name, 
        serial: prod.serial || '',
        imei: prod.imei || '',
        warranty: prod.warranty || 'Sin garantía',
        cost: prod.cost, 
        price: prod.price, 
        qty: 1 
      });
    }
    renderDocItems();
    calcDoc();
    showToast(`+1 ${prod.name} (IMEI: ${prod.imei || prod.serial})`);
  } else {
    showToast(`Equipo o código no encontrado: ${code}`);
  }
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
  const l = document.getElementById('form-login'), r = document.getElementById('form-register');
  if(!l || !r) return;
  if(l.style.display === 'none') { l.style.display = 'block'; r.style.display = 'none'; } 
  else { l.style.display = 'none'; r.style.display = 'block'; }
}

async function register() {
  const eEl = document.getElementById('reg-email'), pEl = document.getElementById('reg-pass'), nEl = document.getElementById('reg-name');
  const phEl = document.getElementById('reg-phone'), idEl = document.getElementById('reg-id'), dobEl = document.getElementById('reg-dob'), locEl = document.getElementById('reg-loc');
  if(!eEl || !pEl || !nEl || !locEl) return;
  const e = eEl.value.trim(), p = pEl.value, n = nEl.value.trim(), ph = phEl ? phEl.value.trim() : '', id = idEl ? idEl.value.trim() : '', dob = dobEl ? dobEl.value : '', loc = locEl.value.trim();

  if(!e || !p || !n || !loc) return showToast("Faltan datos (Incluye Nombre del Negocio)");
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
  const e = eEl.value.trim(), p = pEl.value;
  if(!e || !p) return showToast("Ingresa tus credenciales");
  try { 
    showView('view-loading'); 
    await auth.signInWithEmailAndPassword(e, p); 
  } catch(err) { 
    showView('view-auth'); 
    showToast("Credenciales incorrectas"); 
  }
}

function logout() { auth.signOut().then(() => { location.reload(); }); }

async function loadCloudData() {
  try {
    showView('view-loading');
    const profile = await db.collection('users').doc(currentUser.uid).get();
    
    if(!profile.exists) { 
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

    const h = new Date().getHours(); 
    const saludo = h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches';
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
              ${member.id !== currentUser.uid && currentUserRole === 'Dueño' ? `<select style="width:auto; margin:0; font-size:12px; padding:4px 8px;" onchange="changeRole('${member.id}', this.value)"><option value="Cajero" ${member.role==='Cajero'?'selected':''}>Cajero</option><option value="Administrador" ${member.role==='Administrador'?'selected':''}>Admin</option></select>` : ''}
            </div>
          `).join('');
        }
      });
    }

    getRef('inventory').onSnapshot(snap => { 
      inventory = snap.docs.map(d => ({id: d.id, ...d.data()})); 
      updateAllViews(); 
      updateSelects(); 
    });
    getRef('clients').onSnapshot(snap => { clients = snap.docs.map(d => ({id: d.id, ...d.data()})); renderClients(); updateSelects(); });
    getRef('documents').onSnapshot(snap => { 
      documents = snap.docs.map(d => ({id: d.id, ...d.data()})).sort((a,b) => (b.timestamp||0) - (a.timestamp||0)); 
      updateAllViews(); 
      if(currentAbonoDocId && document.getElementById('modal-abono')?.classList.contains('active')) renderAbonoModalData();
    });
    getRef('payables').onSnapshot(snap => { payables = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); });
    getRef('receivables').onSnapshot(snap => { receivables = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); });
    getRef('inventory_movements').onSnapshot(snap => { movements = snap.docs.map(d => ({id: d.id, ...d.data()})).sort((a,b) => new Date(b.date) - new Date(a.date)); });
    
    const setSnap = await getRef('config').doc('settings').get();
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

    if (!editInvId) clearInvForm();
    showView('view-app');
  } catch (err) {
    console.error("Error al cargar datos en la nube:", err);
    showToast("Error al sincronizar datos");
    showView('view-auth');
  }
}

function updateAllViews() { 
  renderDashboard(); 
  renderAccounting(); 
  renderQuotes(); 
  renderInvoices(); 
  renderInv(); 
  renderPayables(); 
  renderReceivables(); 
}

function showView(id) { 
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); 
  const target = document.getElementById(id);
  if(target) target.classList.add('active'); 
}

function toggleSidebar() { 
  if (window.innerWidth >= 900) return; 
  const s = document.getElementById('sidebar'), o = document.getElementById('sidebar-overlay'); 
  if(!s || !o) return; 
  const open = s.classList.contains('open'); 
  s.classList.toggle('open', !open); 
  o.style.display = open ? 'none' : 'block'; 
}

function navTo(id, btn) { 
  document.querySelectorAll('.app-section').forEach(s => s.classList.remove('active')); 
  if(btn) {
    document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('active')); 
    btn.classList.add('active'); 
  }
  const target = document.getElementById(id); 
  if(target) target.classList.add('active'); 
  if(window.innerWidth < 900) {
    const s = document.getElementById('sidebar'), o = document.getElementById('sidebar-overlay');
    if(s && s.classList.contains('open')) { s.classList.remove('open'); if(o) o.style.display = 'none'; }
  }
  window.scrollTo(0,0); 
}

function toggleTheme() { 
  const isLight = document.body.classList.toggle('light-mode'); 
  localStorage.setItem('marg_theme', isLight ? 'light' : 'dark'); 
}

function showToast(msg) { 
  const t = document.getElementById("toast"); 
  if(!t) return; 
  t.innerText = msg; 
  t.classList.add("show"); 
  setTimeout(() => t.classList.remove("show"), 3000); 
}

function compressImage(file, callback) { 
  const r = new FileReader(); 
  r.onload = e => { 
    const img = new Image(); 
    img.onload = () => { 
      const canvas = document.createElement('canvas'); 
      const ctx = canvas.getContext('2d'); 
      let w = img.width, h = img.height; 
      const max = 250; 
      if(w > h) { if(w > max) { h *= max/w; w = max; } } 
      else { if(h > max) { w *= max/h; h = max; } } 
      canvas.width = w; 
      canvas.height = h; 
      ctx.drawImage(img, 0, 0, w, h); 
      callback(canvas.toDataURL('image/jpeg', 0.7)); 
    }; 
    img.src = e.target.result; 
  }; 
  r.readAsDataURL(file); 
}

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

function openKardexModal() {
  const list = document.getElementById('kardex-list');
  if(list) {
    list.innerHTML = movements.slice(0, 50).map(m => {
      const isPos = m.change > 0;
      const dateStr = new Date(m.date).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' });
      return `<div class="item-row" style="padding:8px 10px;">
        <div><strong>${m.productName}</strong><br><small style="color:var(--muted);">${m.description} • ${dateStr}</small></div>
        <div style="text-align:right;">
          <strong style="color:${isPos ? 'var(--accent)' : 'var(--danger)'};">${isPos ? '+' + m.change : m.change}</strong><br>
          <small style="color:var(--muted);">Stock: ${m.stockAfter}</small>
        </div>
      </div>`;
    }).join('') || '<p style="font-size:13px; color:var(--muted); text-align:center;">Aún no hay movimientos registrados.</p>';
  }
  document.getElementById('modal-kardex').classList.add('active');
}

// INVENTARIO CON IMEI, SERIE ÚNICA Y GARANTÍA
function saveInv() { 
  const n = document.getElementById('i-name').value.trim();
  const serial = document.getElementById('i-serial')?.value.trim() || generateUniqueSerial();
  const imei = document.getElementById('i-imei')?.value.trim() || '';
  const barcode = document.getElementById('i-barcode')?.value.trim() || '';
  const warranty = document.getElementById('i-warranty')?.value || 'Sin garantía';
  const c = parseFloat(document.getElementById('i-cost').value) || 0;
  const p = parseFloat(document.getElementById('i-price').value) || 0;
  const s = parseInt(document.getElementById('i-stock').value) || 0;
  const margin = parseFloat(document.getElementById('i-margin').value) || 0;
  const f = document.getElementById('i-img').files[0]; 
  
  if(!n) return showToast("Escribe el nombre o modelo del equipo"); 
  
  const cb = async (imgData) => { 
    const data = { 
      name: n, 
      serial: serial,
      imei: imei,
      barcode: barcode, 
      warranty: warranty,
      cost: c, 
      price: p, 
      margin: margin, 
      stock: s, 
      img: imgData 
    };

    let change = s, desc = `Inventario inicial (${serial})`;
    if(editInvId) { 
      const oldProd = inventory.find(i => i.id === editInvId);
      change = s - (oldProd ? oldProd.stock : 0); 
      desc = `Ajuste manual (${serial})`;
      await getRef('inventory').doc(editInvId).update(data); 
      logMovement(editInvId, n, change, s, desc);
    } else { 
      const newDoc = await getRef('inventory').add(data); 
      logMovement(newDoc.id, n, change, s, desc); 
    } 
    clearInvForm(); 
    showToast("Equipo / Producto Guardado"); 
  }; 
  if(f) compressImage(f, cb); else cb(editInvId ? inventory.find(i=>i.id===editInvId).img : null); 
}

function delInv(id) { if(confirm("¿Eliminar este producto/equipo del almacén?")) getRef('inventory').doc(id).delete(); }

function editInv(id) { 
  const i = inventory.find(x => x.id === id); 
  if(!i) return; 
  document.getElementById('i-name').value = i.name; 
  document.getElementById('i-serial').value = i.serial || generateUniqueSerial();
  document.getElementById('i-imei').value = i.imei || '';
  document.getElementById('i-barcode').value = i.barcode || '';
  document.getElementById('i-warranty').value = i.warranty || '30 días';
  document.getElementById('i-cost').value = i.cost; 
  document.getElementById('i-price').value = i.price; 
  document.getElementById('i-stock').value = i.stock; 
  
  const marginEl = document.getElementById('i-margin');
  if (marginEl) {
    if (typeof i.margin === 'number') {
      marginEl.value = i.margin;
    } else if (i.cost > 0) {
      marginEl.value = Math.round(((i.price - i.cost) / i.cost) * 100);
    } else {
      marginEl.value = '30';
    }
  }

  editInvId = id; 
  document.getElementById('inv-form-title').innerText = "Editar Equipo / Producto"; 
  document.getElementById('btn-save-inv').innerText = "Actualizar"; 
  window.scrollTo(0,0); 
}

function clearInvForm() { 
  document.getElementById('i-name').value = ''; 
  document.getElementById('i-serial').value = generateUniqueSerial();
  document.getElementById('i-imei').value = '';
  document.getElementById('i-barcode').value = '';
  document.getElementById('i-warranty').value = '30 días';
  document.getElementById('i-cost').value = '0'; 
  document.getElementById('i-price').value = '0'; 
  document.getElementById('i-margin').value = '30';
  document.getElementById('i-stock').value = '1'; 
  document.getElementById('i-img').value = ''; 
  editInvId = null; 
  document.getElementById('inv-form-title').innerText = "Añadir Producto o Equipo"; 
  document.getElementById('btn-save-inv').innerText = "Guardar Nube"; 
}

function renderInv() { 
  const el = document.getElementById('inventory-list'); 
  if(!el) return;
  const q = (document.getElementById('search-inv')?.value || '').toLowerCase();
  const filtered = inventory.filter(i => 
    i.name.toLowerCase().includes(q) || 
    (i.imei && i.imei.toLowerCase().includes(q)) ||
    (i.serial && i.serial.toLowerCase().includes(q)) ||
    (i.barcode && i.barcode.toLowerCase().includes(q))
  );
  el.innerHTML = filtered.map(i => {
    const profitMargin = i.cost > 0 ? Math.round(((i.price - i.cost) / i.cost) * 100) : 0;
    return `
    <div class="item-row">
      <div style="display:flex; gap:10px; align-items:center;">
        ${i.img ? `<img src="${i.img}" class="prod-img">` : '<div class="prod-img"></div>'}
        <div>
          <strong>${i.name}</strong> 
          <span class="badge ncf">${i.serial || 'S/N'}</span>
          ${i.imei ? `<span class="badge ncf" style="color:var(--accent);">IMEI: ${i.imei}</span>` : ''}
          ${i.stock <= 3 ? `<span class="badge low-stock">¡Bajo Stock: ${i.stock}!</span>` : ''}<br>
          <small style="color:var(--muted);">
            Costo: ${fMoney(i.cost)} | Venta: <strong style="color:var(--text);">${fMoney(i.price)}</strong> (+${profitMargin}%) | Garantía: <strong>${i.warranty || '30 días'}</strong> | Stock: ${i.stock}
          </small>
        </div>
      </div>
      <div style="display:flex; gap:5px;">
        <button class="btn-small btn-outline" onclick="editInv('${i.id}')">✏️</button>
        <button class="btn-small" style="background:var(--danger); border:none; color:#fff;" onclick="delInv('${i.id}')">✖</button>
      </div>
    </div>`;
  }).join('') || '<p style="color:var(--muted); font-size:13px; text-align:center;">No se encontraron equipos o productos.</p>'; 
}

function closeModal(id) { 
  const modal = document.getElementById(id); 
  if(modal) modal.classList.remove('active'); 
}

function openClientProfile(id) {
  const c = clients.find(x => x.id === id); 
  if(!c) return;
  document.getElementById('mc-name').innerText = c.name; 
  document.getElementById('mc-contact').innerText = `${c.rnc ? 'RNC/Cédula: '+c.rnc+' | ' : ''}${c.address||''} ${c.email ? '| '+c.email : ''}`;
  let bought = 0, owed = 0; 
  const cDocs = documents.filter(d => d.client.name === c.name && d.type === 'Factura'); 
  let htmlDocs = '';
  const targetCurrency = document.getElementById('currency').value; 
  const targetRate = exchangeRates[targetCurrency] || 1;
  cDocs.forEach(d => {
    const dRate = d.totals.exchangeRate || 1; 
    const paidLocal = (getDocPaid(d) / dRate) * targetRate;
    const balLocal = (getDocBalance(d) / dRate) * targetRate;
    bought += paidLocal;
    owed += balLocal;
    htmlDocs += `<div class="item-row" style="padding:8px;">
      <span style="font-size:12px;"><strong>${d.num}</strong> ${d.ncf ? `<small>(${d.ncf})</small>` : ''}<br>${d.date}</span>
      <div style="text-align:right;">
        <span class="badge ${d.status==='Pagada'?'factura':'pending-bal'}">${d.status}</span><br>
        <strong style="font-size:12px; color:var(--accent);">Pagado: ${fMoney(paidLocal)}</strong>
        ${balLocal > 0.01 ? `<br><small style="color:var(--warn);">Resta: ${fMoney(balLocal)}</small>` : ''}
      </div>
    </div>`;
  });
  document.getElementById('mc-bought').innerText = fMoney(bought); 
  document.getElementById('mc-owed').innerText = fMoney(owed); 
  document.getElementById('mc-docs').innerHTML = htmlDocs || '<p style="font-size:12px; color:var(--muted); text-align:center;">No hay facturas registradas.</p>'; 
  document.getElementById('modal-client').classList.add('active');
}

function saveClient() { 
  const n = document.getElementById('c-name').value.trim(), e = document.getElementById('c-email').value.trim(), a = document.getElementById('c-address').value.trim(), rnc = document.getElementById('c-rnc').value.trim(); 
  if(!n) return showToast("Ingresa el nombre del cliente"); 
  getRef('clients').add({name:n, email:e, address:a, rnc: rnc, timestamp: Date.now()}); 
  document.getElementById('c-name').value=''; document.getElementById('c-email').value=''; document.getElementById('c-address').value=''; document.getElementById('c-rnc').value=''; 
  showToast("Cliente Guardado"); 
}

function delClient(id) { if(confirm("¿Eliminar este cliente?")) getRef('clients').doc(id).delete(); }

function renderClients() { 
  const el = document.getElementById('client-list'); 
  if(!el) return;
  const q = (document.getElementById('search-clients')?.value || '').toLowerCase();
  const filtered = clients.filter(c => c.name.toLowerCase().includes(q) || (c.rnc && c.rnc.toLowerCase().includes(q)));
  el.innerHTML = filtered.map(c => `
    <div class="item-row">
      <div><strong>${c.name}</strong><br><small style="color:var(--muted);">${c.rnc ? 'RNC: '+c.rnc+' | ' : ''}${c.address || 'Sin tel.'}</small></div>
      <div style="display:flex;gap:5px;">
        <button class="btn-small btn-outline" onclick="openClientProfile('${c.id}')">📊 Estado Cuenta</button>
        <button class="btn-small" style="background:var(--danger); border:none; color:#fff;" onclick="delClient('${c.id}')">✖</button>
      </div>
    </div>`).join('') || '<p style="color:var(--muted); font-size:13px; text-align:center;">No hay clientes registrados.</p>'; 
}

function updateSelects() { 
  const clientSelect = document.getElementById('doc-client-select');
  if (clientSelect) {
    clientSelect.innerHTML = '<option value="">-- Selecciona de la lista o escribe abajo --</option>' +
      clients.map(c => `<option value="${c.id}">${c.name} ${c.rnc ? `(${c.rnc})` : ''}</option>`).join('');
  }

  const ps = document.getElementById('doc-product-select');
  if (ps) {
    ps.innerHTML = '<option value="">-- Elige un producto / equipo --</option>' +
      inventory.map(i => {
        const extraId = i.imei ? `[IMEI: ${i.imei}]` : `[${i.serial || 'S/N'}]`;
        return `<option value="${i.id}">${i.name} ${extraId} — ${fMoney(i.price)} (Stock: ${i.stock})</option>`;
      }).join('');
  }
}

function onSelectClientChange() {
  const select = document.getElementById('doc-client-select');
  if (!select) return;
  const clientId = select.value;
  if (!clientId) return;
  const c = clients.find(x => x.id === clientId);
  if (c) {
    const nameEl = document.getElementById('doc-client-name');
    const ce = document.getElementById('doc-client-email');
    const cp = document.getElementById('doc-client-phone');
    const cr = document.getElementById('doc-client-rnc');
    if (nameEl) nameEl.value = c.name;
    if (ce) ce.value = c.email || '';
    if (cp) cp.value = c.address || '';
    if (cr) cr.value = c.rnc || '';
  }
}

function savePayable() { 
  const c = document.getElementById('p-concept').value.trim(), a = parseFloat(document.getElementById('p-amount').value), d = document.getElementById('p-date').value; 
  if(!c || isNaN(a) || a<=0) return; 
  getRef('payables').add({concept: c, amount: a, date: d, status: 'Pendiente', timestamp: Date.now()}); 
  document.getElementById('p-concept').value=''; document.getElementById('p-amount').value='0'; 
  showToast("Registrado"); 
}
function togglePayableStatus(id, stat) { getRef('payables').doc(id).update({status: stat}); }
function delPayable(id) { getRef('payables').doc(id).delete(); }
function renderPayables() { 
  const el = document.getElementById('payables-list'); 
  if(el) el.innerHTML = payables.map(p => `<div class="item-row"><div><strong>${p.concept}</strong><br><small style="color:var(--muted);">${p.date ? 'Vence: '+p.date : 'Sin fecha'} | ${fMoney(p.amount)}</small></div><div style="display:flex;gap:5px;align-items:center;"><select style="width:auto; margin:0; font-size:11px; padding:4px;" onchange="togglePayableStatus('${p.id}', this.value)"><option value="Pendiente" ${p.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagado" ${p.status==='Pagado'?'selected':''}>Pagado</option></select><button class="btn-small" style="background:var(--danger);border:none;color:#fff;" onclick="delPayable('${p.id}')">✖</button></div></div>`).join('') || '<p style="color:var(--muted);font-size:13px;">No hay cuentas pendientes.</p>'; 
}

function saveReceivable() { 
  const c = document.getElementById('r-concept').value.trim(), a = parseFloat(document.getElementById('r-amount').value), d = document.getElementById('r-date').value; 
  if(!c || isNaN(a) || a<=0) return; 
  getRef('receivables').add({concept: c, amount: a, date: d, status: 'Pendiente', timestamp: Date.now()}); 
  document.getElementById('r-concept').value=''; document.getElementById('r-amount').value='0'; 
  showToast("Guardado"); 
}
function toggleReceivableStatus(id, stat) { getRef('receivables').doc(id).update({status: stat}); }
function delReceivable(id) { getRef('receivables').doc(id).delete(); }
function renderReceivables() { 
  const el = document.getElementById('receivables-list'); 
  if(el) el.innerHTML = receivables.map(r => `<div class="item-row"><div><strong>${r.concept}</strong><br><small style="color:var(--muted);">${r.date ? 'Vence: '+r.date : 'Sin fecha'} | ${fMoney(r.amount)}</small></div><div style="display:flex;gap:5px;align-items:center;"><select style="width:auto; margin:0; font-size:11px; padding:4px;" onchange="toggleReceivableStatus('${r.id}', this.value)"><option value="Pendiente" ${p.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagado" ${p.status==='Pagado'?'selected':''}>Pagado</option></select><button class="btn-small" style="background:var(--danger);border:none;color:#fff;" onclick="delReceivable('${r.id}')">✖</button></div></div>`).join('') || '<p style="color:var(--muted);font-size:13px;">No hay cobros manuales.</p>'; 
}

function handleNcfChange() {
  const ncfType = document.getElementById('doc-ncf-type')?.value;
  const taxEl = document.getElementById('doc-tax');
  if (ncfType === 'B14' && taxEl) {
    taxEl.value = 0; 
    showToast("B14 seleccionado: ITBIS ajustado a 0%");
    calcDoc();
  } else if (taxEl && parseFloat(taxEl.value) === 0) {
    taxEl.value = 18;
    calcDoc();
  }
}

function openDocBuilder(type) { 
  clearDoc(); 
  const dt = document.getElementById('doc-type'); 
  if(dt) dt.value = type; 
  toggleDocUI(); 
  const lbl = document.getElementById('doc-title-label'); 
  if(lbl) lbl.innerText = `Nueva ${type}`; 
  navTo('sec-doc-builder'); 
}

function toggleDocUI() { 
  const typeEl = document.getElementById('doc-type'); 
  if(!typeEl) return; 
  const type = typeEl.value; 
  const dmo = document.getElementById('div-factura-options'), bfc = document.getElementById('btn-facturar-cot'), bsd = document.getElementById('btn-save-doc'); 
  if(dmo) dmo.style.display = type === 'Factura' ? 'flex' : 'none'; 
  if(bfc) bfc.style.display = type === 'Cotización' ? 'inline-flex' : 'none'; 
  if(bsd) bsd.innerText = type === 'Cotización' ? 'Guardar Cotización' : 'Emitir Factura'; 
}

function startFromProd(type, prodId) { 
  openDocBuilder(type); 
  const p = inventory.find(x => x.id === prodId); 
  if(p) { 
    currentItems = [{
      id: p.id, 
      name: p.name, 
      serial: p.serial || '',
      imei: p.imei || '',
      warranty: p.warranty || 'Sin garantía',
      cost: p.cost, 
      price: p.price, 
      qty: 1
    }]; 
    renderDocItems(); 
    calcDoc(); 
  } 
}

function fillClientData() { 
  const nameEl = document.getElementById('doc-client-name'); 
  if(!nameEl) return; 
  const c = clients.find(x => x.name.toLowerCase() === nameEl.value.trim().toLowerCase()); 
  if(c) { 
    const select = document.getElementById('doc-client-select');
    if (select) select.value = c.id;
    const ce = document.getElementById('doc-client-email'), cp = document.getElementById('doc-client-phone'), cr = document.getElementById('doc-client-rnc'); 
    if(ce) ce.value = c.email || ''; 
    if(cp) cp.value = c.address || ''; 
    if(cr) cr.value = c.rnc || ''; 
  } 
}

function addDocItem() { 
  const idEl = document.getElementById('doc-product-select'), qtyEl = document.getElementById('doc-qty'); 
  if(!idEl || !qtyEl) return; 
  const id = idEl.value, qty = parseFloat(qtyEl.value); 
  if(!id || isNaN(qty) || qty <= 0) return showToast("Selecciona un equipo/producto y cantidad válida"); 
  const prod = inventory.find(i => i.id === id); 
  if(prod) { 
    currentItems.push({
      id: prod.id, 
      name: prod.name, 
      serial: prod.serial || '',
      imei: prod.imei || '',
      warranty: prod.warranty || 'Sin garantía',
      cost: prod.cost, 
      price: prod.price, 
      qty
    }); 
    qtyEl.value = '1'; 
    idEl.value = '';
    renderDocItems(); 
    calcDoc(); 
  } 
}

function delDocItem(idx) { currentItems.splice(idx,1); renderDocItems(); calcDoc(); }

function renderDocItems() { 
  const el = document.getElementById('doc-items-list'); 
  if(!el) return;
  el.innerHTML = currentItems.map((item, idx) => {
    const detailParts = [];
    if (item.serial) detailParts.push(`SN: ${item.serial}`);
    if (item.imei) detailParts.push(`IMEI: ${item.imei}`);
    if (item.warranty && item.warranty !== 'Sin garantía') detailParts.push(`Garantía: ${item.warranty}`);
    const detailStr = detailParts.length ? `<br><small style="color:var(--muted);">${detailParts.join(' | ')}</small>` : '';

    return `
    <div class="item-row">
      <span style="font-size:13px;">${item.qty}x <strong>${item.name}</strong>${detailStr}</span>
      <div>${fMoney(item.price * item.qty)} <button style="background:none;border:none;color:var(--danger);margin-left:10px;cursor:pointer;" onclick="delDocItem(${idx})">✖</button></div>
    </div>`;
  }).join(''); 
}

function calcDoc() {
  const subtotal = currentItems.reduce((s, i) => s + (i.price * i.qty), 0);
  const totalCost = currentItems.reduce((s, i) => s + (i.cost * i.qty), 0);
  const taxEl = document.getElementById('doc-tax'), discEl = document.getElementById('doc-disc'), hoursEl = document.getElementById('doc-hours'), rateEl = document.getElementById('doc-rate');
  const taxPct = taxEl ? parseFloat(taxEl.value)||0 : 0; 
  const discPct = discEl ? parseFloat(discEl.value)||0 : 0;
  let total = subtotal, labor = 0; 
  if(hoursEl && rateEl) labor = (parseFloat(hoursEl.value)||0) * (parseFloat(rateEl.value)||0); 
  total += labor; 
  const discAmt = total * (discPct/100); 
  total -= discAmt; 
  const taxAmt = total * (taxPct/100); 
  total += taxAmt; 
  const profit = total - taxAmt - totalCost; 
  const curEl = document.getElementById('currency'); 
  const cur = curEl ? curEl.value : 'DOP';
  docTotals = { subtotal, discAmt, taxAmt, total, taxPct, discPct, labor, profit, totalCost, currency: cur, exchangeRate: exchangeRates[cur] || 1 }; 
  const sSub = document.getElementById('s-sub'), sTotLbl = document.getElementById('s-total-label'), sFin = document.getElementById('s-final'), docType = document.getElementById('doc-type');
  if(sSub) sSub.innerText = fMoney(subtotal); 
  if(sTotLbl) sTotLbl.innerText = docType && docType.value === 'Factura' ? 'Total a Pagar:' : 'Total Cotizado:'; 
  if(sFin) sFin.innerText = fMoney(total);
}

async function convertAndSave() { 
  const dt = document.getElementById('doc-type'); 
  if(dt) dt.value = 'Factura'; 
  toggleDocUI(); 
  saveDoc(true); 
}

async function getSequentialNumbers(type, ncfType) {
  const counterRef = getRef('config').doc('counters');
  return await db.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);
    const data = counterDoc.exists ? counterDoc.data() : {};
    const field = type === 'Factura' ? 'invoiceCount' : 'quoteCount'; 
    const prefix = type === 'Factura' ? 'FAC-' : 'COT-'; 
    const newCount = (data[field] || 0) + 1;
    
    let updates = { [field]: newCount };
    let generatedNcf = '';

    if (type === 'Factura' && ncfType && ncfType !== 'Interna') {
      const ncfField = `ncf_${ncfType}`;
      const newNcfCount = (data[ncfField] || 0) + 1;
      updates[ncfField] = newNcfCount;
      generatedNcf = `${ncfType}${newNcfCount.toString().padStart(8, '0')}`;
    }

    transaction.set(counterRef, updates, { merge: true });
    return {
      docNum: `${prefix}${newCount.toString().padStart(4, '0')}`,
      ncf: generatedNcf
    };
  });
}

async function saveDoc(isConverting = false) {
  const nameEl = document.getElementById('doc-client-name'), typeEl = document.getElementById('doc-type');
  if(!nameEl || !typeEl) return;
  const name = nameEl.value.trim(), type = typeEl.value; 
  if(!name || currentItems.length === 0) return showToast("Agrega un cliente y al menos un producto");

  const ncfType = document.getElementById('doc-ncf-type')?.value || 'B02';
  const rncVal = document.getElementById('doc-client-rnc')?.value.trim() || '';
  if (type === 'Factura' && ['B01', 'B14', 'B15'].includes(ncfType) && !rncVal) {
    return showToast(`El comprobante ${ncfType} exige el RNC/Cédula del cliente`);
  }

  const oldDoc = editDocId ? documents.find(d => d.id === editDocId) : null; 
  let docNum = oldDoc ? oldDoc.num : '';
  let finalNcf = document.getElementById('doc-ncf-custom')?.value.trim() || (oldDoc ? oldDoc.ncf || '' : '');
  
  let stockUpdates = [];
  if (type === 'Factura') {
    for (const item of currentItems) {
      const prod = inventory.find(x => x.id === item.id); 
      if (!prod) continue;
      let oldQty = 0; 
      if (oldDoc && oldDoc.type === 'Factura' && !isConverting) { 
        const oldItem = oldDoc.items.find(x => x.id === item.id); 
        if (oldItem) oldQty = oldItem.qty; 
      }
      const qtyDifference = item.qty - oldQty; 
      if (qtyDifference > 0 && prod.stock < qtyDifference) { 
        return showToast(`Stock insuficiente para: ${item.name} (Disp: ${prod.stock})`); 
      }
      if (qtyDifference !== 0) { 
        stockUpdates.push({ id: prod.id, name: prod.name, change: -qtyDifference, newStock: prod.stock - qtyDifference, desc: oldDoc && !isConverting ? `Edición Fac. ${docNum || 'Pendiente'}` : `Venta Fac. ${docNum || 'Pendiente'}` }); 
      }
    }
    if (oldDoc && oldDoc.type === 'Factura' && !isConverting) {
      for (const oldItem of oldDoc.items) {
        if (!currentItems.find(x => x.id === oldItem.id)) {
          const prod = inventory.find(x => x.id === oldItem.id);
          if (prod) stockUpdates.push({ id: prod.id, name: prod.name, change: oldItem.qty, newStock: prod.stock + oldItem.qty, desc: `Restaurado de Fac. ${docNum}` }); 
        }
      }
    }
  }

  if (!oldDoc || (oldDoc.type === 'Cotización' && type === 'Factura')) {
    showToast("Asignando numeración y NCF...");
    const seq = await getSequentialNumbers(type, ncfType);
    docNum = seq.docNum;
    if (!finalNcf) finalNcf = seq.ncf;
    stockUpdates.forEach(update => { update.desc = update.desc.replace('Pendiente', docNum); });
  }

  for (const update of stockUpdates) { 
    await getRef('inventory').doc(update.id).update({ stock: update.newStock }); 
    await logMovement(update.id, update.name, update.change, update.newStock, update.desc); 
  }
  
  const pm = document.getElementById('doc-payment')?.value || 'Efectivo'; 
  const dueDate = document.getElementById('doc-due-date')?.value || '';
  const emailVal = document.getElementById('doc-client-email')?.value.trim() || '';
  const phoneVal = document.getElementById('doc-client-phone')?.value.trim() || '';
  const nowStr = new Date().toLocaleDateString('es-DO');

  let finalStatus = 'Activa';
  let paymentsArr = oldDoc && Array.isArray(oldDoc.payments) ? [...oldDoc.payments] : [];
  let paidAmt = 0;

  if (type === 'Factura') { 
    if (!oldDoc || isConverting) {
      if (pm === 'Crédito') {
        finalStatus = 'Crédito';
        paymentsArr = [];
        paidAmt = 0;
      } else {
        finalStatus = 'Pagada';
        paidAmt = docTotals.total;
        paymentsArr = [{ amount: docTotals.total, method: pm, date: nowStr, timestamp: Date.now(), note: 'Pago al facturar' }];
      }
    } else {
      paidAmt = paymentsArr.reduce((s, p) => s + (Number(p.amount)||0), 0);
      if (paidAmt >= docTotals.total - 0.01) finalStatus = 'Pagada';
      else finalStatus = oldDoc.status === 'Pagada' ? 'Crédito' : oldDoc.status;
    }
  }
  
  const doc = { 
    num: docNum, 
    type, 
    ncfType: type === 'Factura' ? ncfType : '',
    ncf: type === 'Factura' ? finalNcf : '',
    date: oldDoc && !isConverting ? oldDoc.date : nowStr, 
    timestamp: oldDoc && !isConverting ? oldDoc.timestamp : Date.now(), 
    dueDate: dueDate, 
    paymentMethod: pm, 
    client: { name, rnc: rncVal, email: emailVal, phone: phoneVal }, 
    items: [...currentItems], 
    totals: docTotals, 
    payments: paymentsArr,
    paidAmount: paidAmt,
    status: finalStatus 
  };
  
  if(editDocId && !isConverting) { await getRef('documents').doc(editDocId).update(doc); } 
  else { await getRef('documents').add(doc); }
  
  showToast("Documento Guardado"); 
  navTo(type === 'Factura' ? 'sec-invoices' : 'sec-quotes');
}

function editDoc(id) {
  const d = documents.find(x => x.id === id); 
  if(!d) return; 
  openDocBuilder(d.type); 
  const titleLbl = document.getElementById('doc-title-label'); 
  if(titleLbl) titleLbl.innerText = "Editando " + d.num; 
  editDocId = d.id;
  if(d.dueDate) document.getElementById('doc-due-date').value = d.dueDate; 
  if(d.paymentMethod) document.getElementById('doc-payment').value = d.paymentMethod;
  if(d.ncfType) document.getElementById('doc-ncf-type').value = d.ncfType;
  if(d.ncf) document.getElementById('doc-ncf-custom').value = d.ncf;
  document.getElementById('doc-client-name').value = d.client.name; 
  document.getElementById('doc-client-rnc').value = d.client.rnc || ''; 
  document.getElementById('doc-client-email').value = d.client.email || ''; 
  document.getElementById('doc-client-phone').value = d.client.phone || '';
  
  const clientMatch = clients.find(c => c.name.toLowerCase() === d.client.name.toLowerCase());
  const select = document.getElementById('doc-client-select');
  if (select) select.value = clientMatch ? clientMatch.id : '';

  currentItems = [...d.items]; 
  document.getElementById('doc-tax').value = d.totals.taxPct; 
  document.getElementById('doc-disc').value = d.totals.discPct; 
  renderDocItems(); 
  calcDoc();
}

function clearDoc() { 
  editDocId = null; 
  ['doc-client-name', 'doc-client-rnc', 'doc-client-email', 'doc-client-phone', 'doc-ncf-custom', 'doc-due-date'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  const clientSelect = document.getElementById('doc-client-select');
  if (clientSelect) clientSelect.value = '';
  const prodSelect = document.getElementById('doc-product-select');
  if (prodSelect) prodSelect.value = '';

  const taxEl = document.getElementById('doc-tax'); if(taxEl) taxEl.value = '18';
  const discEl = document.getElementById('doc-disc'); if(discEl) discEl.value = '0';
  currentItems = []; 
  renderDocItems(); 
  calcDoc(); 
}

async function changeStatus(id, newStatus) { 
  const d = documents.find(x => x.id === id);
  if(!d) return;
  let updates = { status: newStatus };
  if (newStatus === 'Pagada' && getDocBalance(d) > 0.01) {
    const bal = getDocBalance(d);
    const payments = Array.isArray(d.payments) ? [...d.payments] : [];
    payments.push({ amount: bal, method: d.paymentMethod === 'Crédito' ? 'Efectivo' : (d.paymentMethod || 'Efectivo'), date: new Date().toLocaleDateString('es-DO'), timestamp: Date.now(), note: 'Saldado manual' });
    updates.payments = payments;
    updates.paidAmount = d.totals.total;
  }
  await getRef('documents').doc(id).update(updates); 
}

async function delDoc(id) { 
  if(!confirm("¿Estás seguro de eliminar este documento?")) return;
  const docToDel = documents.find(x => x.id === id); 
  if(!docToDel) return;
  if (docToDel.type === 'Factura') {
    showToast("Restaurando stock...");
    for (const item of docToDel.items) {
      const prod = inventory.find(x => x.id === item.id);
      if (prod) { 
        const newStock = prod.stock + item.qty; 
        await getRef('inventory').doc(prod.id).update({ stock: newStock }); 
        await logMovement(prod.id, prod.name, item.qty, newStock, `Anulación Fac. ${docToDel.num}`); 
      }
    }
  }
  await getRef('documents').doc(id).delete(); 
  showToast("Documento eliminado y stock restaurado");
}

// ABONOS PARCIALES Y RECIBOS INDIVIDUALES
function openAbonoModal(docId) {
  currentAbonoDocId = docId;
  renderAbonoModalData();
  document.getElementById('modal-abono').classList.add('active');
}

function renderAbonoModalData() {
  const d = documents.find(x => x.id === currentAbonoDocId);
  if(!d) return;
  const cur = d.totals.currency || 'DOP';
  const total = d.totals.total || 0;
  const paid = getDocPaid(d);
  const balance = getDocBalance(d);

  document.getElementById('ab-title').innerText = `💵 Abonos — ${d.num}`;
  document.getElementById('ab-subtitle').innerText = `Cliente: ${d.client.name} ${d.ncf ? '| NCF: ' + d.ncf : ''}`;
  document.getElementById('ab-total').innerText = fMoney(total, cur);
  document.getElementById('ab-paid').innerText = fMoney(paid, cur);
  document.getElementById('ab-balance').innerText = fMoney(balance, cur);

  const amtInput = document.getElementById('ab-amount');
  if(amtInput) amtInput.value = balance > 0 ? balance.toFixed(2) : '0.00';
  const noteInput = document.getElementById('ab-note');
  if(noteInput) noteInput.value = '';

  const formBox = document.getElementById('ab-form-box');
  if(formBox) formBox.style.display = balance > 0.01 ? 'block' : 'none';

  const payments = Array.isArray(d.payments) ? d.payments : [];
  const listEl = document.getElementById('ab-history-list');
  if(listEl) {
    listEl.innerHTML = payments.map((p, idx) => `
      <div class="item-row" style="padding:8px 10px; flex-wrap:wrap;">
        <div>
          <strong>${fMoney(p.amount, cur)}</strong> <span class="badge ncf">${p.method}</span><br>
          <small style="color:var(--muted);">${p.date} ${p.note ? '• ' + p.note : ''}</small>
        </div>
        <div style="display:flex; gap:4px; align-items:center;">
          <button class="btn btn-pos btn-small" title="Imprimir Recibo" onclick="printReceiptAbonoPOS('${d.id}', ${idx})">🖨️</button>
          <button class="btn btn-whatsapp btn-small" title="Enviar WhatsApp" onclick="shareAbonoWhatsApp('${d.id}', ${idx})">📲</button>
          ${['Dueño', 'Administrador'].includes(currentUserRole) ? `<button class="btn-small" style="background:var(--danger); color:#fff; border:none;" onclick="delAbono(${idx})">✖</button>` : ''}
        </div>
      </div>
    `).join('') || '<p style="font-size:12px; color:var(--muted); text-align:center;">No
