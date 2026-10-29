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

// =========================================================
// MÓDULO DE VALIDACIONES ESTRICTAS DOMINICANAS
// =========================================================
function sanitizeDigitsOnly(input) {
  input.value = input.value.replace(/\D/g, '');
}

function sanitizePositiveInt(input) {
  let val = input.value.replace(/\D/g, '');
  input.value = val === '' ? '' : Math.max(1, parseInt(val, 10));
}

function sanitizeName(input) {
  input.value = input.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s\.\-]/g, '');
}

function formatPhoneInput(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 10);
  if (v.length > 6) {
    input.value = `${v.slice(0, 3)}-${v.slice(3, 6)}-${v.slice(6)}`;
  } else if (v.length > 3) {
    input.value = `${v.slice(0, 3)}-${v.slice(3)}`;
  } else {
    input.value = v;
  }
}

function isValidDominicanPhone(phoneStr) {
  const digits = (phoneStr || '').replace(/\D/g, '');
  if (digits.length !== 10) return false;
  const prefix = digits.slice(0, 3);
  return ['809', '829', '849'].includes(prefix);
}

function formatRNCInput(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 11);
  if (v.length > 9) {
    // Formato Cédula: 000-0000000-0
    input.value = `${v.slice(0, 3)}-${v.slice(3, 10)}-${v.slice(10)}`;
  } else if (v.length > 3) {
    // Formato RNC Jurídico: 0-00-00000-0
    if (v.length <= 8) {
      input.value = `${v.slice(0, 1)}-${v.slice(1, 3)}-${v.slice(3)}`;
    } else {
      input.value = `${v.slice(0, 1)}-${v.slice(1, 3)}-${v.slice(3, 8)}-${v.slice(8)}`;
    }
  } else {
    input.value = v;
  }
}

function validateCedulaMod10(cedula) {
  const c = cedula.replace(/\D/g, '');
  if (c.length !== 11) return false;
  const mod10Weights = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let calc = parseInt(c.charAt(i), 10) * mod10Weights[i];
    if (calc >= 10) calc = Math.floor(calc / 10) + (calc % 10);
    sum += calc;
  }
  const verifier = (10 - (sum % 10)) % 10;
  return verifier === parseInt(c.charAt(10), 10);
}

function validateRncMod11(rnc) {
  const r = rnc.replace(/\D/g, '');
  if (r.length !== 9) return false;
  const weights = [7, 9, 8, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += parseInt(r.charAt(i), 10) * weights[i];
  }
  const remainder = sum % 11;
  let verifier = 0;
  if (remainder === 0) verifier = 2;
  else if (remainder === 1) verifier = 1;
  else verifier = 11 - remainder;
  return verifier === parseInt(r.charAt(8), 10);
}

function isValidDominicanIdOrRNC(val) {
  const clean = (val || '').replace(/\D/g, '');
  if (clean.length === 11) return validateCedulaMod10(clean);
  if (clean.length === 9) return validateRncMod11(clean);
  return false;
}

// GENERADOR AUTOMÁTICO DE CÓDIGO SERIE ÚNICO DE PRODUCTO (SKU/UID)
function generateUniqueSKU() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `CIF-${rand}`;
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

