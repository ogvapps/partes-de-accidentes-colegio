import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";
import { getFirestore, collection, onSnapshot, addDoc, doc, deleteDoc, query, serverTimestamp, updateDoc, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInAnonymously, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// --- PWA & Service Worker ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('SW registered'))
            .catch(err => console.log('SW failed', err));
    });
}

// --- Configuración ---
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBigd4Zzpcxmsh8XWdxzbOr2_6acgml6CE",
    authDomain: "partes-de-accidentes-colegio.firebaseapp.com",
    projectId: "partes-de-accidentes-colegio",
    storageBucket: "partes-de-accidentes-colegio.appspot.com",
    messagingSenderId: "1082690821005",
    appId: "1:1082690821005:web:2da50857a50a6884617bc4",
    measurementId: "G-DLKJK30RMH"
};

const APP_CONFIG = {
    ENTRY_PIN: '1234',
    ADMIN_PIN: '2025',
    DEFAULT_SCHOOL: 'Colegio Madre Matilde',
    DEFAULT_YEAR: '2025-2026',
    COORDINATOR_NAME: 'Orestes González Villanueva'
};

// --- Utilidad de Cálculo de Curso Escolar (Septiembre a Agosto) ---
const getSchoolYear = (dateStr) => {
    let d;
    if (dateStr) {
        const parts = String(dateStr).split('T')[0].split('-');
        if (parts.length === 3) {
            d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        } else {
            d = new Date(dateStr);
        }
    } else {
        d = new Date();
    }
    if (isNaN(d.getTime())) d = new Date();
    const year = d.getFullYear();
    const month = d.getMonth() + 1; // 1-12
    // Calendario escolar en España:
    // Mes 9 a 12 (septiembre a diciembre) -> YYYY-(YYYY+1)
    // Mes 1 a 8 (enero a agosto) -> (YYYY-1)-YYYY
    return month >= 9 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
};

// --- Estado Global ---
let db, auth;
let reportsCollection;
let allLoadedReports = [];
let currentPendingReports = [];
let currentFinishedReports = [];
let currentSchoolYearFilter = 'all';
let currentStatsYearFilter = 'all';
let currentMemoryYearFilter = '';
let currentFinishedSearchQuery = '';
let intervenerPads = [];
let signaturePadCoordinator;
let isAdminUnlocked = false;
let reportViewSource = 'pending';

// --- Inicialización ---
const initApp = async () => {
    try {
        // Cargar respaldo offline de partes si existe
        try {
            const cached = localStorage.getItem('cachedReports');
            if (cached) {
                allLoadedReports = JSON.parse(cached);
                currentPendingReports = allLoadedReports.filter(r => r.status === 'pending');
                currentFinishedReports = allLoadedReports.filter(r => r.status !== 'pending');
            }
        } catch (err) {
            console.warn("No se pudo leer la caché local:", err);
        }

        const app = initializeApp(FIREBASE_CONFIG);
        getAnalytics(app);
        db = getFirestore(app);
        auth = getAuth(app);
        reportsCollection = collection(db, "finishedReports");

        setupEventListeners();
        loadLocalSettings();
        updateSchoolYearSelectors();
        renderLists();
        App.updateStats();
        console.log("Sistema inicializado correctamente.");
    } catch (e) {
        console.error("Error inicializando la App:", e);
        showToast("Error crítico al conectar con el servidor.", true);
    }
};

// --- Utilidades ---
const showToast = (message, isError = false) => {
    const toast = document.getElementById('toast-notification');
    const toastMsg = document.getElementById('toast-message');
    toastMsg.textContent = message;

    toast.className = `fixed top-5 right-5 text-white px-6 py-3 rounded-xl shadow-2xl transition-all duration-500 z-50 flex items-center gap-2 ${isError ? 'bg-red-500' : 'bg-emerald-500'}`;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(0)';

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
    }, 3500);
};

const switchView = (targetId) => {
    document.querySelectorAll('.app-view').forEach(view => view.classList.add('hidden'));
    const target = document.getElementById(targetId);
    if (target) target.classList.remove('hidden');

    document.querySelectorAll('.nav-button').forEach(btn => {
        btn.setAttribute('data-active', btn.dataset.target === targetId);
    });
    window.scrollTo(0, 0);
};

// --- Lógica de Negocio ---
const handleAuth = async (pin) => {
    if (pin === APP_CONFIG.ENTRY_PIN) {
        document.getElementById('entry-pin-modal-overlay').classList.add('hidden');
        document.getElementById('google-auth-modal-overlay').classList.remove('hidden');
    } else {
        showToast("PIN incorrecto.", true);
    }
};

