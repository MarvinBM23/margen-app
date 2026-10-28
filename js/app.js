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
let currentItems = [], docTotals = {}, editDocId = null, editInvId = null, activePaymentDocId = null, currentUser = null, currentBusinessId = null, currentUserRole = 'Cajero';
let exchangeRates = { USD: 1, DOP: 58.5, EUR: 0.92 };
let isRegistering = false;

const NCF_LABELS = {
  'B01': 'Factura de Crédito Fiscal',
  'B02': 'Factura de Consumo',
  'B14': 'Comprobante Régimen Especial',
  'B15': 'Comprobante Gubernamental',
  'Interna': 'Factura Comercial'
};

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
    if(greetEl) greetEl.innerText = `${saludo},${pData.name} 👋`;
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
              <div><strong>${member.name}</strong><br><small>${member.role}</small></div>${member.id !== currentUser.uid && currentUserRole === 'Dueño' ? `<select style="width:auto; margin:0; font-size:12px; padding:4px 8px;" onchange="changeRole('${member.id}', this.value)"><option value="Cajero" ${member.role==='Cajero'?'selected':''}>Cajero</option><option value="Administrador" ${member.role==='Administrador'?'selected':''}>Admin</option></select>` : ''}
            </div>
