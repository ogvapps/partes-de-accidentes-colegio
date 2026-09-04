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
        if (!data || !data.length) return showToast("No hay datos para exportar", true);

        const schoolName = localStorage.getItem('schoolName') || APP_CONFIG.DEFAULT_SCHOOL;
        const coordinatorName = localStorage.getItem('coordinatorName') || APP_CONFIG.COORDINATOR_NAME;
        const currentYearLabel = currentSchoolYearFilter !== 'all' ? currentSchoolYearFilter : 'Histórico Completo';

        // Si SheetJS está disponible en window.XLSX, generamos el libro Excel nativo .xlsx
        if (typeof XLSX !== 'undefined') {
            try {
                const wb = XLSX.utils.book_new();

                if (singleReport) {
                    // --- Ficha Individual en Excel ---
                    const r = singleReport;
                    const intervenerNames = (r.interveners && r.interveners.length)
                        ? r.interveners.map(i => i.name).filter(Boolean).join(', ')
                        : '---';

                    const sheetData = [
                        ["EXPEDIENTE OFICIAL DE ACCIDENTE ESCOLAR"],
                        ["Centro Educativo:", schoolName],
                        ["Coordinación de Salud:", coordinatorName],
                        ["Fecha de Emisión:", new Date().toLocaleDateString('es-ES')],
                        [],
                        ["1. IDENTIFICACIÓN DEL ALUMNO/A", ""],
                        ["Nombre Completo", r.fullName || '---'],
                        ["Curso / Nivel", r.course || '---'],
                        ["Curso Escolar", r.schoolYear || getSchoolYear(r.date)],
                        [],
                        ["2. DATOS DEL INCIDENTE", ""],
                        ["Fecha del Suceso", r.date ? new Date(r.date).toLocaleDateString('es-ES') : '---'],
                        ["Hora", r.time || '---'],
                        ["Lugar / Ubicación", r.location || '---'],
                        ["Nivel de Gravedad", r.severity || '---'],
                        [],
                        ["3. DESCRIPCIÓN DE LOS HECHOS", ""],
                        ["Descripción Detallada", r.description || '---'],
                        [],
                        ["4. ACTUACIONES Y PROTOCOLO", ""],
                        ["Actuaciones Realizadas", r.actionTaken || '---'],
                        ["Aviso a la Familia", r.parentsCalled || '---'],
                        ["Llamada al 112 (Emergencias)", r.emergencyCalled || '---'],
                        [],
                        ["5. VALIDACIÓN Y FIRMAS", ""],
                        ["Personal Interviniente", intervenerNames],
                        ["Coordinación de Salud", coordinatorName],
                        ["Estado Administrativo", r.status === 'pending' ? 'Pendiente de Revisión' : 'Finalizado y Rubricado']
                    ];

                    const ws1 = XLSX.utils.aoa_to_sheet(sheetData);
                    ws1['!cols'] = [{ wch: 28 }, { wch: 65 }];
                    XLSX.utils.book_append_sheet(wb, ws1, "Ficha de Accidente");

                    const safeName = (r.fullName || 'Alumno').trim().replace(/[\s/\\?%*:|"<>]/g, '_');
                    const fileName = `Parte_${safeName}_${r.date || 'Registro'}.xlsx`;
                    XLSX.writeFile(wb, fileName);
                    showToast("Ficha Excel (.xlsx) generada con éxito");
                    return;
                }

                // --- Exportación General / Histórico ---
                // Hoja 1: Registro Detallado
                const headers = [
                    "Nº",
                    "ID Expediente",
                    "Curso Escolar",
                    "Fecha",
                    "Hora",
                    "Alumno/a",
                    "Curso / Nivel",
                    "Ubicación",
                    "Gravedad",
                    "Descripción de los Hechos",
                    "Actuaciones Realizadas",
                    "Aviso Familia",
                    "Aviso 112",
                    "Intervinientes",
                    "Estado"
                ];

                const rows = data.map((r, idx) => [
                    idx + 1,
                    r.id ? String(r.id).slice(0, 10).toUpperCase() : '---',
                    r.schoolYear || getSchoolYear(r.date),
                    r.date ? new Date(r.date).toLocaleDateString('es-ES') : '---',
                    r.time || '---',
                    r.fullName || '---',
                    r.course || '---',
                    r.location || '---',
                    r.severity || '---',
                    r.description || '---',
                    r.actionTaken || '---',
                    r.parentsCalled || '---',
                    r.emergencyCalled || '---',
                    (r.interveners && r.interveners.length) ? r.interveners.map(i => i.name).filter(Boolean).join(', ') : '---',
                    r.status === 'pending' ? 'PENDIENTE' : 'FINALIZADO'
                ]);

                const ws1 = XLSX.utils.aoa_to_sheet([headers, ...rows]);

                // Cálculo automático de anchos de columna
                const colWidths = headers.map((h, colIdx) => {
                    let maxLen = h.length;
                    rows.forEach(row => {
                        const val = row[colIdx] != null ? String(row[colIdx]) : '';
                        if (val.length > maxLen) maxLen = Math.min(val.length, 55);
                    });
                    return { wch: Math.max(maxLen + 3, 10) };
                });
                ws1['!cols'] = colWidths;
                XLSX.utils.book_append_sheet(wb, ws1, "Registro de Partes");

                // Hoja 2: Resumen Ejecutivo y Estadísticas
                const total = data.length;
                const leves = data.filter(r => (r.severity || '').toLowerCase().includes('leve')).length;
                const moderados = data.filter(r => (r.severity || '').toLowerCase().includes('moderad')).length;
                const graves = data.filter(r => (r.severity || '').toLowerCase().includes('grave')).length;
                const avisos112 = data.filter(r => ['sí', 'si'].includes(String(r.emergencyCalled || '').toLowerCase().trim())).length;
                const avisosFamilia = data.filter(r => ['sí', 'si'].includes(String(r.parentsCalled || '').toLowerCase().trim())).length;

                // Agrupaciones
                const locMap = {};
                data.forEach(r => {
                    const loc = r.location || 'No especificada';
                    locMap[loc] = (locMap[loc] || 0) + 1;
                });

                const courseMap = {};
                data.forEach(r => {
                    const c = r.course || 'No especificado';
                    courseMap[c] = (courseMap[c] || 0) + 1;
                });

                const summaryData = [
                    ["LIBRO OFICIAL DE ACCIDENTES - RESUMEN EJECUTIVO"],
                    ["Centro Educativo:", schoolName],
                    ["Coordinación de Salud:", coordinatorName],
                    ["Curso Escolar Filtrado:", currentYearLabel],
                    ["Fecha de Generación:", new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })],
                    [],
                    ["INDICADORES CLAVE (KPIs)", "CANTIDAD", "PORCENTAJE"],
                    ["Total de Partes Registrados", total, "100%"],
                    ["Accidentes Leves", leves, total ? ((leves / total) * 100).toFixed(1) + "%" : "0%"],
                    ["Accidentes Moderados", moderados, total ? ((moderados / total) * 100).toFixed(1) + "%" : "0%"],
                    ["Accidentes Graves", graves, total ? ((graves / total) * 100).toFixed(1) + "%" : "0%"],
                    ["Avisos al 112 (Emergencias)", avisos112, total ? ((avisos112 / total) * 100).toFixed(1) + "%" : "0%"],
                    ["Familias Notificadas", avisosFamilia, total ? ((avisosFamilia / total) * 100).toFixed(1) + "%" : "0%"],
                    [],
                    ["DISTRIBUCIÓN POR UBICACIÓN / ZONA", "Nº INCIDENCIAS", "PORCENTAJE"],
                    ...Object.entries(locMap)
                        .sort((a, b) => b[1] - a[1])
                        .map(([loc, cnt]) => [loc, cnt, ((cnt / (total || 1)) * 100).toFixed(1) + "%"]),
                    [],
                    ["DISTRIBUCIÓN POR CURSO / NIVEL", "Nº INCIDENCIAS", "PORCENTAJE"],
                    ...Object.entries(courseMap)
                        .sort((a, b) => b[1] - a[1])
                        .map(([c, cnt]) => [c, cnt, ((cnt / (total || 1)) * 100).toFixed(1) + "%"])
                ];

                const ws2 = XLSX.utils.aoa_to_sheet(summaryData);
                ws2['!cols'] = [{ wch: 38 }, { wch: 18 }, { wch: 16 }];
                XLSX.utils.book_append_sheet(wb, ws2, "Resumen y Estadísticas");

                const safeYear = currentYearLabel.replace(/[\s/\\?%*:|"<>]/g, '_');
                const fileName = `Libro_Accidentes_${safeYear}_${new Date().toISOString().slice(0, 10)}.xlsx`;
                XLSX.writeFile(wb, fileName);
                showToast("Libro Excel (.xlsx) generado con 2 hojas");
                return;
            } catch (err) {
                console.error("Error generando XLSX con SheetJS, aplicando fallback CSV:", err);
            }
        }

        // Fallback robusto a CSV UTF-8 con punto y coma si SheetJS no estuviese disponible
        const headers = ["ID", "Curso Escolar", "Fecha", "Hora", "Alumno", "Curso", "Ubicación", "Gravedad", "Descripción", "Actuaciones", "Aviso Familia", "Aviso 112", "Estado"];
        const clean = (val) => {
            if (val === undefined || val === null) return "";
            let str = String(val).replace(/"/g, '""');
            str = str.replace(/\r?\n|\r/g, " ");
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
        showToast("Archivo exportado correctamente.");
    },
    exportPdf: async (reportId) => {
        const report = [...currentPendingReports, ...currentFinishedReports].find(r => r.id === reportId);
        if (!report) return;

        const btn = document.querySelector('button[onclick*="exportPdf"]');
        const originalText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span class="inline-flex items-center gap-2"><svg class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Generando PDF Oficial...</span>`;
        }

        const schoolName = localStorage.getItem('schoolName') || APP_CONFIG.DEFAULT_SCHOOL;
        const schoolYear = report.schoolYear || getSchoolYear(report.date);

        try {
            const container = document.getElementById('report-view');
            const clone = container.cloneNode(true);
            clone.style.position = 'fixed';
            clone.style.left = '-9999px';
            clone.style.top = '0';
            clone.style.width = '800px';
            clone.style.background = '#ffffff';
            clone.classList.remove('hidden');
            document.body.appendChild(clone);

            renderFinalReport(report, clone);

            // Asegurar que el nombre del centro esté en el clon
            clone.querySelectorAll('.school-name-text').forEach(el => el.textContent = schoolName);

            // Esperar carga de todas las imágenes / firmas en el clon
            await Promise.all(Array.from(clone.querySelectorAll('img')).map(img => {
                if (img.complete) return Promise.resolve();
                return new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
            }));

            // Breve espera para renderizado de fuentes y estilos
            await new Promise(r => setTimeout(r, 200));

            const reportPageEl = clone.querySelector('.report-page');
            const canvas = await html2canvas(reportPageEl, {
                scale: 2,
                useCORS: true,
                backgroundColor: '#ffffff',
                windowWidth: 1000
            });

            const pdf = new jspdf.jsPDF('p', 'mm', 'a4');
            const pageWidth = pdf.internal.pageSize.getWidth(); // 210
            const pageHeight = pdf.internal.pageSize.getHeight(); // 297

            // Márgenes profesionales
            const marginX = 14;
            const marginTop = 18;
            const marginBottom = 15;
            const printableWidth = pageWidth - (marginX * 2); // 182 mm
            const printableHeight = pageHeight - marginTop - marginBottom; // 264 mm

            const imgWidthMm = printableWidth;
            const imgHeightMm = (canvas.height * imgWidthMm) / canvas.width;

            if (imgHeightMm <= printableHeight) {
                // Cabe perfectamente en una sola página con encuadre institucional
                // Encabezado institucional
                pdf.setFillColor(37, 99, 235);
                pdf.rect(0, 0, pageWidth, 4, 'F');
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(8);
                pdf.setTextColor(100, 116, 139);
                pdf.text(`PARTE OFICIAL DE ACCIDENTE • ${schoolName.toUpperCase()} • CURSO ${schoolYear}`, marginX, 12);
                pdf.setDrawColor(226, 232, 240);
                pdf.setLineWidth(0.4);
                pdf.line(marginX, 14, pageWidth - marginX, 14);

                pdf.addImage(canvas.toDataURL('image/jpeg', 0.96), 'JPEG', marginX, marginTop, imgWidthMm, imgHeightMm);

                // Pie de página institucional
                pdf.setDrawColor(226, 232, 240);
                pdf.setLineWidth(0.4);
                pdf.line(marginX, pageHeight - 11, pageWidth - marginX, pageHeight - 11);
                pdf.setFont('helvetica', 'normal');
                pdf.setFontSize(7.5);
                pdf.setTextColor(148, 163, 184);
                pdf.text(`Documento oficial de diligencia escolar • Generado el ${new Date().toLocaleDateString('es-ES')}`, marginX, pageHeight - 6);
                pdf.text("Página 1 de 1", pageWidth - marginX, pageHeight - 6, { align: 'right' });
            } else {
                // Multi-página por si el informe fuese muy extenso
                const pxToMm = imgWidthMm / canvas.width;
                const pxPageHeight = printableHeight / pxToMm;
                let currentY = 0;
                let pageIndex = 1;
                const totalPagesEst = Math.ceil(canvas.height / pxPageHeight);

                while (currentY < canvas.height) {
                    if (pageIndex > 1) pdf.addPage();

                    // Encabezado
                    pdf.setFillColor(37, 99, 235);
                    pdf.rect(0, 0, pageWidth, 4, 'F');
                    pdf.setFont('helvetica', 'bold');
                    pdf.setFontSize(8);
                    pdf.setTextColor(100, 116, 139);
                    pdf.text(`PARTE OFICIAL DE ACCIDENTE • ${schoolName.toUpperCase()} • CURSO ${schoolYear}`, marginX, 12);
                    pdf.setDrawColor(226, 232, 240);
                    pdf.setLineWidth(0.4);
                    pdf.line(marginX, 14, pageWidth - marginX, 14);

                    // Rebanada de canvas
                    const sliceHeight = Math.min(pxPageHeight, canvas.height - currentY);
                    const pageCanvas = document.createElement('canvas');
                    pageCanvas.width = canvas.width;
                    pageCanvas.height = sliceHeight;
                    const ctx = pageCanvas.getContext('2d');
                    ctx.drawImage(canvas, 0, currentY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

                    const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.95);
                    pdf.addImage(pageImgData, 'JPEG', marginX, marginTop, imgWidthMm, sliceHeight * pxToMm);

                    // Pie de página
                    pdf.setDrawColor(226, 232, 240);
                    pdf.setLineWidth(0.4);
                    pdf.line(marginX, pageHeight - 11, pageWidth - marginX, pageHeight - 11);
                    pdf.setFont('helvetica', 'normal');
                    pdf.setFontSize(7.5);
                    pdf.setTextColor(148, 163, 184);
                    pdf.text(`Documento oficial • Alumno: ${report.fullName || ''}`, marginX, pageHeight - 6);
                    pdf.text(`Página ${pageIndex} de ${totalPagesEst}`, pageWidth - marginX, pageHeight - 6, { align: 'right' });

                    currentY += pxPageHeight;
                    pageIndex++;
                }
            }

            const cleanName = (report.fullName || 'Alumno').trim().replace(/[\s/\\?%*:|"<>]/g, '_');
            pdf.save(`Expediente_${cleanName}_${report.date || ''}.pdf`);
            document.body.removeChild(clone);
            showToast("Expediente PDF oficial generado.");
        } catch (err) {
            console.error("Error en exportPdf:", err);
            showToast("Error al expedir PDF", true);
        } finally {
            if (btn) {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        }
    },
    exportBulkPdf: async () => {
        let data = currentFinishedReports;
        if (currentSchoolYearFilter && currentSchoolYearFilter !== 'all') {
            data = data.filter(r => (r.schoolYear || getSchoolYear(r.date)) === currentSchoolYearFilter);
        }
        if (!data || !data.length) {
            return showToast("No hay informes para exportar en este curso", true);
        }

        const btn = document.getElementById('bulk-pdf-btn');
        const originalContent = btn ? btn.innerHTML : '';
        if (btn) btn.disabled = true;

        const schoolName = localStorage.getItem('schoolName') || APP_CONFIG.DEFAULT_SCHOOL;
        const coordinatorName = localStorage.getItem('coordinatorName') || APP_CONFIG.COORDINATOR_NAME;
        const yearLabel = currentSchoolYearFilter !== 'all' ? currentSchoolYearFilter : 'Histórico Completo';

        try {
            showToast("Iniciando compilación del Dossier Oficial...", false);
            const pdf = new jspdf.jsPDF('p', 'mm', 'a4');
            const pageWidth = pdf.internal.pageSize.getWidth(); // 210
            const pageHeight = pdf.internal.pageSize.getHeight(); // 297
            const marginX = 15;

            // Métricas para Portada
            const total = data.length;
            const leves = data.filter(r => (r.severity || '').toLowerCase().includes('leve')).length;
            const moderados = data.filter(r => (r.severity || '').toLowerCase().includes('moderad')).length;
            const graves = data.filter(r => (r.severity || '').toLowerCase().includes('grave')).length;
            const avisos112 = data.filter(r => ['sí', 'si'].includes(String(r.emergencyCalled || '').toLowerCase().trim())).length;
            const avisosFamilia = data.filter(r => ['sí', 'si'].includes(String(r.parentsCalled || '').toLowerCase().trim())).length;

            // ==========================================
            // PÁGINA 1: PORTADA INSTITUCIONAL
            // ==========================================
            // Franja superior en azul corporativo
            pdf.setFillColor(30, 58, 138); // Blue 900
            pdf.rect(0, 0, pageWidth, 18, 'F');
            pdf.setFillColor(37, 99, 235); // Blue 600
            pdf.rect(0, 18, pageWidth, 3, 'F');

            // Encabezado institucional
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9);
            pdf.setTextColor(255, 255, 255);
            pdf.text("SISTEMA DE GESTIÓN DE SALUD Y SEGURIDAD ESCOLAR", 105, 11, { align: 'center' });

            // Badge / Sub-marca
            pdf.setFillColor(239, 246, 255);
            pdf.setDrawColor(191, 219, 254);
            pdf.roundedRect(marginX, 38, pageWidth - (marginX * 2), 22, 3, 3, 'FD');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(11);
            pdf.setTextColor(29, 78, 216);
            pdf.text(schoolName.toUpperCase(), 105, 49, { align: 'center' });
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            pdf.setTextColor(71, 85, 105);
            pdf.text("Registro Oficial de Diligencias y Protocolos de Accidente Escolar", 105, 55, { align: 'center' });

            // Título Principal
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(23);
            pdf.setTextColor(15, 23, 42); // Slate 900
            pdf.text("DOSSIER OFICIAL", 105, 82, { align: 'center' });
            pdf.setFontSize(15);
            pdf.setTextColor(37, 99, 235); // Blue 600
            pdf.text("LIBRO DE REGISTRO DE ACCIDENTES", 105, 91, { align: 'center' });

            // Línea divisoria elegante
            pdf.setDrawColor(203, 213, 225);
            pdf.setLineWidth(0.6);
            pdf.line(50, 98, 160, 98);

            // Tarjeta de Metadatos Institucionales
            const cardY = 108;
            const cardHeight = 65;
            pdf.setFillColor(248, 250, 252);
            pdf.setDrawColor(226, 232, 240);
            pdf.setLineWidth(0.5);
            pdf.roundedRect(marginX, cardY, pageWidth - (marginX * 2), cardHeight, 4, 4, 'FD');

            // Encabezado de la tarjeta
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(8.5);
            pdf.setTextColor(100, 116, 139);
            pdf.text("DATOS DEL EXPEDIENTE Y CUSTODIA", marginX + 8, cardY + 11);

            pdf.setDrawColor(241, 245, 249);
            pdf.line(marginX + 8, cardY + 14, pageWidth - marginX - 8, cardY + 14);

            // Contenido de la tarjeta en dos columnas
            const drawMetaRow = (label, val, yPos) => {
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(9);
                pdf.setTextColor(71, 85, 105);
                pdf.text(label, marginX + 8, yPos);
                pdf.setFont('helvetica', 'normal');
                pdf.setTextColor(15, 23, 42);
                pdf.text(String(val), marginX + 62, yPos);
            };

            drawMetaRow("Centro Educativo:", schoolName, cardY + 23);
            drawMetaRow("Curso Escolar:", yearLabel, cardY + 31);
            drawMetaRow("Total Expedientes:", `${total} partes rubricados y archivados`, cardY + 39);
            drawMetaRow("Coordinación de Salud:", coordinatorName, cardY + 47);
            drawMetaRow("Fecha de Expedición:", new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), cardY + 55);

            // Cajas de Estadísticas Resumidas (KPI Pills)
            const kpiY = 183;
            const kpiWidth = (pageWidth - (marginX * 2) - 9) / 4;
            const kpiHeight = 26;

            // KPI 1: Leves
            pdf.setFillColor(240, 253, 244); // Emerald 50
            pdf.setDrawColor(187, 247, 208);
            pdf.roundedRect(marginX, kpiY, kpiWidth, kpiHeight, 3, 3, 'FD');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(14);
            pdf.setTextColor(22, 101, 52);
            pdf.text(String(leves), marginX + (kpiWidth / 2), kpiY + 11, { align: 'center' });
            pdf.setFontSize(7.5);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(21, 128, 61);
            pdf.text("LEVES", marginX + (kpiWidth / 2), kpiY + 18, { align: 'center' });
            pdf.setFontSize(6.5);
            pdf.setFont('helvetica', 'normal');
            pdf.text(total ? `${Math.round((leves / total) * 100)}% del total` : "0%", marginX + (kpiWidth / 2), kpiY + 22, { align: 'center' });

            // KPI 2: Moderados
            const kpi2X = marginX + kpiWidth + 3;
            pdf.setFillColor(254, 252, 232); // Yellow 50
            pdf.setDrawColor(254, 240, 138);
            pdf.roundedRect(kpi2X, kpiY, kpiWidth, kpiHeight, 3, 3, 'FD');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(14);
            pdf.setTextColor(133, 77, 14);
            pdf.text(String(moderados), kpi2X + (kpiWidth / 2), kpiY + 11, { align: 'center' });
            pdf.setFontSize(7.5);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(161, 98, 7);
            pdf.text("MODERADOS", kpi2X + (kpiWidth / 2), kpiY + 18, { align: 'center' });
            pdf.setFontSize(6.5);
            pdf.setFont('helvetica', 'normal');
            pdf.text(total ? `${Math.round((moderados / total) * 100)}% del total` : "0%", kpi2X + (kpiWidth / 2), kpiY + 22, { align: 'center' });

            // KPI 3: Graves
            const kpi3X = kpi2X + kpiWidth + 3;
            pdf.setFillColor(254, 242, 242); // Red 50
            pdf.setDrawColor(254, 202, 202);
            pdf.roundedRect(kpi3X, kpiY, kpiWidth, kpiHeight, 3, 3, 'FD');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(14);
            pdf.setTextColor(153, 27, 27);
            pdf.text(String(graves), kpi3X + (kpiWidth / 2), kpiY + 11, { align: 'center' });
            pdf.setFontSize(7.5);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(185, 28, 28);
            pdf.text("GRAVES", kpi3X + (kpiWidth / 2), kpiY + 18, { align: 'center' });
            pdf.setFontSize(6.5);
            pdf.setFont('helvetica', 'normal');
            pdf.text(total ? `${Math.round((graves / total) * 100)}% del total` : "0%", kpi3X + (kpiWidth / 2), kpiY + 22, { align: 'center' });

            // KPI 4: Aviso 112
            const kpi4X = kpi3X + kpiWidth + 3;
            pdf.setFillColor(238, 242, 255); // Indigo 50
            pdf.setDrawColor(199, 210, 254);
            pdf.roundedRect(kpi4X, kpiY, kpiWidth, kpiHeight, 3, 3, 'FD');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(14);
            pdf.setTextColor(55, 48, 163);
            pdf.text(String(avisos112), kpi4X + (kpiWidth / 2), kpiY + 11, { align: 'center' });
            pdf.setFontSize(7.5);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(67, 56, 202);
            pdf.text("AVISO 112", kpi4X + (kpiWidth / 2), kpiY + 18, { align: 'center' });
            pdf.setFontSize(6.5);
            pdf.setFont('helvetica', 'normal');
            pdf.text(`${avisosFamilia} con familia`, kpi4X + (kpiWidth / 2), kpiY + 22, { align: 'center' });

            // Sello de Garantía y Validez
            pdf.setFillColor(241, 245, 249);
            pdf.roundedRect(marginX, 220, pageWidth - (marginX * 2), 34, 3, 3, 'F');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(8);
            pdf.setTextColor(71, 85, 105);
            pdf.text("CERTIFICACIÓN Y DILIGENCIA DE ARCHIVO", marginX + 8, 229);
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(7.5);
            pdf.setTextColor(100, 116, 139);
            pdf.text("El presente documento reúne los partes de accidente escolar registrados y tramitados telemáticamente con firma manuscrita digitalizada.", marginX + 8, 236);
            pdf.text("Queda archivado para su custodia por el Equipo Directivo, Consejo Escolar e Inspección Técnica Educativa.", marginX + 8, 242);
            pdf.text(`Identificador de Compilación: DOS-${Date.now().toString(36).toUpperCase()} • Expedido el ${new Date().toLocaleDateString('es-ES')}`, marginX + 8, 248);

            // Franja inferior con nota legal RGPD
            pdf.setFillColor(15, 23, 42); // Slate 900
            pdf.rect(0, 283, pageWidth, 14, 'F');
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(7);
            pdf.setTextColor(203, 213, 225);
            pdf.text("DOCUMENTO OFICIAL CONFIDENCIAL • PROTEGIDO POR LA LEY ORGÁNICA DE PROTECCIÓN DE DATOS (RGPD / LOMLOE)", 105, 291, { align: 'center' });

            // ==========================================
            // PÁGINA 2+: ÍNDICE GENERAL DE EXPEDIENTES
            // ==========================================
            const rowsPerPage = 18;
            const indexPages = Math.ceil(data.length / rowsPerPage);

            for (let idxP = 0; idxP < indexPages; idxP++) {
                pdf.addPage();

                // Cabecera superior institucional
                pdf.setFillColor(30, 58, 138);
                pdf.rect(0, 0, pageWidth, 4, 'F');

                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(14);
                pdf.setTextColor(15, 23, 42);
                pdf.text("ÍNDICE GENERAL DE EXPEDIENTES", marginX, 16);

                pdf.setFont('helvetica', 'normal');
                pdf.setFontSize(8.5);
                pdf.setTextColor(100, 116, 139);
                pdf.text(`${schoolName} • Curso Escolar: ${yearLabel} (Página de índice ${idxP + 1} de ${indexPages})`, marginX, 22);

                pdf.setDrawColor(226, 232, 240);
                pdf.setLineWidth(0.4);
                pdf.line(marginX, 25, pageWidth - marginX, 25);

                // Cabecera de la tabla de índice
                const tableY = 30;
                pdf.setFillColor(15, 23, 42); // Slate 900
                pdf.rect(marginX, tableY, pageWidth - (marginX * 2), 8, 'F');

                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(7.5);
                pdf.setTextColor(255, 255, 255);
                pdf.text("Nº", marginX + 3, tableY + 5.5);
                pdf.text("FECHA", marginX + 12, tableY + 5.5);
                pdf.text("ALUMNO/A", marginX + 34, tableY + 5.5);
                pdf.text("CURSO", marginX + 90, tableY + 5.5);
                pdf.text("UBICACIÓN", marginX + 115, tableY + 5.5);
                pdf.text("GRAVEDAD", marginX + 147, tableY + 5.5);
                pdf.text("112", marginX + 171, tableY + 5.5);

                // Filas de la tabla
                const sliceData = data.slice(idxP * rowsPerPage, (idxP + 1) * rowsPerPage);
                let rowY = tableY + 8;

                sliceData.forEach((r, rIdx) => {
                    const globalIdx = (idxP * rowsPerPage) + rIdx + 1;
                    const isEven = rIdx % 2 === 0;

                    // Fondo de fila alternado
                    pdf.setFillColor(isEven ? 255 : 248, isEven ? 255 : 250, isEven ? 255 : 252);
                    pdf.rect(marginX, rowY, pageWidth - (marginX * 2), 9, 'F');

                    pdf.setDrawColor(241, 245, 249);
                    pdf.line(marginX, rowY + 9, pageWidth - marginX, rowY + 9);

                    pdf.setFont('helvetica', 'bold');
                    pdf.setFontSize(7.5);
                    pdf.setTextColor(71, 85, 105);
                    pdf.text(String(globalIdx), marginX + 3, rowY + 6);

                    pdf.setFont('helvetica', 'normal');
                    pdf.setTextColor(30, 41, 59);
                    pdf.text(r.date ? new Date(r.date).toLocaleDateString('es-ES') : '---', marginX + 12, rowY + 6);

                    // Alumno (cortar si es muy largo)
                    const studentName = String(r.fullName || '---').slice(0, 26);
                    pdf.setFont('helvetica', 'bold');
                    pdf.text(studentName, marginX + 34, rowY + 6);

                    pdf.setFont('helvetica', 'normal');
                    pdf.text(String(r.course || '---').slice(0, 14), marginX + 90, rowY + 6);
                    pdf.text(String(r.location || '---').slice(0, 18), marginX + 115, rowY + 6);

                    // Gravedad con color
                    const sev = String(r.severity || 'Leve');
                    if (sev.toLowerCase().includes('grave')) {
                        pdf.setTextColor(220, 38, 38);
                        pdf.setFont('helvetica', 'bold');
                    } else if (sev.toLowerCase().includes('moderad')) {
                        pdf.setTextColor(217, 119, 6);
                        pdf.setFont('helvetica', 'bold');
                    } else {
                        pdf.setTextColor(22, 101, 52);
                        pdf.setFont('helvetica', 'normal');
                    }
                    pdf.text(sev, marginX + 147, rowY + 6);

                    // 112
                    const is112 = ['sí', 'si'].includes(String(r.emergencyCalled || '').toLowerCase().trim());
                    pdf.setTextColor(is112 ? 220 : 148, is112 ? 38 : 163, is112 ? 38 : 184);
                    pdf.setFont('helvetica', is112 ? 'bold' : 'normal');
                    pdf.text(is112 ? "SÍ" : "No", marginX + 172, rowY + 6);

                    rowY += 9;
                });
            }

            // ==========================================
            // EXPEDIENTES INDIVIDUALES
            // ==========================================
            const container = document.getElementById('report-view');
            const clone = container.cloneNode(true);
            clone.style.position = 'fixed';
            clone.style.left = '-9999px';
            clone.style.top = '0';
            clone.style.width = '800px';
            clone.style.background = '#ffffff';
            clone.classList.remove('hidden');
            document.body.appendChild(clone);

            for (let i = 0; i < data.length; i++) {
                if (btn) btn.innerHTML = `⏳ Compilando ${i + 1}/${data.length}...`;

                renderFinalReport(data[i], clone);
                clone.querySelectorAll('.school-name-text').forEach(el => el.textContent = schoolName);

                await new Promise(r => setTimeout(r, 150));

                await Promise.all(Array.from(clone.querySelectorAll('img')).map(img => {
                    if (img.complete) return Promise.resolve();
                    return new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
                }));

                const reportPageEl = clone.querySelector('.report-page');
                const canvas = await html2canvas(reportPageEl, {
                    scale: 2,
                    useCORS: true,
                    backgroundColor: '#ffffff',
                    windowWidth: 1000
                });

                pdf.addPage();

                // Cabecera institucional de página
                pdf.setFillColor(37, 99, 235);
                pdf.rect(0, 0, pageWidth, 4, 'F');
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(7.5);
                pdf.setTextColor(100, 116, 139);
                pdf.text(`DOSSIER OFICIAL • ${schoolName.toUpperCase()} • CURSO ${yearLabel}`, marginX, 11);
                pdf.setDrawColor(226, 232, 240);
                pdf.setLineWidth(0.4);
                pdf.line(marginX, 13, pageWidth - marginX, 13);

                // Dimensiones del reporte
                const printableWidth = pageWidth - (marginX * 2); // 180mm
                const maxAvailableHeight = pageHeight - 16 - 15; // 266mm
                const imgHeightMm = (canvas.height * printableWidth) / canvas.width;

                if (imgHeightMm <= maxAvailableHeight) {
                    // Centrado vertical limpio
                    const posY = 16 + ((maxAvailableHeight - imgHeightMm) / 4);
                    pdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', marginX, Math.max(16, posY), printableWidth, imgHeightMm);
                } else {
                    // Si excede, escalar proporcionalmente para encajar en la página
                    const scaleFactor = maxAvailableHeight / imgHeightMm;
                    const scaledWidth = printableWidth * scaleFactor;
                    const offsetX = marginX + ((printableWidth - scaledWidth) / 2);
                    pdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', offsetX, 16, scaledWidth, maxAvailableHeight);
                }

                // Pie de página de expediente
                pdf.setDrawColor(226, 232, 240);
                pdf.setLineWidth(0.4);
                pdf.line(marginX, pageHeight - 11, pageWidth - marginX, pageHeight - 11);
                pdf.setFont('helvetica', 'normal');
                pdf.setFontSize(7.5);
                pdf.setTextColor(148, 163, 184);
                const expedLabel = `Expediente nº ${i + 1}: ${(data[i].fullName || 'Alumno').toUpperCase()} (${data[i].date ? new Date(data[i].date).toLocaleDateString('es-ES') : ''})`;
                pdf.text(expedLabel, marginX, pageHeight - 6);
            }

            document.body.removeChild(clone);

            // ==========================================
            // PASO FINAL: NUMERACIÓN CORRELATIVA DE PÁGINAS
            // ==========================================
            const totalPages = pdf.getNumberOfPages();
            for (let p = 2; p <= totalPages; p++) {
                pdf.setPage(p);
                pdf.setFont('helvetica', 'normal');
                pdf.setFontSize(7.5);
                pdf.setTextColor(148, 163, 184);
                pdf.text(`Página ${p} de ${totalPages}`, pageWidth - marginX, pageHeight - 6, { align: 'right' });
            }

            const safeYear = yearLabel.replace(/[\s/\\?%*:|"<>]/g, '_');
            const pdfName = `Dossier_Oficial_Accidentes_${safeYear}_${new Date().toISOString().slice(0, 10)}.pdf`;
            pdf.save(pdfName);
            showToast(`Dossier oficial generado con éxito (${total} expedientes).`);
        } catch (err) {
            console.error("Error al generar Dossier PDF:", err);
            showToast("Error al generar el dossier PDF oficial", true);
        } finally {
            if (btn) {
                btn.innerHTML = originalContent;
                btn.disabled = false;
            }
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
    targetContainer.querySelector('#report-fullName').textContent = data.fullName || '---';
    targetContainer.querySelector('#report-course').textContent = data.course || '---';
    const formattedDate = data.date ? new Date(data.date).toLocaleDateString('es-ES') : '---';
    targetContainer.querySelector('#report-accident-date').textContent = formattedDate;
    targetContainer.querySelector('#report-location').textContent = data.location || '---';
    targetContainer.querySelector('#report-time').textContent = data.time || '---';
    targetContainer.querySelector('#report-severity').textContent = data.severity || '---';
    
    const yearEl = targetContainer.querySelector('#report-schoolYear');
    if (yearEl) {
        yearEl.textContent = data.schoolYear || getSchoolYear(data.date);
    }

    targetContainer.querySelector('#report-description').textContent = data.description || '---';
    targetContainer.querySelector('#report-actionTaken').textContent = data.actionTaken || '---';
    targetContainer.querySelector('#report-parentsCalled').textContent = data.parentsCalled || '---';
    targetContainer.querySelector('#report-emergencyCalled').textContent = data.emergencyCalled || '---';

    const sigs = targetContainer.querySelector('#report-signatures-container');
    if (sigs) {
        sigs.innerHTML = '';

        if (data.interveners && Array.isArray(data.interveners)) {
            data.interveners.forEach(int => {
                if (int && int.signature) {
                    sigs.innerHTML += `
                        <div class="signature-card">
                            <div class="signature-space">
                                <img src="${int.signature}" class="signature-img" alt="Firma ${int.name || 'Interviniente'}">
                            </div>
                            <div class="signature-meta">Interviniente: ${int.name || '---'}</div>
                        </div>
                    `;
                }
            });
        }

        const coordName = localStorage.getItem('coordinatorName') || APP_CONFIG.COORDINATOR_NAME;
        if (data.coordinatorSignature) {
            sigs.innerHTML += `
                <div class="signature-card">
                    <div class="signature-space">
                        <img src="${data.coordinatorSignature}" class="signature-img" alt="Firma Coordinación">
                    </div>
                    <div class="signature-meta">Coordinación: ${coordName}</div>
                </div>
            `;
        }
    }

    // Actualizar nombre de centro educativo en el informe
    const currentSchool = localStorage.getItem('schoolName') || APP_CONFIG.DEFAULT_SCHOOL;
    targetContainer.querySelectorAll('.school-name-text').forEach(el => el.textContent = currentSchool);
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