const handleGoogleAuth = async () => {
    const btn = document.getElementById('google-auth-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="animate-spin inline-block mr-2">⏳</span>Autenticando...';

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({
        hd: 'educarex.es' // Hint to choose educarex accounts
    });

    try {
        const result = await signInWithPopup(auth, provider);
        const email = result.user.email;

        if (email.endsWith('@educarex.es')) {
            document.getElementById('google-auth-modal-overlay').classList.add('hidden');
            document.getElementById('main-app').classList.remove('hidden');
            startFirestoreListener();
            initSignaturePads();
            showToast(`Bienvenido, ${result.user.displayName}`);
        } else {
            await auth.signOut();
            showToast("Solo se permiten cuentas @educarex.es", true);
        }
    } catch (error) {
        console.error("Auth Error:", error);
        showToast("Error de autenticación con Google.", true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Autenticar con Google';
    }
};

const getAvailableSchoolYears = () => {
    const years = new Set();
    const currentYear = localStorage.getItem('schoolYear') || APP_CONFIG.DEFAULT_YEAR || getSchoolYear();
    years.add(currentYear);
    years.add(getSchoolYear());

    allLoadedReports.forEach(r => {
        if (r.schoolYear) years.add(r.schoolYear);
        else if (r.date) years.add(getSchoolYear(r.date));
    });

    return Array.from(years).sort().reverse();
};

const updateSchoolYearSelectors = () => {
    const years = getAvailableSchoolYears();
    const currentYear = localStorage.getItem('schoolYear') || APP_CONFIG.DEFAULT_YEAR || getSchoolYear();

    // 1. Selector en Archivo Histórico
    const finishedSelect = document.getElementById('filter-finished-year');
    if (finishedSelect) {
        const prevVal = finishedSelect.value || currentSchoolYearFilter;
        finishedSelect.innerHTML = `<option value="all">Todos los cursos (${allLoadedReports.filter(r => r.status !== 'pending').length})</option>` +
            years.map(y => {
                const count = allLoadedReports.filter(r => r.status !== 'pending' && (r.schoolYear === y || (!r.schoolYear && getSchoolYear(r.date) === y))).length;
                return `<option value="${y}">Curso ${y} (${count})</option>`;
            }).join('');
        if (prevVal && (prevVal === 'all' || years.includes(prevVal))) {
            finishedSelect.value = prevVal;
            currentSchoolYearFilter = prevVal;
        }
    }

    // 2. Selector en Estadísticas
    const statsSelect = document.getElementById('filter-stats-year');
    if (statsSelect) {
        const prevVal = statsSelect.value || currentStatsYearFilter;
        statsSelect.innerHTML = `<option value="all">Todos los cursos</option>` +
            years.map(y => `<option value="${y}">Curso ${y}</option>`).join('');
        if (prevVal && (prevVal === 'all' || years.includes(prevVal))) {
            statsSelect.value = prevVal;
            currentStatsYearFilter = prevVal;
        }
    }

    // 3. Selector en Memoria Anual
    const memorySelect = document.getElementById('filter-memory-year');
    if (memorySelect) {
        const prevVal = memorySelect.value || currentMemoryYearFilter || currentYear;
        memorySelect.innerHTML = years.map(y => `<option value="${y}">Curso ${y}</option>`).join('');
        if (prevVal && years.includes(prevVal)) {
            memorySelect.value = prevVal;
            currentMemoryYearFilter = prevVal;
        } else if (years.length) {
            memorySelect.value = years[0];
            currentMemoryYearFilter = years[0];
        }
    }
};

const startFirestoreListener = () => {
    onSnapshot(query(reportsCollection), (snapshot) => {
        const all = snapshot.docs.map(d => {
            const data = d.data();
            const sy = data.schoolYear || getSchoolYear(data.date || (data.createdAt ? new Date(data.createdAt.toMillis()).toISOString().split('T')[0] : null));
            return { id: d.id, ...data, schoolYear: sy };
        });

        allLoadedReports = all;
        // Respaldo local de partes para disponibilidad continua
        try {
            localStorage.setItem('cachedReports', JSON.stringify(all));
        } catch (e) {
            console.warn("No se pudo guardar respaldo en localStorage:", e);
        }

        currentPendingReports = all.filter(r => r.status === 'pending')
            .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

        currentFinishedReports = all.filter(r => r.status !== 'pending')
            .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

        updateSchoolYearSelectors();
        renderLists();
        updateCounters();
        App.updateStats();
    });
};

const sendGravityAlert = (data) => {
    if (data.severity !== 'Grave') return;

    // Configuración EmailJS (Requiere ServiceID y TemplateID reales)
    const templateParams = {
        to_name: "Coordinador de Salud",
        student_name: data.fullName,
        location: data.location,
        description: data.description,
        time: data.time
    };

    console.log("Enviando alerta de gravedad por email...");
};

const renderLists = () => {
    // 1. Lista de Pendientes
    const pendingContainer = document.getElementById('pending-list');
    pendingContainer.innerHTML = currentPendingReports.length ? '' : `<div class="text-center py-12 text-slate-400">No hay partes pendientes de firma.</div>`;
    currentPendingReports.forEach(report => {
        const date = report.createdAt ? new Date(report.createdAt.toMillis()).toLocaleDateString() : (report.date || '---');
        const card = document.createElement('div');
        card.className = 'p-4 bg-white border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition-all flex flex-col md:flex-row justify-between items-center gap-4';
        card.innerHTML = `
            <div class="flex-grow">
                <div class="flex items-center gap-2">
                    <h3 class="font-bold text-slate-800">${report.fullName}</h3>
                    <span class="px-2 py-0.5 text-[10px] font-bold bg-amber-50 text-amber-600 rounded-md">Pendiente</span>
                </div>
                <p class="text-sm text-slate-500">${report.course} • ${report.location} • ${date}</p>
            </div>
            <div class="flex gap-2 shrink-0">
                <button onclick="App.reviewReport('${report.id}')" class="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg font-semibold hover:bg-blue-600 hover:text-white transition-colors">Firmar</button>
                <button onclick="App.editReport('${report.id}', 'pending')" class="p-2 text-amber-600 bg-amber-50 rounded-lg hover:bg-amber-100"><svg class="w-5 h-5"><use xlink:href="#icon-pencil"></use></svg></button>
                <button onclick="App.confirmDelete('${report.id}')" class="p-2 text-red-600 bg-red-50 rounded-lg hover:bg-red-100"><svg class="w-5 h-5"><use xlink:href="#icon-trash"></use></svg></button>
            </div>
        `;
        pendingContainer.appendChild(card);
    });

    // 2. Lista de Archivados (con filtro por curso escolar y búsqueda)
    const finishedContainer = document.getElementById('finished-list');
    let filteredFinished = currentFinishedReports;

    if (currentSchoolYearFilter && currentSchoolYearFilter !== 'all') {
        filteredFinished = filteredFinished.filter(r => (r.schoolYear || getSchoolYear(r.date)) === currentSchoolYearFilter);
    }

    if (currentFinishedSearchQuery) {
        const q = currentFinishedSearchQuery.toLowerCase().trim();
        filteredFinished = filteredFinished.filter(r =>
            (r.fullName && r.fullName.toLowerCase().includes(q)) ||
            (r.course && r.course.toLowerCase().includes(q)) ||
            (r.location && r.location.toLowerCase().includes(q)) ||
            (r.description && r.description.toLowerCase().includes(q))
        );
    }

    const countSummaryEl = document.getElementById('finished-count-summary');
    if (countSummaryEl) {
        if (currentSchoolYearFilter === 'all') {
            countSummaryEl.textContent = `Mostrando ${filteredFinished.length} partes archivados en total`;
        } else {
            countSummaryEl.textContent = `Mostrando ${filteredFinished.length} partes del Curso ${currentSchoolYearFilter} (de ${currentFinishedReports.length} totales)`;
        }
    }

    finishedContainer.innerHTML = filteredFinished.length ? '' : `<div class="text-center py-12 text-slate-400 bg-white rounded-2xl border border-slate-100">No hay partes archivados para el curso seleccionado o la búsqueda indicada.</div>`;
    filteredFinished.forEach(report => {
        const date = report.date ? new Date(report.date).toLocaleDateString() : (report.createdAt ? new Date(report.createdAt.toMillis()).toLocaleDateString() : '---');
        const reportYear = report.schoolYear || getSchoolYear(report.date);
        const card = document.createElement('div');
        card.className = 'p-4 bg-white border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition-all flex flex-col md:flex-row justify-between items-center gap-4';
        card.innerHTML = `
            <div class="flex-grow">
                <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="font-bold text-slate-800">${report.fullName}</h3>
                    <span class="px-2 py-0.5 text-[10px] font-bold bg-blue-50 text-blue-600 rounded-md">Curso ${reportYear}</span>
                    <span class="px-2 py-0.5 text-[10px] font-bold ${report.severity === 'Grave' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'} rounded-md">${report.severity}</span>
                </div>
                <p class="text-sm text-slate-500 mt-1">${report.course} • ${report.location} • ${date} ${report.time ? `(${report.time})` : ''}</p>
            </div>
            <div class="flex gap-2 shrink-0">
                <button onclick="App.viewReport('${report.id}')" class="px-4 py-2 bg-slate-50 text-slate-600 rounded-lg font-semibold hover:bg-slate-600 hover:text-white transition-colors">Ver</button>
                <button onclick="App.editReport('${report.id}', 'finished')" class="p-2 text-amber-600 bg-amber-50 rounded-lg hover:bg-amber-100"><svg class="w-5 h-5"><use xlink:href="#icon-pencil"></use></svg></button>
                <button onclick="App.confirmDelete('${report.id}')" class="p-2 text-red-600 bg-red-50 rounded-lg hover:bg-red-100"><svg class="w-5 h-5"><use xlink:href="#icon-trash"></use></svg></button>
            </div>
        `;
        finishedContainer.appendChild(card);
    });
};

const updateCounters = () => {
    const countEl = document.getElementById('pending-count');
    countEl.textContent = currentPendingReports.length;
    countEl.classList.toggle('hidden', currentPendingReports.length === 0);
};

// --- Firma y Formulario ---
const initSignaturePads = () => {
    const canvas = document.getElementById('signature-pad-coordinator');
    signaturePadCoordinator = new SignaturePad(canvas);

    const resizeCanvas = () => {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext("2d").scale(ratio, ratio);
        signaturePadCoordinator.clear();
    };

    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
    addIntervenerBlock();
};

const addIntervenerBlock = (name = '', signature = null, isRemovable = false) => {
    const container = document.getElementById('interveners-container');
    const index = container.children.length;
    const block = document.createElement('div');
    block.className = 'intervener-block group p-4 bg-slate-50 rounded-xl border border-slate-200 hover:border-blue-200 transition-all';
    block.innerHTML = `
        <div class="flex justify-between items-center mb-4">
            <span class="text-xs font-bold uppercase tracking-wider text-slate-400">Interviniente ${index + 1}</span>
            ${isRemovable ? `<button type="button" class="text-red-400 hover:text-red-600" onclick="this.parentElement.parentElement.remove()">Eliminar</button>` : ''}
        </div>
        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">Nombre Completo</label>
                <input type="text" name="intervenerName" value="${name}" class="w-full p-3 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-100 outline-none" required>
            </div>
            <div>
                <label class="block text-sm font-medium text-slate-600 mb-1">Firma</label>
                <canvas class="signature-canvas w-full h-32 rounded-lg"></canvas>
                <div class="flex justify-between items-center mt-1">
                    <button type="button" class="text-xs text-blue-500 hover:underline underline-offset-4" onclick="App.clearSignature(this)">Limpiar firma</button>
                    <div class="signature-hint">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                        Usa el móvil en horizontal para firmar mejor
                    </div>
                </div>
            </div>
        </div>
    `;
    container.appendChild(block);
    const canvas = block.querySelector('.signature-canvas');
    const pad = new SignaturePad(canvas);
    intervenerPads.push(pad);

    if (signature) setTimeout(() => pad.fromDataURL(signature), 50);
};

// --- Exportación de objeto global para eventos inline ---
window.App = {
    init: initApp,
    handleAuth,
    switchView,
    addIntervener: () => addIntervenerBlock('', null, true),
    clearSignature: (btn) => {
        const canvas = btn.parentElement.querySelector('canvas');
        const pad = intervenerPads.find(p => p._canvas === canvas) || signaturePadCoordinator;
        if (pad) pad.clear();
    },
    reviewReport: (id) => {
        const report = currentPendingReports.find(r => r.id === id);
        if (!report) return;
        fillForm(report);
        document.getElementById('form-title').textContent = 'Finalizar Parte';
        document.getElementById('submit-btn').textContent = 'Confirmar y Archivar';
        document.getElementById('editingReportId').value = id;
        document.getElementById('editingReportId').dataset.mode = 'finalize';
        switchView('form-container');
    },
    editReport: (id, status) => {
        const list = status === 'pending' ? currentPendingReports : currentFinishedReports;
        const report = list.find(r => r.id === id);
        if (!report) return;
        fillForm(report);
        document.getElementById('form-title').textContent = 'Editar Parte';
        document.getElementById('submit-btn').textContent = 'Guardar Cambios';
        document.getElementById('editingReportId').value = id;
        document.getElementById('editingReportId').dataset.mode = 'edit';
        document.getElementById('editingReportId').dataset.status = status;
        switchView('form-container');
    },
    viewReport: (id) => {
        const report = currentFinishedReports.find(r => r.id === id);
        if (!report) return;
        App.currentReportId = id;
        App.currentReportData = report;
        renderFinalReport(report);
        reportViewSource = 'finished';
        switchView('report-view');
    },
    generateAnnualMemory: () => {
        const year = currentMemoryYearFilter || document.getElementById('filter-memory-year')?.value || localStorage.getItem('schoolYear') || getSchoolYear();
        const schoolName = localStorage.getItem('schoolName') || APP_CONFIG.DEFAULT_SCHOOL;
        const reportsForYear = currentFinishedReports.filter(r => (r.schoolYear || getSchoolYear(r.date)) === year);
        const total = reportsForYear.length;
        const graves = reportsForYear.filter(r => r.severity === 'Grave').length;
        const leves = reportsForYear.filter(r => r.severity !== 'Grave').length;
        const avisos112 = reportsForYear.filter(r => r.emergencyCalled === 'Sí').length;
        const avisosFamilia = reportsForYear.filter(r => r.parentsCalled === 'Sí').length;

        // Distribución por ubicación
        const locMap = {};
        reportsForYear.forEach(r => locMap[r.location] = (locMap[r.location] || 0) + 1);
        const locLines = Object.entries(locMap)
            .sort((a, b) => b[1] - a[1])
            .map(([loc, cnt]) => `  - ${loc}: ${cnt} (${Math.round((cnt / (total || 1)) * 100)}%)`).join('\n');

        // Distribución por curso
        const courseMap = {};
        reportsForYear.forEach(r => courseMap[r.course] = (courseMap[r.course] || 0) + 1);
        const courseLines = Object.entries(courseMap)
            .sort((a, b) => b[1] - a[1])
            .map(([c, cnt]) => `  - ${c}: ${cnt} (${Math.round((cnt / (total || 1)) * 100)}%)`).join('\n');

        const text = `===========================================================\n` +
            `MEMORIA ANUAL DE ACCIDENTES Y SALUD ESCOLAR\n` +
            `CURSO ESCOLAR: ${year}\n` +
            `CENTRO: ${schoolName}\n` +
            `COORDINADOR: ${APP_CONFIG.COORDINATOR_NAME}\n` +
            `FECHA DE GENERACIÓN: ${new Date().toLocaleDateString('es-ES')}\n` +
            `===========================================================\n\n` +
            `1. RESUMEN CUANTITATIVO:\n` +
            `------------------------\n` +
            `Total de partes registrados y archivados: ${total}\n` +
            `Incidencias Leves: ${leves} (${total ? Math.round((leves / total) * 100) : 0}%)\n` +
            `Incidencias Graves: ${graves} (${total ? Math.round((graves / total) * 100) : 0}%)\n` +
            `Activaciones de Urgencias / 112: ${avisos112}\n` +
            `Comunicaciones a las Familias: ${avisosFamilia}\n\n` +
            `2. DISTRIBUCIÓN POR UBICACIÓN:\n` +
            `-----------------------------\n` +
            `${locLines || '  Sin datos registrados para este curso.'}\n\n` +
            `3. DISTRIBUCIÓN POR NIVELES Y CURSOS:\n` +
            `------------------------------------\n` +
            `${courseLines || '  Sin datos registrados para este curso.'}\n\n` +
            `4. VALORACIÓN CUALITATIVA Y PROPUESTAS DE MEJORA:\n` +
            `-------------------------------------------------\n` +
            `Durante el curso escolar ${year}, se ha seguido rigurosamente el protocolo oficial de comunicación y atención ante accidentes en el centro.\n` +
            `Todos los expedientes han sido debidamente ratificados y archivados con las firmas correspondientes.\n\n` +
            `Propuestas preventivas recomendadas para el próximo curso:\n` +
            `- Refuerzo en la supervisión de las zonas y horarios de mayor concentración de incidencias.\n` +
            `- Revisión periódica de elementos de seguridad en patios e instalaciones deportivas.\n` +
            `- Actualización continuada del botiquín del centro y formación preventiva del profesorado.`;

        const textarea = document.getElementById('mem-full-report');
        if (textarea) textarea.value = text;
        switchView('memory-container');
    },
    copyMemoryToClipboard: () => {
        const text = document.getElementById('mem-full-report')?.value;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            showToast("Memoria copiada al portapapeles.");
        }).catch(() => {
            showToast("Error al copiar texto.", true);
        });
    },
    onFinishedYearChange: (year) => {
        currentSchoolYearFilter = year;
        renderLists();
    },
    onFinishedSearch: (query) => {
        currentFinishedSearchQuery = query;
        renderLists();
    },
    onStatsYearChange: (year) => {
        currentStatsYearFilter = year;
        App.updateStats();
    },
    onMemoryYearChange: (year) => {
        currentMemoryYearFilter = year;
        App.generateAnnualMemory();
    },
    saveSettings: () => {
        const newName = document.getElementById('setting-school-name').value;
        const newYear = document.getElementById('setting-school-year').value;
        if (newName) localStorage.setItem('schoolName', newName);
        if (newYear) localStorage.setItem('schoolYear', newYear);
        loadLocalSettings();
        updateSchoolYearSelectors();
        showToast("Ajustes actualizados localmente.");
    },
    updateStats: () => {
        let data = [...currentPendingReports, ...currentFinishedReports];
        if (currentStatsYearFilter && currentStatsYearFilter !== 'all') {
            data = data.filter(r => (r.schoolYear || getSchoolYear(r.date)) === currentStatsYearFilter);
        }

        const subtitle = document.getElementById('stats-subtitle');
        if (subtitle) {
            subtitle.textContent = currentStatsYearFilter === 'all' 
                ? 'Estadísticas globales (Todos los cursos)' 
                : `Estadísticas del Curso Escolar ${currentStatsYearFilter}`;
        }

        const total = data.length;
        document.getElementById('stat-total').textContent = total;
        if (total === 0) {
            document.getElementById('stat-grave').textContent = '0';
            document.getElementById('stat-grave-pct').textContent = '0% del total';
            document.getElementById('stat-location').textContent = '---';
            document.getElementById('stats-location-bars').innerHTML = '<div class="text-slate-400 text-xs text-center py-4">No hay datos en este curso</div>';
            document.getElementById('stats-course-bars').innerHTML = '<div class="text-slate-400 text-xs text-center py-4">No hay datos en este curso</div>';
            return;
        }

        const graves = data.filter(r => r.severity === 'Grave').length;
        document.getElementById('stat-grave').textContent = graves;
        document.getElementById('stat-grave-pct').textContent = `${Math.round((graves / total) * 100)}% del total`;

        // Ubicaciones
        const locMap = {};
        data.forEach(r => locMap[r.location] = (locMap[r.location] || 0) + 1);
        const topLoc = Object.entries(locMap).sort((a, b) => b[1] - a[1])[0];
        document.getElementById('stat-location').textContent = topLoc ? topLoc[0] : '---';

        // Barras Ubicación
        const locBars = document.getElementById('stats-location-bars');
        locBars.innerHTML = Object.entries(locMap).map(([loc, count]) => {
            const pct = (count / total) * 100;
            return `
                <div class="space-y-1">
                    <div class="flex justify-between text-xs font-bold text-slate-600">
                        <span>${loc}</span><span>${count}</span>
                    </div>
                    <div class="h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div class="h-full bg-blue-500 transition-all duration-1000" style="width: ${pct}%"></div>
                    </div>
                </div>
            `;
        }).join('');

        // Barras Cursos
        const courseMap = {};
        data.forEach(r => courseMap[r.course] = (courseMap[r.course] || 0) + 1);
        const courseBars = document.getElementById('stats-course-bars');
        courseBars.innerHTML = Object.entries(courseMap).map(([course, count]) => {
            const pct = (count / total) * 100;
            return `
                <div class="space-y-1">
                    <div class="flex justify-between text-xs font-bold text-slate-600">
                        <span>${course}</span><span>${count}</span>
                    </div>
                    <div class="h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div class="h-full bg-indigo-500 transition-all duration-1000" style="width: ${pct}%"></div>
                    </div>
                </div>
            `;
        }).join('');
    },
    confirmDelete: (id) => {
        const modal = document.getElementById('confirm-delete-modal-overlay');
        modal.classList.remove('hidden');
        document.getElementById('confirm-delete-confirm-btn').onclick = async () => {
            await deleteDoc(doc(db, "finishedReports", id));
            modal.classList.add('hidden');
            showToast("Parte eliminado.");
        };
    },
    exportToExcel: (singleReport = null) => {
        let data;
        if (singleReport) {
            data = [singleReport];
        } else {
            data = currentFinishedReports;
            if (currentSchoolYearFilter && currentSchoolYearFilter !== 'all') {
                data = data.filter(r => (r.schoolYear || getSchoolYear(r.date)) === currentSchoolYearFilter);
            }
        }
        if (!data.length) return showToast("No hay datos para exportar", true);

        // Definición de columnas Pro con Curso Escolar incluido
        const headers = ["ID", "Curso Escolar", "Fecha", "Hora", "Alumno", "Curso", "Ubicación", "Gravedad", "Descripción", "Actuaciones", "Aviso Familia", "Aviso 112", "Estado"];

        // Función para limpiar y escapar texto para Excel (CSV con punto y coma)
        const clean = (val) => {
            if (val === undefined || val === null) return "";
            let str = String(val).replace(/"/g, '""'); // Escapar comillas
            str = str.replace(/\r?\n|\r/g, " "); // Eliminar saltos de línea para Excel
            return `"${str}"`;
        };

        const rows = data.map(r => [
            clean(r.id),
            clean(r.schoolYear || getSchoolYear(r.date)),
            clean(r.date),
            clean(r.time),
            clean(r.fullName),
            clean(r.course),
            clean(r.location),
            clean(r.severity),
            clean(r.description),
            clean(r.actionTaken),
            clean(r.parentsCalled),
            clean(r.emergencyCalled),
            clean(r.status === 'pending' ? 'PENDIENTE' : 'FINALIZADO')
        ]);

        const csvContent = "\uFEFF" + [headers, ...rows].map(e => e.join(";")).join("\n");
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        const fileNameYear = currentSchoolYearFilter !== 'all' ? currentSchoolYearFilter : 'TODOS_LOS_CURSOS';
        link.download = singleReport ? `parte_${singleReport.fullName.replace(/ /g, '_')}.csv` : `ACCIDENTES_${fileNameYear}.csv`;
        link.click();
        showToast("Excel generado correctamente.");
    },
    exportPdf: async (reportId) => {
        const report = [...currentPendingReports, ...currentFinishedReports].find(r => r.id === reportId);
        if (!report) return;

        const btn = document.querySelector('button[onclick*="exportPdf"]');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = "Generando...";

        try {
            const container = document.getElementById('report-view');

            const clone = container.cloneNode(true);
            clone.style.position = 'fixed';
            clone.style.left = '-9999px';
            clone.style.top = '0';
            clone.style.background = 'white';
            clone.classList.remove('hidden');
            document.body.appendChild(clone);

            await Promise.all(Array.from(clone.querySelectorAll('img')).map(img => {
                if (img.complete) return Promise.resolve();
                return new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
            }));

            const mainCanvas = await html2canvas(clone.querySelector('.report-page'), {
                scale: 2,
                useCORS: true,
                backgroundColor: '#ffffff'
            });

            const pdf = new jspdf.jsPDF('p', 'mm', 'a4');
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();

            const pxToMm = pageWidth / mainCanvas.width;
            const pxPageHeight = pageHeight / pxToMm;

            let currentFullHeight = 0;

            while (currentFullHeight < mainCanvas.height) {
                const pageCanvas = document.createElement('canvas');
                pageCanvas.width = mainCanvas.width;
                pageCanvas.height = Math.min(pxPageHeight, mainCanvas.height - currentFullHeight);

                const ctx = pageCanvas.getContext('2d');
                ctx.drawImage(mainCanvas, 0, currentFullHeight, mainCanvas.width, pageCanvas.height, 0, 0, pageCanvas.width, pageCanvas.height);

                const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.95);
                pdf.addImage(pageImgData, 'JPEG', 0, 0, pageWidth, (pageCanvas.height * pxToMm));

                currentFullHeight += pxPageHeight;
                if (currentFullHeight < mainCanvas.height) pdf.addPage();
            }

            pdf.save(`Expediente_${report.fullName.replace(/ /g, '_')}.pdf`);
            document.body.removeChild(clone);
            showToast("PDF generado correctamente.");
        } catch (err) {
            console.error(err);
            showToast("Error en PDF", true);
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    },
    exportBulkPdf: async () => {
        let data = currentFinishedReports;
        if (currentSchoolYearFilter && currentSchoolYearFilter !== 'all') {
            data = data.filter(r => (r.schoolYear || getSchoolYear(r.date)) === currentSchoolYearFilter);
        }
        if (!data.length) return showToast("No hay informes para exportar en este curso", true);

        const btn = document.getElementById('bulk-pdf-btn');
        btn.disabled = true;
        const originalContent = btn.innerHTML;

        try {
            showToast("Generando archivo masivo. No cierres la página...");
            const pdf = new jspdf.jsPDF('p', 'mm', 'a4');
            const container = document.getElementById('report-view');
            const clone = container.cloneNode(true);
            clone.style.position = 'fixed';
            clone.style.left = '-9999px';
            clone.style.top = '0';
            clone.classList.remove('hidden');
            document.body.appendChild(clone);

            for (let i = 0; i < data.length; i++) {
                btn.innerHTML = `⏳ ${i + 1}/${data.length}`;

                renderFinalReport(data[i], clone);

                await new Promise(r => setTimeout(r, 500));

                await Promise.all(Array.from(clone.querySelectorAll('img')).map(img => {
                    if (img.complete) return Promise.resolve();
                    return new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
                }));

                const canvas = await html2canvas(clone.querySelector('.report-page'), { scale: 1.5, useCORS: true, windowWidth: 1200 });
                const imgWidth = pdf.internal.pageSize.getWidth();
                const pageHeight = pdf.internal.pageSize.getHeight();
                const imgHeight = (canvas.height * imgWidth) / canvas.width;

                let heightLeft = imgHeight;
                let position = 0;

                pdf.addImage(canvas.toDataURL('image/jpeg', 0.8), 'JPEG', 0, position, imgWidth, imgHeight);
                heightLeft -= pageHeight;

                while (heightLeft > 0) {
                    position = heightLeft - imgHeight;
                    pdf.addPage();
                    pdf.addImage(canvas.toDataURL('image/jpeg', 0.8), 'JPEG', 0, position, imgWidth, imgHeight);
                    heightLeft -= pageHeight;
                }

                if (i < data.length - 1) pdf.addPage();
            }

            const fileNameYear = currentSchoolYearFilter !== 'all' ? currentSchoolYearFilter : 'Completo';
            pdf.save(`Expedientes_${fileNameYear}_${new Date().toISOString().slice(0, 10)}.pdf`);
            document.body.removeChild(clone);
            showToast("Exportación masiva PDF completada.");
        } catch (err) {
            console.error(err);
            showToast("Error en exportación masiva", true);
        } finally {
            container.style.position = '';
            container.style.left = '';
            container.classList.add('hidden');
            btn.innerHTML = originalContent;
            btn.disabled = false;
        }
    }
};

const fillForm = (report) => {
    const form = document.getElementById('accident-form');
    form.reset();
    document.getElementById('interveners-container').innerHTML = '';
    intervenerPads = [];

    Object.keys(report).forEach(key => {
        const input = form.elements[key];
        if (input) {
            if (input.type === 'radio') {
                const radio = form.querySelector(`input[name="${key}"][value="${report[key]}"]`);
                if (radio) radio.checked = true;
            } else {
                input.value = report[key];
            }
        }
    });

    const dateVal = report.date || new Date().toISOString().split('T')[0];
    document.getElementById('accident-date').value = dateVal;
    const yearInput = document.getElementById('accident-school-year');
    if (yearInput) {
        yearInput.value = report.schoolYear || getSchoolYear(dateVal);
    }

    if (report.interveners) report.interveners.forEach((int, i) => addIntervenerBlock(int.name, int.signature, i > 0));
    else addIntervenerBlock(); // Nuevo parte
    if (report.coordinatorSignature) signaturePadCoordinator.fromDataURL(report.coordinatorSignature);
};

const renderFinalReport = (data, targetContainer = document) => {
    targetContainer.querySelector('#report-fullName').textContent = data.fullName;
    targetContainer.querySelector('#report-course').textContent = data.course;
    const formattedDate = data.date ? new Date(data.date).toLocaleDateString('es-ES') : '---';
    targetContainer.querySelector('#report-accident-date').textContent = formattedDate;
    targetContainer.querySelector('#report-location').textContent = data.location;
    targetContainer.querySelector('#report-time').textContent = data.time;
    targetContainer.querySelector('#report-severity').textContent = data.severity;
    
    const yearEl = targetContainer.querySelector('#report-schoolYear');
    if (yearEl) {
        yearEl.textContent = data.schoolYear || getSchoolYear(data.date);
    }

    targetContainer.querySelector('#report-description').textContent = data.description;
    targetContainer.querySelector('#report-actionTaken').textContent = data.actionTaken;
    targetContainer.querySelector('#report-parentsCalled').textContent = data.parentsCalled;
    targetContainer.querySelector('#report-emergencyCalled').textContent = data.emergencyCalled;

    const sigs = targetContainer.querySelector('#report-signatures-container');
    sigs.innerHTML = '';

    data.interveners.forEach(int => {
        sigs.innerHTML += `
            <div class="signature-card">
                <div class="signature-space">
                    <img src="${int.signature}" class="signature-img">
                </div>
                <div class="signature-meta">Interviniente: ${int.name}</div>
            </div>
        `;
    });

    sigs.innerHTML += `
        <div class="signature-card">
            <div class="signature-space">
                <img src="${data.coordinatorSignature}" class="signature-img">
            </div>
            <div class="signature-meta">Coordinador: Orestes G.V.</div>
        </div>
    `;
};

// --- Event Listeners Globales ---
const setupEventListeners = () => {
    // Navegación General
    document.querySelectorAll('.nav-button').forEach(btn => {
        btn.onclick = () => {
            const target = btn.dataset.target;
            if (target === 'form-container') fillForm({}); // Limpiar para nuevo
            switchView(target);
        };
    });

    // Actualización reactiva del curso escolar cuando cambia la fecha del accidente
    const dateInput = document.getElementById('accident-date');
    if (dateInput) {
        dateInput.addEventListener('change', (e) => {
            const yInput = document.getElementById('accident-school-year');
            if (yInput) {
                yInput.value = getSchoolYear(e.target.value);
            }
        });
    }

    // Descargas Pro
    const csvBtn = document.getElementById('download-csv-btn');
    if (csvBtn) {
        csvBtn.onclick = () => App.exportToExcel();
    }

    const bulkPdfBtn = document.getElementById('bulk-pdf-btn');
    if (bulkPdfBtn) {
        bulkPdfBtn.onclick = () => App.exportBulkPdf();
    }

    // PIN Acceso
    document.getElementById('entry-pin-submit-btn').onclick = () => {
        handleAuth(document.getElementById('entry-pin-input').value);
    };
    document.getElementById('entry-pin-input').onkeydown = (e) => {
        if (e.key === 'Enter') handleAuth(e.target.value);
    };

    // Navegación Admin
    document.getElementById('nav-admin').onclick = () => {
        if (isAdminUnlocked) {
            showToast("Ajustes ya desbloqueados.");
            return;
        }
        document.getElementById('admin-pin-modal-overlay').classList.remove('hidden');
        document.getElementById('admin-pin-input').focus();
    };

    document.getElementById('admin-pin-submit-btn').onclick = () => {
        const pin = document.getElementById('admin-pin-input').value;
        if (pin === APP_CONFIG.ADMIN_PIN) {
            isAdminUnlocked = true;
            document.getElementById('nav-memory').classList.remove('hidden');
            document.getElementById('nav-settings').classList.remove('hidden');
            document.getElementById('admin-pin-modal-overlay').classList.add('hidden');
            showToast("Modo administrador activado.");
        } else {
            showToast("PIN incorrecto.", true);
            document.getElementById('admin-pin-input').value = '';
        }
    };
    document.getElementById('admin-pin-input').onkeydown = (e) => {
        if (e.key === 'Enter') document.getElementById('admin-pin-submit-btn').click();
    };

    // Google Auth
    document.getElementById('google-auth-submit-btn').onclick = () => {
        handleGoogleAuth();
    };

    // Logout
    document.getElementById('logout-btn').onclick = async () => {
        if (confirm("¿Cerrar sesión y bloquear la aplicación?")) {
            await auth.signOut();
            window.location.reload();
        }
    };

    // Envío de Formulario
    document.getElementById('accident-form').onsubmit = async (e) => {
        e.preventDefault();
        const mode = document.getElementById('editingReportId').dataset.mode || 'new';
        const reportId = document.getElementById('editingReportId').value;
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());

        // Validaciones
        const interveners = [];
        document.querySelectorAll('.intervener-block').forEach((block, i) => {
            const name = block.querySelector('input[name="intervenerName"]').value;
            const signature = intervenerPads[i].toDataURL();
            interveners.push({ name, signature });
        });

        const accidentDate = data.date || new Date().toISOString().split('T')[0];
        const schoolYear = data.schoolYear || getSchoolYear(accidentDate);

        const finalData = {
            ...data,
            schoolYear,
            interveners,
            coordinatorSignature: signaturePadCoordinator.isEmpty() ? null : signaturePadCoordinator.toDataURL(),
            updatedAt: serverTimestamp()
        };

        try {
            if (mode === 'finalize') {
                finalData.status = 'finished';
                finalData.finalizedAt = serverTimestamp();
                await updateDoc(doc(db, "finishedReports", reportId), finalData);
                showToast("Parte finalizado y archivado para el curso " + schoolYear + ".");
            } else if (mode === 'edit') {
                await updateDoc(doc(db, "finishedReports", reportId), finalData);
                showToast("Cambios guardados.");
            } else {
                finalData.status = 'pending';
                finalData.createdAt = serverTimestamp();
                sendGravityAlert(finalData);
                await addDoc(reportsCollection, finalData);
                showToast("Parte creado como pendiente para el curso " + schoolYear + ".");
            }
            switchView('pending-container');
        } catch (err) {
            console.error(err);
            showToast("Error al guardar el parte.", true);
        }
    };
};

const loadLocalSettings = () => {
    const name = localStorage.getItem('schoolName') || APP_CONFIG.DEFAULT_SCHOOL;
    const year = localStorage.getItem('schoolYear') || APP_CONFIG.DEFAULT_YEAR || getSchoolYear();
    document.querySelectorAll('.school-name-text').forEach(el => el.textContent = name);

    const nameInput = document.getElementById('setting-school-name');
    if (nameInput) nameInput.value = name;

    const yearInput = document.getElementById('setting-school-year');
    if (yearInput) yearInput.value = year;

    const schoolYearInput = document.getElementById('accident-school-year');
    if (schoolYearInput && !schoolYearInput.value) {
        const currentDateVal = document.getElementById('accident-date')?.value || new Date().toISOString().split('T')[0];
        schoolYearInput.value = getSchoolYear(currentDateVal);
    }
};

// Arrancar
document.addEventListener('DOMContentLoaded', initApp);