// ESCÁNER DE CÓDIGO DE BARRAS / IMEI
function startBarcodeScan(mode = 'doc') {
  scanTargetMode = mode;
  const modal = document.getElementById('modal-scanner');
  if (modal) modal.classList.add('active');
  const statusEl = document.getElementById('scanner-status');
  if (statusEl) statusEl.innerText = mode === 'inv' ? "Apunta al código IMEI de la caja o equipo..." : "Apunta al código IMEI para facturar...";

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

  if (scanTargetMode === 'inv') {
    const barEl = document.getElementById('i-barcode');
    if (barEl) barEl.value = code;
    showToast(`IMEI asignado: ${code}`);
    return;
  }

  const prod = inventory.find(i => 
    (i.barcode && i.barcode.trim() === code) || 
    (i.sku && i.sku.trim().toUpperCase() === code.toUpperCase()) || 
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
        barcode: prod.barcode || '', 
        sku: prod.sku || '', 
        warranty: prod.warranty || '30 Días',
        cost: prod.cost, 
        price: prod.price, 
        qty: 1 
      });
    }
    renderDocItems();
    calcDoc();
    showToast(`+1 ${prod.name}`);
  } else {
    showToast(`IMEI no registrado: ${code}`);
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

  if(!e || !p || !n || !loc) return showToast("Faltan datos obligatorios");
  if(n.length < 3) return showToast("El nombre debe tener al menos 3 caracteres");
  if(id && !isValidDominicanIdOrRNC(id)) return showToast("La Cédula o RNC ingresado no es válido en RD");
  if(ph && !isValidDominicanPhone(ph)) return showToast("El teléfono debe tener formato dominicano válido (809/829/849)");

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

    getRef('inventory').onSnapshot(snap => { inventory = snap.docs.map(d => ({id: d.id, ...d.data()})); updateAllViews(); updateSelects(); });
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

    if (!document.getElementById('i-sku')?.value) {
      document.getElementById('i-sku').value = generateUniqueSKU();
    }

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

function saveInv() { 
  const n = document.getElementById('i-name').value.trim();
  const barcode = document.getElementById('i-barcode')?.value.trim() || '';
  let sku = document.getElementById('i-sku')?.value.trim();
  if (!sku) sku = generateUniqueSKU();
  const warranty = document.getElementById('i-warranty')?.value || '30 Días';
  const c = parseFloat(document.getElementById('i-cost').value);
  const p = parseFloat(document.getElementById('i-price').value);
  const s = parseInt(document.getElementById('i-stock').value);
  const margin = parseFloat(document.getElementById('i-margin').value) || 0;
  const f = document.getElementById('i-img').files[0]; 
  
  if(!n) return showToast("El nombre del equipo/producto es obligatorio"); 
  if(isNaN(c) || c < 0) return showToast("El costo debe ser un valor positivo");
  if(isNaN(p) || p <= 0) return showToast("El precio de venta debe ser mayor a cero");
  if(isNaN(s) || s < 0) return showToast("La existencia debe ser un número entero válido");
  if(barcode && barcode.length < 8) return showToast("El IMEI/Código debe contener al menos 8 dígitos");

  // Validar unicidad de IMEI en el inventario
  const duplicate = inventory.find(i => i.barcode && i.barcode === barcode && i.id !== editInvId);
  if(barcode && duplicate) {
    return showToast(`¡Error! El IMEI ${barcode} ya está asignado a: ${duplicate.name}`);
  }
  
  const cb = async (imgData) => { 
    const data = { 
      name: n, 
      barcode: barcode, 
      sku: sku,
      warranty: warranty,
      cost: c, 
      price: p, 
      margin: margin, 
      stock: s, 
      img: imgData 
    };
    let change = s, desc = "Inventario inicial";
    if(editInvId) { 
      const oldProd = inventory.find(i => i.id === editInvId);
      change = s - (oldProd ? oldProd.stock : 0); 
      desc = "Ajuste manual de almacén";
      await getRef('inventory').doc(editInvId).update(data); 
      logMovement(editInvId, n, change, s, desc);
    } else { 
      const newDoc = await getRef('inventory').add(data); 
      logMovement(newDoc.id, n, change, s, desc); 
    } 
    clearInvForm(); 
    showToast("Producto / Equipo Guardado con éxito"); 
  }; 
  if(f) compressImage(f, cb); else cb(editInvId ? inventory.find(i=>i.id===editInvId).img : null); 
}

function delInv(id) { if(confirm("¿Eliminar este producto del almacén?")) getRef('inventory').doc(id).delete(); }

function editInv(id) { 
  const i = inventory.find(x => x.id === id); 
  if(!i) return; 
  document.getElementById('i-name').value = i.name; 
  const barEl = document.getElementById('i-barcode'); if (barEl) barEl.value = i.barcode || '';
  const skuEl = document.getElementById('i-sku'); if (skuEl) skuEl.value = i.sku || generateUniqueSKU();
  const warEl = document.getElementById('i-warranty'); if (warEl) warEl.value = i.warranty || '30 Días';
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
  document.getElementById('inv-form-title').innerText = "Editar Producto / Equipo"; 
  document.getElementById('btn-save-inv').innerText = "Actualizar"; 
  window.scrollTo(0,0); 
}

function clearInvForm() { 
  document.getElementById('i-name').value = ''; 
  const barEl = document.getElementById('i-barcode'); if (barEl) barEl.value = '';
  const skuEl = document.getElementById('i-sku'); if (skuEl) skuEl.value = generateUniqueSKU();
  const warEl = document.getElementById('i-warranty'); if (warEl) warEl.value = '30 Días';
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
    (i.barcode && i.barcode.toLowerCase().includes(q)) ||
    (i.sku && i.sku.toLowerCase().includes(q))
  );
  el.innerHTML = filtered.map(i => {
    const profitMargin = i.cost > 0 ? Math.round(((i.price - i.cost) / i.cost) * 100) : 0;
    return `
    <div class="item-row">
      <div style="display:flex; gap:10px; align-items:center;">
        ${i.img ? `<img src="${i.img}" class="prod-img">` : '<div class="prod-img"></div>'}
        <div>
          <strong>${i.name}</strong> 
          ${i.sku ? `<span class="badge ncf" style="color:var(--accent);">Serie: ${i.sku}</span>` : ''}
          ${i.barcode ? `<span class="badge ncf">IMEI: ${i.barcode}</span>` : ''} 
          ${i.stock <= 3 ? `<span class="badge low-stock">¡Stock: ${i.stock}!</span>` : ''}<br>
          <small style="color:var(--muted);">Garantía: <strong>${i.warranty || '30 Días'}</strong> | Costo: ${fMoney(i.cost)} | Venta: <strong style="color:var(--text);">${fMoney(i.price)}</strong> (+${profitMargin}%) | Stock: ${i.stock}</small>
        </div>
      </div>
      <div style="display:flex; gap:5px;">
        <button class="btn-small btn-outline" onclick="editInv('${i.id}')">✏️</button>
        <button class="btn-small" style="background:var(--danger); border:none; color:#fff;" onclick="delInv('${i.id}')">✖</button>
      </div>
    </div>`;
  }).join('') || '<p style="color:var(--muted); font-size:13px; text-align:center;">No se encontraron productos o equipos.</p>'; 
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
  const n = document.getElementById('c-name').value.trim();
  const e = document.getElementById('c-email').value.trim();
  const a = document.getElementById('c-address').value.trim();
  const rnc = document.getElementById('c-rnc').value.trim(); 
  
  if(!n || n.length < 3) return showToast("Ingresa un nombre válido de cliente (Mínimo 3 letras)");
  if(rnc && !isValidDominicanIdOrRNC(rnc)) return showToast("El RNC o Cédula dominicana ingresada es inválida");
  if(a && !isValidDominicanPhone(a)) return showToast("El teléfono debe tener un prefijo dominicano válido (809/829/849)");

  getRef('clients').add({name:n, email:e, address:a, rnc: rnc, timestamp: Date.now()}); 
  document.getElementById('c-name').value=''; document.getElementById('c-email').value=''; document.getElementById('c-address').value=''; document.getElementById('c-rnc').value=''; 
  showToast("Cliente registrado correctamente"); 
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
    ps.innerHTML = '<option value="">-- Elige un producto por Nombre o IMEI --</option>' +
      inventory.map(i => {
        const imeiTag = i.barcode ? ` [IMEI: ${i.barcode}]` : '';
        const serieTag = i.sku ? ` [${i.sku}]` : '';
        return `<option value="${i.id}">${i.name}${imeiTag}${serieTag} — ${fMoney(i.price)} (Disp: ${i.stock})</option>`;
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
  const c = document.getElementById('p-concept').value.trim();
  const a = parseFloat(document.getElementById('p-amount').value);
  const d = document.getElementById('p-date').value; 
  if(!c || isNaN(a) || a<=0) return showToast("Ingresa un concepto y un monto válido"); 
  getRef('payables').add({concept: c, amount: a, date: d, status: 'Pendiente', timestamp: Date.now()}); 
  document.getElementById('p-concept').value=''; document.getElementById('p-amount').value='0'; 
  showToast("Compromiso Registrado"); 
}
function togglePayableStatus(id, stat) { getRef('payables').doc(id).update({status: stat}); }
function delPayable(id) { getRef('payables').doc(id).delete(); }
function renderPayables() { 
  const el = document.getElementById('payables-list'); 
  if(el) el.innerHTML = payables.map(p => `<div class="item-row"><div><strong>${p.concept}</strong><br><small style="color:var(--muted);">${p.date ? 'Vence: '+p.date : 'Sin fecha'} | ${fMoney(p.amount)}</small></div><div style="display:flex;gap:5px;align-items:center;"><select style="width:auto; margin:0; font-size:11px; padding:4px;" onchange="togglePayableStatus('${p.id}', this.value)"><option value="Pendiente" ${p.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagado" ${p.status==='Pagado'?'selected':''}>Pagado</option></select><button class="btn-small" style="background:var(--danger);border:none;color:#fff;" onclick="delPayable('${p.id}')">✖</button></div></div>`).join('') || '<p style="color:var(--muted);font-size:13px;">No hay cuentas pendientes.</p>'; 
}

function saveReceivable() { 
  const c = document.getElementById('r-concept').value.trim();
  const a = parseFloat(document.getElementById('r-amount').value);
  const d = document.getElementById('r-date').value; 
  if(!c || isNaN(a) || a<=0) return showToast("Ingresa un deudor y un monto válido"); 
  getRef('receivables').add({concept: c, amount: a, date: d, status: 'Pendiente', timestamp: Date.now()}); 
  document.getElementById('r-concept').value=''; document.getElementById('r-amount').value='0'; 
  showToast("Cuenta por Cobrar Guardada"); 
}
function toggleReceivableStatus(id, stat) { getRef('receivables').doc(id).update({status: stat}); }
function delReceivable(id) { getRef('receivables').doc(id).delete(); }
function renderReceivables() { 
  const el = document.getElementById('receivables-list'); 
  if(el) el.innerHTML = receivables.map(r => `<div class="item-row"><div><strong>${r.concept}</strong><br><small style="color:var(--muted);">${r.date ? 'Vence: '+r.date : 'Sin fecha'} | ${fMoney(r.amount)}</small></div><div style="display:flex;gap:5px;align-items:center;"><select style="width:auto; margin:0; font-size:11px; padding:4px;" onchange="toggleReceivableStatus('${r.id}', this.value)"><option value="Pendiente" ${r.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagado" ${r.status==='Pagado'?'selected':''}>Pagado</option></select><button class="btn-small" style="background:var(--danger);border:none;color:#fff;" onclick="delReceivable('${r.id}')">✖</button></div></div>`).join('') || '<p style="color:var(--muted);font-size:13px;">No hay cobros manuales.</p>'; 
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
      barcode: p.barcode || '', 
      sku: p.sku || '', 
      warranty: p.warranty || '30 Días',
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
  if(!id || isNaN(qty) || qty <= 0) return showToast("Selecciona un producto y cantidad válida"); 
  const prod = inventory.find(i => i.id === id); 
  if(prod) { 
    currentItems.push({
      id: prod.id, 
      name: prod.name, 
      barcode: prod.barcode || '', 
      sku: prod.sku || '', 
      warranty: prod.warranty || '30 Días',
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
  if(el) el.innerHTML = currentItems.map((item, idx) => `
    <div class="item-row" style="flex-wrap:wrap;">
      <div>
        <span style="font-size:13px;">${item.qty}x <strong>${item.name}</strong></span><br>
        <small style="color:var(--muted);">
          ${item.sku ? `Serie: <strong>${item.sku}</strong> | ` : ''}
          ${item.barcode ? `IMEI: <strong>${item.barcode}</strong> | ` : ''}
          Garantía: ${item.warranty || '30 Días'}
        </small>
      </div>
      <div>
        ${fMoney(item.price * item.qty)} 
        <button style="background:none;border:none;color:var(--danger);margin-left:10px;cursor:pointer;" onclick="delDocItem(${idx})">✖</button>
      </div>
    </div>`).join(''); 
}

function calcDoc() {
  const subtotal = currentItems.reduce((s, i) => s + (i.price * i.qty), 0);
  const totalCost = currentItems.reduce((s, i) => s + (i.cost * i.qty), 0);
  const taxEl = document.getElementById('doc-tax'), discEl = document.getElementById('doc-disc'), hoursEl = document.getElementById('doc-hours'), rateEl = document.getElementById('doc-rate');
  const taxPct = taxEl ? Math.max(0, parseFloat(taxEl.value)||0) : 0; 
  const discPct = discEl ? Math.min(100, Math.max(0, parseFloat(discEl.value)||0)) : 0;
  let total = subtotal, labor = 0; 
  if(hoursEl && rateEl) labor = Math.max(0, (parseFloat(hoursEl.value)||0)) * Math.max(0, (parseFloat(rateEl.value)||0)); 
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
  if (type === 'Factura' && ['B01', 'B14', 'B15'].includes(ncfType)) {
    if (!rncVal) return showToast(`El comprobante ${ncfType} exige el RNC/Cédula del cliente`);
    if (!isValidDominicanIdOrRNC(rncVal)) return showToast("El RNC/Cédula ingresado es inválido según DGII");
  }

  const phoneVal = document.getElementById('doc-client-phone')?.value.trim() || '';
  if (phoneVal && !isValidDominicanPhone(phoneVal)) {
    return showToast("El teléfono del cliente debe tener un formato dominicano válido");
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
    `).join('') || '<p style="font-size:12px; color:var(--muted); text-align:center;">No hay abonos registrados en esta factura.</p>';
  }
}

async function saveAbono() {
  const d = documents.find(x => x.id === currentAbonoDocId);
  if(!d) return;
  const amount = parseFloat(document.getElementById('ab-amount')?.value);
  const method = document.getElementById('ab-method')?.value || 'Efectivo';
  const note = document.getElementById('ab-note')?.value.trim() || '';
  const balance = getDocBalance(d);

  if(isNaN(amount) || amount <= 0) return showToast("Ingresa un monto válido");
  if(amount > balance + 0.05) return showToast("El abono supera el balance pendiente");

  const payments = Array.isArray(d.payments) ? [...d.payments] : [];
  payments.push({
    amount: Math.min(amount, balance),
    method,
    note,
    date: new Date().toLocaleDateString('es-DO'),
    timestamp: Date.now()
  });

  const newPaid = payments.reduce((s, p) => s + (Number(p.amount)||0), 0);
  const newStatus = (newPaid >= d.totals.total - 0.01) ? 'Pagada' : 'Crédito';

  await getRef('documents').doc(d.id).update({
    payments,
    paidAmount: newPaid,
    status: newStatus
  });

  showToast(newStatus === 'Pagada' ? "¡Factura saldada en su totalidad!" : "Abono registrado correctamente");
}

async function delAbono(idx) {
  const d = documents.find(x => x.id === currentAbonoDocId);
  if(!d || !Array.isArray(d.payments)) return;
  if(!confirm("¿Eliminar este registro de pago?")) return;

  const payments = [...d.payments];
  payments.splice(idx, 1);
  const newPaid = payments.reduce((s, p) => s + (Number(p.amount)||0), 0);
  const newStatus = (newPaid >= d.totals.total - 0.01) ? 'Pagada' : 'Crédito';

  await getRef('documents').doc(d.id).update({
    payments,
    paidAmount: newPaid,
    status: newStatus
  });
  showToast("Pago eliminado");
}

function printReceiptAbonoPOS(docId, paymentIdx) {
  const d = documents.find(x => x.id === docId);
  if (!d || !d.payments || !d.payments[paymentIdx]) return;
  const p = d.payments[paymentIdx];
  const cur = d.totals.currency || 'DOP';
  const bizName = settings.name || 'MI NEGOCIO';
  const bizRnc = settings.id ? `RNC: ${settings.id}<br>` : '';
  const total = d.totals.total || 0;
  const totalPaid = getDocPaid(d);
  const balance = getDocBalance(d);

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: 80mm auto; margin: 0; }
        body { width: 74mm; margin: 0 auto; padding: 8px 4px; font-family: 'Courier New', Courier, monospace; font-size: 12px; color: #000; line-height: 1.3; }
        .center { text-align: center; }
        .right { text-align: right; }
        .bold { font-weight: bold; }
        .divider { border-top: 1px dashed #000; margin: 6px 0; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="center">
        <div style="font-size:16px; font-weight:bold;">${bizName}</div>
        ${bizRnc}
        <div class="bold" style="font-size:13px; margin-top:4px;">RECIBO DE INGRESO / ABONO</div>
      </div>
      <div class="divider"></div>
      <div>
        <strong>Recibo No:</strong> REC-${p.timestamp ? String(p.timestamp).slice(-6) : (paymentIdx+1)}<br>
        <strong>Factura Ref:</strong> ${d.num} ${d.ncf ? `(${d.ncf})` : ''}<br>
        <strong>Fecha:</strong> ${p.date}<br>
        <strong>Cliente:</strong> ${d.client.name}<br>
        ${d.client.rnc ? `<strong>RNC/Céd:</strong> ${d.client.rnc}<br>` : ''}
        <strong>Método:</strong> ${p.method}
        ${p.note ? `<br><strong>Nota:</strong> ${p.note}` : ''}
      </div>
      <div class="divider"></div>
      <table>
        <tr style="font-size:14px; font-weight:bold;">
          <td>MONTO ABONADO:</td>
          <td class="right">${fMoney(p.amount, cur)}</td>
        </tr>
      </table>
      <div class="divider"></div>
      <table>
        <tr><td>Total Factura:</td><td class="right">${fMoney(total, cur)}</td></tr>
        <tr><td>Total Acumulado Pagado:</td><td class="right">${fMoney(totalPaid, cur)}</td></tr>
        <tr class="bold"><td>BALANCE RESTANTE:</td><td class="right">${fMoney(balance, cur)}</td></tr>
      </table>
      <div class="divider"></div>
      <div class="center" style="margin-top:14px; font-size:11px;">
        ___________________________<br>
        Firma Cobrador / Cajero<br><br>
        ¡Gracias por su pago!<br>
        Generado por Cifra Cloud
      </div>
    </body>
    </html>
  `;
  triggerThermalPrint(html);
}

function shareAbonoWhatsApp(docId, paymentIdx) {
  const d = documents.find(x => x.id === docId);
  if (!d || !d.payments || !d.payments[paymentIdx]) return;
  const p = d.payments[paymentIdx];
  const cur = d.totals.currency || 'DOP';
  const bizName = settings.name || 'Nuestro Negocio';
  const bal = getDocBalance(d);

  const msg = `Hola *${d.client.name}*, confirmamos la recepción de tu pago:%0A%0A` +
    `*Recibo de Abono* a Factura: *${d.num}*%0A` +
    (d.ncf ? `*NCF:* ${d.ncf}%0A` : '') +
    `*Fecha:* ${p.date}%0A` +
    `*Vía:* ${p.method}%0A` +
    `*MONTO ABONADO:* *${fMoney(p.amount, cur)}*%0A` +
    (bal > 0.01 ? `*BALANCE RESTANTE:* *${fMoney(bal, cur)}*%0A%0A` : `*ESTADO:* *¡FACTURA TOTALMENTE SALDADA! 🎉*%0A%0A`) +
    `¡Gracias por tu pago! — *${bizName}*`;

  let phone = (d.client.phone || '').replace(/\D/g, '');
  if (phone.length === 10 && ['809', '829', '849'].includes(phone.substring(0, 3))) {
    phone = '1' + phone;
  }
  const url = phone ? `https://wa.me/${phone}?text=${msg}` : `https://wa.me/?text=${msg}`;
  window.open(url, '_blank');
}

function printPOS(id) {
  const d = documents.find(x => x.id === id);
  if(!d) return;
  const cur = d.totals.currency || 'DOP';
  const bizName = settings.name || 'MI NEGOCIO';
  const bizRnc = settings.id ? `RNC: ${settings.id}<br>` : '';
  const bizAddr = settings.address ? `${settings.address}<br>` : '';
  const docTitle = d.type === 'Factura' && d.ncfType && NCF_LABELS[d.ncfType] ? NCF_LABELS[d.ncfType] : d.type;
  const paid = getDocPaid(d);
  const balance = getDocBalance(d);

  const itemsRows = d.items.map(i => {
    const imeiLine = (i.barcode || i.sku) ? `<br><small style="font-size:10px;">${i.sku ? 'Serie:'+i.sku+' ' : ''}${i.barcode ? 'IMEI:'+i.barcode : ''} [Gar: ${i.warranty || '30 Días'}]</small>` : '';
    return `
      <tr>
        <td colspan="3" style="padding-top:4px; font-weight:bold;">${i.name}${imeiLine}</td>
      </tr>
      <tr>
        <td>${i.qty} x ${fMoney(i.price, cur)}</td>
        <td></td>
        <td style="text-align:right;">${fMoney(i.price * i.qty, cur)}</td>
      </tr>
    `;
  }).join('');

  const laborRow = d.totals.labor > 0 ? `
    <tr><td colspan="3" style="padding-top:4px; font-weight:bold;">Mano de Obra / Servicio</td></tr>
    <tr><td>1 x ${fMoney(d.totals.labor, cur)}</td><td></td><td style="text-align:right;">${fMoney(d.totals.labor, cur)}</td></tr>
  ` : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: 80mm auto; margin: 0; }
        body { width: 74mm; margin: 0 auto; padding: 8px 4px; font-family: 'Courier New', Courier, monospace; font-size: 12px; color: #000; line-height: 1.3; }
        .center { text-align: center; }
        .right { text-align: right; }
        .bold { font-weight: bold; }
        .divider { border-top: 1px dashed #000; margin: 6px 0; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="center">
        <div style="font-size:16px; font-weight:bold;">${bizName}</div>
        ${bizRnc}${bizAddr}
      </div>
      <div class="divider"></div>
      <div class="center bold" style="font-size:13px;">${docTitle.toUpperCase()}</div>
      <div>
        <strong>No:</strong> ${d.num}<br>
        ${d.ncf ? `<strong>NCF:</strong> ${d.ncf}<br>` : ''}
        <strong>Fecha:</strong> ${d.date}<br>
        <strong>Cliente:</strong> ${d.client.name}<br>
        ${d.client.rnc ? `<strong>RNC/Céd:</strong> ${d.client.rnc}<br>` : ''}
        <strong>Condición:</strong> ${d.paymentMethod || 'Contado'} (${d.status})
      </div>
      <div class="divider"></div>
      <table>
        <thead>
          <tr style="border-bottom:1px dashed #000;">
            <th style="text-align:left;">Cant x Precio</th>
            <th></th>
            <th style="text-align:right;">Valor</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
          ${laborRow}
        </tbody>
      </table>
      <div class="divider"></div>
      <table>
        <tr><td>Subtotal:</td><td class="right">${fMoney(d.totals.subtotal, cur)}</td></tr>
        ${d.totals.discAmt > 0 ? `<tr><td>Descuento:</td><td class="right">-${fMoney(d.totals.discAmt, cur)}</td></tr>` : ''}
        <tr><td>ITBIS (${d.totals.taxPct}%):</td><td class="right">${fMoney(d.totals.taxAmt, cur)}</td></tr>
        <tr style="font-size:14px; font-weight:bold;"><td style="padding-top:4px;">TOTAL:</td><td class="right" style="padding-top:4px;">${fMoney(d.totals.total, cur)}</td></tr>
        ${d.type === 'Factura' ? `
          <tr><td style="padding-top:4px;">Pagado / Abonado:</td><td class="right" style="padding-top:4px;">${fMoney(paid, cur)}</td></tr>
          ${balance > 0.01 ? `<tr style="font-weight:bold;"><td>BALANCE PENDIENTE:</td><td class="right">${fMoney(balance, cur)}</td></tr>` : ''}
        ` : ''}
      </table>
      <div class="divider"></div>
      <div class="center" style="margin-top:8px; font-size:11px;">
        Garantía válida con este comprobante.<br>
        ¡Gracias por preferirnos!<br>
        Generado por Cifra Cloud
      </div>
    </body>
    </html>
  `;
  triggerThermalPrint(html);
}

function triggerThermalPrint(htmlContent) {
  const iframe = document.getElementById('pos-print-frame');
  if(!iframe) return;
  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(htmlContent);
  doc.close();
  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  }, 250);
}

function isSameDay(ts, refDate) {
  if(!ts) return false;
  const d = new Date(ts);
  return d.getDate() === refDate.getDate() && d.getMonth() === refDate.getMonth() && d.getFullYear() === refDate.getFullYear();
}

function openCuadreModal() {
  const now = new Date();
  const targetCurrency = document.getElementById('currency')?.value || 'DOP';
  const targetRate = exchangeRates[targetCurrency] || 1;
  let cash = 0, transfer = 0, card = 0;
  let txs = [];

  documents.forEach(d => {
    if (d.type !== 'Factura') return;
    const docRate = d.totals?.exchangeRate || 1;

    if (Array.isArray(d.payments) && d.payments.length > 0) {
      d.payments.forEach(p => {
        if (isSameDay(p.timestamp, now)) {
          const val = ((Number(p.amount) || 0) / docRate) * targetRate;
          if (p.method === 'Efectivo') cash += val;
          else if (p.method === 'Transferencia') transfer += val;
          else if (p.method === 'Tarjeta') card += val;
          txs.push({ num: d.num, client: d.client.name, method: p.method, amount: val, note: p.note || 'Cobro', time: new Date(p.timestamp).toLocaleTimeString('es-DO', {hour:'2-digit', minute:'2-digit'}) });
        }
      });
    } else if (d.status === 'Pagada' && isSameDay(d.timestamp, now)) {
      const val = ((d.totals?.total || 0) / docRate) * targetRate;
      const m = d.paymentMethod || 'Efectivo';
      if (m === 'Efectivo') cash += val;
      else if (m === 'Transferencia') transfer += val;
      else if (m === 'Tarjeta') card += val;
      txs.push({ num: d.num, client: d.client.name, method: m, amount: val, note: 'Pago al facturar', time: new Date(d.timestamp).toLocaleTimeString('es-DO', {hour:'2-digit', minute:'2-digit'}) });
    }
  });

  const total = cash + transfer + card;
  lastCuadreData = { cash, transfer, card, total, txs };

  document.getElementById('cuadre-date-label').innerText = `Cierre del día: ${now.toLocaleDateString('es-DO', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`;
  document.getElementById('cuadre-cash').innerText = fMoney(cash);
  document.getElementById('cuadre-transfer').innerText = fMoney(transfer);
  document.getElementById('cuadre-card').innerText = fMoney(card);
  document.getElementById('cuadre-total').innerText = fMoney(total);

  const txListEl = document.getElementById('cuadre-tx-list');
  if(txListEl) {
    txListEl.innerHTML = txs.map(t => `
      <div class="item-row" style="padding:8px 10px;">
        <div><strong>${t.num} — ${t.client}</strong><br><small style="color:var(--muted);">${t.time} • ${t.note}</small></div>
        <div style="text-align:right;"><span class="badge ncf">${t.method}</span><br><strong style="color:var(--accent);">${fMoney(t.amount)}</strong></div>
      </div>
    `).join('') || '<p style="font-size:12px; color:var(--muted); text-align:center;">No se han registrado cobros en el día de hoy.</p>';
  }

  calcArqueo();
  document.getElementById('modal-cuadre').classList.add('active');
}

function calcArqueo() {
  const base = parseFloat(document.getElementById('cuadre-base')?.value) || 0;
  const counted = parseFloat(document.getElementById('cuadre-counted')?.value) || 0;
  const expected = base + lastCuadreData.cash;
  const diff = counted - expected;

  const expEl = document.getElementById('cuadre-expected');
  const diffEl = document.getElementById('cuadre-diff-label');
  if(expEl) expEl.innerText = fMoney(expected);
  if(diffEl) {
    if (Math.abs(diff) < 0.01) {
      diffEl.innerText = "✅ Cuadre Exacto";
      diffEl.style.color = "var(--accent)";
    } else if (diff > 0) {
      diffEl.innerText = `➕ Sobrante: ${fMoney(diff)}`;
      diffEl.style.color = "var(--info)";
    } else {
      diffEl.innerText = `⚠️ Faltante: ${fMoney(Math.abs(diff))}`;
      diffEl.style.color = "var(--danger)";
    }
  }
}

function printCuadrePOS() {
  const base = parseFloat(document.getElementById('cuadre-base')?.value) || 0;
  const counted = parseFloat(document.getElementById('cuadre-counted')?.value) || 0;
  const expected = base + lastCuadreData.cash;
  const diff = counted - expected;
  const bizName = settings.name || 'MI NEGOCIO';
  const nowStr = new Date().toLocaleString('es-DO');

  const txRows = lastCuadreData.txs.map(t => `
    <tr>
      <td>${t.num} (${t.method.slice(0,5)})</td>
      <td style="text-align:right;">${fMoney(t.amount)}</td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        @page { size: 80mm auto; margin: 0; }
        body { width: 74mm; margin: 0 auto; padding: 8px 4px; font-family: 'Courier New', Courier, monospace; font-size: 12px; color: #000; line-height: 1.3; }
        .center { text-align: center; }
        .right { text-align: right; }
        .bold { font-weight: bold; }
        .divider { border-top: 1px dashed #000; margin: 6px 0; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="center">
        <div style="font-size:15px; font-weight:bold;">${bizName}</div>
        <div class="bold">CIERRE / CUADRE DE CAJA</div>
        <div>${nowStr}</div>
        <div>Resp: ${ document.getElementById('user-display')?.innerText || '' }</div>
      </div>
      <div class="divider"></div>
      <table>
        <tr><td>Efectivo Cobrado:</td><td class="right">${fMoney(lastCuadreData.cash)}</td></tr>
        <tr><td>Transferencias:</td><td class="right">${fMoney(lastCuadreData.transfer)}</td></tr>
        <tr><td>Tarjetas:</td><td class="right">${fMoney(lastCuadreData.card)}</td></tr>
        <tr class="bold" style="font-size:13px;"><td style="padding-top:4px;">TOTAL COBRADO:</td><td class="right" style="padding-top:4px;">${fMoney(lastCuadreData.total)}</td></tr>
      </table>
      <div class="divider"></div>
      <div class="bold">ARQUEO DE GAVETA:</div>
      <table>
        <tr><td>Fondo Base:</td><td class="right">${fMoney(base)}</td></tr>
        <tr><td>Efectivo Esperado:</td><td class="right">${fMoney(expected)}</td></tr>
        <tr><td>Efectivo Contado:</td><td class="right">${fMoney(counted)}</td></tr>
        <tr class="bold"><td>Diferencia:</td><td class="right">${fMoney(diff)}</td></tr>
      </table>
      <div class="divider"></div>
      <div class="bold">MOVIMIENTOS DEL DÍA (${lastCuadreData.txs.length}):</div>
      <table>${txRows}</table>
      <div class="divider"></div>
      <div class="center" style="margin-top:18px;">
        ___________________________<br>
        Firma Responsable
      </div>
    </body>
    </html>
  `;
  triggerThermalPrint(html);
}

function shareWhatsApp(id) {
  const d = documents.find(x => x.id === id);
  if(!d) return;
  const cur = d.totals.currency || 'DOP';
  const bizName = settings.name || 'Nuestro Negocio';
  const itemsText = d.items.map(i => {
    const imei = i.barcode ? ` [IMEI: ${i.barcode}]` : '';
    const war = i.warranty ? ` (Garantía: ${i.warranty})` : '';
    return `• ${i.qty}x ${i.name}${imei}${war} (${fMoney(i.price * i.qty, cur)})`;
  }).join('%0A');
  const ncfLine = d.ncf ? `*NCF:* ${d.ncf} (${NCF_LABELS[d.ncfType] || d.ncfType})%0A` : '';
  const paid = getDocPaid(d);
  const bal = getDocBalance(d);
  const balanceBlock = (d.type === 'Factura' && bal > 0.01) 
    ? `*Abonado:* ${fMoney(paid, cur)}%0A*BALANCE PENDIENTE:* *${fMoney(bal, cur)}*%0A` 
    : '';
  
  const msg = `Hola *${d.client.name}*, te compartimos el resumen de tu *${d.type} ${d.num}* de *${bizName}*:%0A%0A` +
    ncfLine +
    `*Fecha:* ${d.date}%0A` +
    (d.type === 'Factura' ? `*Estado:* ${d.status}%0A` : '') +
    `%0A*Equipos / Artículos:*%0A${itemsText}%0A%0A` +
    `*ITBIS:* ${fMoney(d.totals.taxAmt, cur)}%0A` +
    `*TOTAL:* *${fMoney(d.totals.total, cur)}*%0A` +
    balanceBlock +
    `%0A¡Garantía válida con este comprobante! Gracias por tu compra.`;

  let phone = (d.client.phone || '').replace(/\D/g, '');
  if (phone.length === 10 && ['809', '829', '849'].includes(phone.substring(0, 3))) {
    phone = '1' + phone;
  }
  const url = phone ? `https://wa.me/${phone}?text=${msg}` : `https://wa.me/?text=${msg}`;
  window.open(url, '_blank');
}

function renderDocList(type, containerId, searchInputId) {
  const container = document.getElementById(containerId);
  if(!container) return;
  const q = (document.getElementById(searchInputId)?.value || '').toLowerCase();
  const filtered = documents.filter(d => d.type === type && (
    d.client.name.toLowerCase().includes(q) ||
    d.num.toLowerCase().includes(q) ||
    (d.ncf && d.ncf.toLowerCase().includes(q)) ||
    (d.client.rnc && d.client.rnc.toLowerCase().includes(q)) ||
    (Array.isArray(d.items) && d.items.some(it => 
      (it.barcode && it.barcode.toLowerCase().includes(q)) ||
      (it.sku && it.sku.toLowerCase().includes(q))
    ))
  ));

  container.innerHTML = filtered.map(d => {
    const cur = d.totals.currency || 'DOP';
    const bal = getDocBalance(d);
    const paid = getDocPaid(d);
    return `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span class="badge ${d.type.toLowerCase()}">${d.num}</span>
          ${d.ncf ? `<span class="badge ncf">${d.ncf}</span>` : ''}
          ${d.type==='Factura' ? `<select style="width:auto; margin:0; padding:3px 6px; font-size:11px;" onchange="changeStatus('${d.id}', this.value)"><option value="Sin Pagar" ${d.status==='Sin Pagar'?'selected':''}>Sin Pagar</option><option value="Crédito" ${d.status==='Crédito'?'selected':''}>Crédito</option><option value="Pendiente" ${d.status==='Pendiente'?'selected':''}>Pendiente</option><option value="Pagada" ${d.status==='Pagada'?'selected':''}>Pagada</option></select>` : ''}
        </div>
        <div style="text-align:right;">
          <strong style="color:var(--accent); font-size:16px;">${fMoney(d.totals.total, cur)}</strong>
          ${d.type==='Factura' && bal > 0.01 ? `<br><span class="badge pending-bal">Resta: ${fMoney(bal, cur)}</span>` : ''}
        </div>
      </div>
      <div>
        <strong>${d.client.name}</strong> ${d.client.rnc ? `<small style="color:var(--muted);">(${d.client.rnc})</small>` : ''}
        <br><small style="color:var(--muted);">Fecha: ${d.date} ${d.dueDate ? '| Vence: '+d.dueDate : ''} ${d.type==='Factura' && paid > 0 && bal > 0.01 ? `| Abonado: ${fMoney(paid, cur)}` : ''}</small>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:12px;">
        ${d.type==='Factura' ? `<button class="btn btn-abono btn-small" onclick="openAbonoModal('${d.id}')">💵 ${bal > 0.01 ? 'Abonar' : 'Pagos'}</button>` : ''}
        <button class="btn btn-pos btn-small" onclick="printPOS('${d.id}')">🖨️ Ticket 80mm</button>
        <button class="btn btn-outline btn-small" onclick="genPDF('${d.id}')">📄 PDF</button>
        <button class="btn btn-whatsapp btn-small" onclick="shareWhatsApp('${d.id}')">📲 WhatsApp</button>
        <button class="btn btn-outline btn-small" onclick="editDoc('${d.id}')">✏️</button>
        ${currentUserRole === 'Dueño' ? `<button class="btn btn-small" style="background:transparent;border:1px solid var(--danger);color:var(--danger);" onclick="delDoc('${d.id}')">✖</button>` : ''}
      </div>
    </div>`;
  }).join('') || '<p style="color:var(--muted); text-align:center; grid-column: span 2;">No se encontraron documentos.</p>';
}

function renderQuotes() { renderDocList('Cotización', 'quote-list', 'search-quotes'); } 
function renderInvoices() { renderDocList('Factura', 'invoice-list', 'search-invoices'); }

function filterByDate(docsArray) {
  const filter = document.getElementById('dash-filter')?.value || 'month';
  if (filter === 'all') return docsArray; 
  const now = new Date();
  return docsArray.filter(d => {
    const dateObj = d.timestamp ? new Date(d.timestamp) : new Date(d.date); 
    if (isNaN(dateObj)) return true; 
    if (filter === 'today') return dateObj.getDate() === now.getDate() && dateObj.getMonth() === now.getMonth() && dateObj.getFullYear() === now.getFullYear();
    if (filter === 'month') return dateObj.getMonth() === now.getMonth() && dateObj.getFullYear() === now.getFullYear();
    if (filter === 'year') return dateObj.getFullYear() === now.getFullYear(); 
    return true;
  });
}

function renderDashboard() {
  const targetCurrency = document.getElementById('currency').value; 
  const targetRate = exchangeRates[targetCurrency] || 1;
  let fTot = 0, arTot = 0, invCount = 0; 
  const filteredDocs = filterByDate(documents); 
  const filteredReceivables = filterByDate(receivables);

  filteredDocs.forEach(d => { 
    if(d.type === 'Factura') {
      invCount++;
      const docRate = d.totals.exchangeRate || 1; 
      const paidVal = (getDocPaid(d) / docRate) * targetRate;
      const balVal = (getDocBalance(d) / docRate) * targetRate;
      fTot += paidVal; 
      arTot += balVal;
    }
  });
  filteredReceivables.filter(r => r.status === 'Pendiente').forEach(r => arTot += r.amount); 
  
  const lowStockCount = inventory.filter(i => i.stock <= 3).length;

  const invTotEl = document.getElementById('dash-inv-total'), quoTotEl = document.getElementById('dash-quo-total'), docCountEl = document.getElementById('dash-doc-count'), lowStockEl = document.getElementById('dash-low-stock'), invCardsEl = document.getElementById('dash-inv-cards');
  if(invTotEl) invTotEl.innerText = fMoney(fTot); 
  if(quoTotEl) quoTotEl.innerText = fMoney(arTot);
  if(docCountEl) docCountEl.innerText = invCount;
  if(lowStockEl) lowStockEl.innerText = lowStockCount;

  if(invCardsEl) invCardsEl.innerHTML = inventory.map(i => `
    <div class="prod-card">
      ${i.img ? `<img src="${i.img}">` : `<div style="width:100%;height:85px;background:var(--bg);border-radius:8px;margin-bottom:8px;"></div>`}
      <h4>${i.name}</h4>
      <p>
        ${i.barcode ? `<small style="font-size:10px; color:var(--accent);">IMEI: ${i.barcode}</small><br>` : ''}
        ${fMoney(i.price)}<br>
        <span style="color:${i.stock<=3?'var(--danger)':'var(--muted)'}">Stock: ${i.stock}</span>
      </p>
      <div class="btn-group">
        <button class="btn btn-outline" onclick="startFromProd('Cotización', '${i.id}')">Cotizar</button>
        <button class="btn btn-primary" onclick="startFromProd('Factura', '${i.id}')">Facturar</button>
      </div>
    </div>`).join('') || '<p style="font-size:12px; color:var(--muted);">Agrega equipos al inventario para facturación rápida.</p>';
}

function renderAccounting() {
  const targetCurrency = document.getElementById('currency').value; 
  const targetRate = exchangeRates[targetCurrency] || 1;
  let prof = 0, taxes = 0, invNet = 0, ar = 0, ap = 0;
  const filteredDocs = filterByDate(documents); 
  const filteredReceivables = filterByDate(receivables); 
  const filteredPayables = filterByDate(payables);

  filteredDocs.forEach(d => {
    if(d.type === 'Factura') {
      const docRate = d.totals.exchangeRate || 1; 
      const total = d.totals.total || 1;
      const paidRatio = Math.min(1, getDocPaid(d) / total);
      const localProfit = ((d.totals.profit || 0) / docRate) * targetRate; 
      const localTax = ((d.totals.taxAmt || 0) / docRate) * targetRate; 
      const localBal = (getDocBalance(d) / docRate) * targetRate;

      prof += localProfit * paidRatio;
      taxes += localTax * paidRatio;
      ar += localBal;
    }
  });
  filteredReceivables.filter(r => r.status === 'Pendiente').forEach(r => ar += r.amount); 
  filteredPayables.filter(p => p.status === 'Pendiente').forEach(p => ap += p.amount); 
  inventory.forEach(i => invNet += (i.cost * i.stock));
  
  const accProf = document.getElementById('acc-profit'), accTax = document.getElementById('acc-tax'), accInvVal = document.getElementById('acc-inv-value'), accAr = document.getElementById('acc-ar'), accAp = document.getElementById('acc-ap');
  if(accProf) accProf.innerText = fMoney(prof); 
  if(accTax) accTax.innerText = fMoney(taxes); 
  if(accInvVal) accInvVal.innerText = fMoney(invNet); 
  if(accAr) accAr.innerText = fMoney(ar); 
  if(accAp) accAp.innerText = fMoney(ap);
}

function exportSalesCSV() {
  const invs = filterByDate(documents).filter(d => d.type === 'Factura');
  if (invs.length === 0) return showToast("No hay facturas en este periodo para exportar");

  const headers = ['Fecha', 'No. Factura', 'Tipo NCF', 'NCF', 'Cliente', 'RNC / Cedula', 'Estado', 'Moneda', 'Subtotal', 'Descuento', 'ITBIS', 'Total Facturado', 'Monto Cobrado', 'Balance Pendiente'];
  const rows = invs.map(d => [
    d.date,
    d.num,
    d.ncfType || 'Interna',
    d.ncf || 'N/A',
    `"${(d.client.name || '').replace(/"/g, '""')}"`,
    d.client.rnc || '',
    d.status,
    d.totals.currency || 'DOP',
    (d.totals.subtotal || 0).toFixed(2),
    (d.totals.discAmt || 0).toFixed(2),
    (d.totals.taxAmt || 0).toFixed(2),
    (d.totals.total || 0).toFixed(2),
    getDocPaid(d).toFixed(2),
    getDocBalance(d).toFixed(2)
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `Reporte_Ventas_607_${new Date().toISOString().slice(0,10)}.csv`;
  link.click();
  showToast("Reporte descargado (Compatible con Excel)");
}

function handleLogoUpload(e) { 
  const r = new FileReader(); 
  r.onload = evt => { settings.logo = evt.target.result; saveSettings(true); }; 
  r.readAsDataURL(e.target.files[0]); 
}

async function saveSettings(silent=false) { 
  const bizName = document.getElementById('set-biz-name')?.value || '';
  const rnc = document.getElementById('set-biz-id')?.value.trim() || '';
  if (rnc && !isValidDominicanIdOrRNC(rnc)) {
    return showToast("El RNC del negocio no es válido según DGII");
  }

  settings.color = document.getElementById('set-color')?.value || '#111827'; 
  settings.font = document.getElementById('set-font')?.value || 'Helvetica'; 
  settings.tplInv = document.getElementById('set-inv-tpl')?.value || 'modern'; 
  settings.name = bizName; 
  settings.id = rnc; 
  settings.address = document.getElementById('set-biz-address')?.value || ''; 
  await getRef('config').doc('settings').set(settings); 
  if(!silent) showToast("Configuración Nube Guardada"); 
}

function genPDF(id) {
  const d = documents.find(x => x.id === id); 
  if(!d) return; 
  showToast("Generando PDF..."); 
  const cur = d.totals.currency || 'DOP'; 
  const w = document.getElementById('pdf-wrapper'), c = document.getElementById('pdf-container'), h = document.getElementById('pdf-header'); 
  if(!w || !c || !h) return;
  c.style.fontFamily = settings.font || 'Helvetica';

  const pdfType = document.getElementById('pdf-type'), pdfTotalRow = document.getElementById('pdf-total-row'), pdfLogoImg = document.getElementById('pdf-logo-img'), pdfBizName = document.getElementById('pdf-biz-name'), pdfBizMeta = document.getElementById('pdf-biz-meta'), pdfMeta = document.getElementById('pdf-meta'), pdfCliName = document.getElementById('pdf-cli-name'), pdfCliMeta = document.getElementById('pdf-cli-meta'), pdfStatusStamp = document.getElementById('pdf-status-stamp'), pdfTableBody = document.getElementById('pdf-table-body'), pdfSub = document.getElementById('pdf-sub'), pdfDisc = document.getElementById('pdf-disc'), pdfRowDisc = document.getElementById('pdf-row-disc'), pdfTax = document.getElementById('pdf-tax'), pdfRowTax = document.getElementById('pdf-row-tax'), pdfTotal = document.getElementById('pdf-total'), pdfTotalLabel = document.getElementById('pdf-total-label');
  const pdfRowPaid = document.getElementById('pdf-row-paid'), pdfPaid = document.getElementById('pdf-paid'), pdfRowBal = document.getElementById('pdf-row-balance'), pdfBal = document.getElementById('pdf-balance');

  if(settings.tplInv === 'modern') { 
    h.style.background = settings.color || '#111827'; h.style.color = '#fff'; h.style.borderBottom = 'none'; 
    if(pdfType) pdfType.style.color = '#fff'; if(pdfTotalRow) pdfTotalRow.style.color = settings.color || '#111827'; 
  } else { 
    h.style.background = 'transparent'; h.style.color = '#000'; h.style.borderBottom = `4px solid ${settings.color || '#111827'}`; 
    if(pdfType) pdfType.style.color = settings.color || '#111827'; if(pdfTotalRow) pdfTotalRow.style.color = settings.color || '#111827'; 
  }

  if(pdfLogoImg) { pdfLogoImg.src = settings.logo || ''; pdfLogoImg.style.display = settings.logo ? 'block' : 'none'; }
  if(pdfBizName) pdfBizName.innerText = settings.name || ''; 
  if(pdfBizMeta) pdfBizMeta.innerHTML = `${settings.id ? '<strong>RNC:</strong> '+settings.id+'<br>' : ''}${settings.address || ''}`;
  
  const docTitle = d.type === 'Factura' && d.ncfType && NCF_LABELS[d.ncfType] ? NCF_LABELS[d.ncfType] : d.type;
  if(pdfType) pdfType.innerText = docTitle; 
  if(pdfMeta) pdfMeta.innerHTML = `<strong>Nº Interno:</strong> ${d.num}${d.ncf ? `<br><strong>NCF:</strong> ${d.ncf}` : ''}<br><strong>Fecha:</strong> ${d.date}${d.dueDate?'<br><strong>Vence:</strong> '+d.dueDate:''}${d.paymentMethod ? '<br><strong>Condición:</strong> '+d.paymentMethod : ''}`;
  
  if(pdfCliName) pdfCliName.innerText = d.client.name; 
  if(pdfCliMeta) pdfCliMeta.innerHTML = `${d.client.rnc?'<strong>RNC/Cédula:</strong> '+d.client.rnc+'<br>':''}${d.client.phone ? 'Tel: '+d.client.phone+'<br>' : ''}${d.client.email || ''}`;
  
  const bal = getDocBalance(d);
  const paid = getDocPaid(d);
  if(pdfStatusStamp) { 
    if(d.type==='Factura' && d.status==='Pagada') pdfStatusStamp.innerHTML = '<h2 style="color:#22c55e;border:4px solid #22c55e;padding:8px 14px;transform:rotate(-12deg);display:inline-block;border-radius:6px;">PAGADA</h2>'; 
    else if(d.type==='Factura' && bal > 0.01) pdfStatusStamp.innerHTML = '<h2 style="color:#d97706;border:4px solid #d97706;padding:8px 14px;transform:rotate(-12deg);display:inline-block;border-radius:6px;">PENDIENTE</h2>';
    else pdfStatusStamp.innerHTML = ''; 
  }
  
  let table = d.items.map(i => {
    const imeiLine = (i.barcode || i.sku) ? `<br><small style="color:#4b5563; font-size:11px;">${i.sku ? 'Serie: <strong>'+i.sku+'</strong> | ' : ''}${i.barcode ? 'IMEI: <strong>'+i.barcode+'</strong> | ' : ''}Garantía: ${i.warranty || '30 Días'}</small>` : '';
    return `<tr>
      <td><strong>${i.name}</strong>${imeiLine}</td>
      <td style="text-align:center;">${i.qty}</td>
      <td style="text-align:right;">${fMoney(i.price, cur)}</td>
      <td style="text-align:right;">${fMoney(i.price * i.qty, cur)}</td>
    </tr>`;
  }).join('');

  if(d.totals.labor > 0) table += `<tr><td>Servicios / Mano de Obra</td><td style="text-align:center;">1</td><td style="text-align:right;">${fMoney(d.totals.labor, cur)}</td><td style="text-align:right;">${fMoney(d.totals.labor, cur)}</td></tr>`;
  if(pdfTableBody) pdfTableBody.innerHTML = table;
  
  if(pdfSub) pdfSub.innerText = fMoney(d.totals.subtotal, cur); 
  if(pdfDisc) pdfDisc.innerText = `-${fMoney(d.totals.discAmt, cur)}`; 
  if(pdfRowDisc) pdfRowDisc.style.display = d.totals.discAmt>0?'flex':'none'; 
  if(pdfTax) pdfTax.innerText = `+${fMoney(d.totals.taxAmt, cur)}`; 
  if(pdfRowTax) pdfRowTax.style.display = d.totals.taxAmt>0?'flex':'none'; 
  if(pdfTotal) pdfTotal.innerText = fMoney(d.totals.total, cur); 
  if(pdfTotalLabel) pdfTotalLabel.innerText = d.type==='Factura'?'Total Facturado:':'Total Cotizado:';

  if(d.type === 'Factura' && bal > 0.01) {
    if(pdfRowPaid) pdfRowPaid.style.display = 'flex';
    if(pdfPaid) pdfPaid.innerText = fMoney(paid, cur);
    if(pdfRowBal) pdfRowBal.style.display = 'flex';
    if(pdfBal) pdfBal.innerText = fMoney(bal, cur);
  } else {
    if(pdfRowPaid) pdfRowPaid.style.display = 'none';
    if(pdfRowBal) pdfRowBal.style.display = 'none';
  }
  
  w.style.display = 'block'; 
  html2pdf().set({ 
    margin: 0, 
    filename: `${d.num}${d.ncf ? '_' + d.ncf : ''}.pdf`, 
    image: {type:'jpeg', quality:1}, 
    html2canvas: {scale:2}, 
    jsPDF: {unit:'in', format:'letter', orientation:'portrait'} 
  }).from(c).save().then(() => { 
    w.style.display = 'none'; 
    showToast("¡PDF Descargado!"); 
  });
}

function toggleSlideMode(containerId, btn) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const isVertical = el.classList.contains('slide-y');
  if (isVertical) {
    el.classList.remove('slide-y');
    el.classList.add('slide-x');
    if (btn) btn.innerText = '↕️ Slide Vertical';
  } else {
    el.classList.remove('slide-x');
    el.classList.add('slide-y');
    if (btn) btn.innerText = '↔️ Slide Horizontal';
  }
}
