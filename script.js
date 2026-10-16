(() => {
  "use strict";

  const STORAGE_KEY = "absenku.prototype.v1";
  const ADMIN_USERNAME = "MASUK GURU";
  const ADMIN_PASSWORD = "GURU AJA";
  const SCHOOL_NAME = "SMK MANBAUL ULUM CIREBON";
  const DEFAULT_SETTINGS = { cutoffTime: "07:00", soundEnabled: false };
  const ATTENDANCE_LABELS = {
    present: "Hadir",
    late: "Terlambat",
    permission: "Izin",
    sick: "Sakit",
    absent: "Alfa"
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  let state = loadState();
  let cameraStream = null;
  let scanTimer = null;
  let scanBusy = false;
  let lastScanCode = "";
  let lastScanAt = 0;
  let currentPhoto = "";
  let toastTimer = 0;

  function loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return { admin: null, students: [], attendance: [], audit: [], settings: { ...DEFAULT_SETTINGS } };
      const parsed = JSON.parse(stored);
      return {
        admin: parsed.admin || null,
        students: Array.isArray(parsed.students) ? parsed.students : [],
        attendance: Array.isArray(parsed.attendance) ? parsed.attendance : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit : [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
      };
    } catch (error) {
      console.error("Gagal membaca data AbsenKu dari browser.", error);
      return { admin: null, students: [], attendance: [], audit: [], settings: { ...DEFAULT_SETTINGS } };
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      console.error("Gagal menyimpan data AbsenKu.", error);
      showToast("Data tidak dapat disimpan. Periksa ruang penyimpanan browser.", true);
      return false;
    }
  }

  function showToast(message, isError = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3600);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function localDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function displayDate(dateString) {
    if (!dateString) return "—";
    return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${dateString}T00:00:00`));
  }

  function formatTime(date = new Date()) {
    return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  }

  function escapeForSvg(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
    })[character]);
  }

  function placeholderAvatar(name = "Siswa") {
    const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase() || "S";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="144" viewBox="0 0 120 144"><rect width="120" height="144" rx="16" fill="#eaf0f8"/><circle cx="60" cy="51" r="25" fill="#b7c7dc"/><path d="M18 136c2-29 17-43 42-43s40 14 42 43" fill="#b7c7dc"/><text x="60" y="137" text-anchor="middle" font-family="Arial" font-size="12" font-weight="700" fill="#24456f">${escapeForSvg(initials)}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function studentById(id) {
    return state.students.find(student => student.id === id);
  }

  function todayAttendance(studentId, date = localDate()) {
    return state.attendance.find(record => record.studentId === studentId && record.date === date);
  }

  function attendanceClass(status) {
    return `badge-${status}`;
  }

  async function hashPassword(password, saltText) {
    if (!window.crypto?.subtle) throw new Error("Browser harus dijalankan melalui localhost/HTTPS agar keamanan kata sandi tersedia.");
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(saltText), iterations: 120000, hash: "SHA-256" }, key, 256);
    return [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function randomToken() {
    if (crypto.randomUUID) return crypto.randomUUID().replaceAll("-", "");
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function uniqueStudentValue(reserved = "") {
    let value;
    do {
      value = randomToken();
    } while (value === reserved || state.students.some(student => student.id === value || student.token === value));
    return value;
  }

  async function handleAuth(event) {
    event.preventDefault();
    const username = $("#authUsername").value.trim();
    const password = $("#authPassword").value;
    if (!username || !password) {
      showToast("Username dan kata sandi wajib diisi.", true);
      return;
    }
    try {
      if (!state.admin) {
        if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
          showToast("Pendaftaran admin awal harus menggunakan kredensial admin sekolah yang telah ditentukan.", true);
          return;
        }
        const salt = randomToken();
        const passwordHash = await hashPassword(password, salt);
        state.admin = { username, salt, passwordHash };
        if (!saveState()) {
          state.admin = null;
          return;
        }
        sessionStorage.setItem("absenku.admin-session", "active");
        showApp();
        showToast("Admin berhasil didaftarkan. Ganti kredensial default sebelum penggunaan nyata.");
        return;
      }
      const submittedHash = await hashPassword(password, state.admin.salt);
      if (username !== state.admin.username || submittedHash !== state.admin.passwordHash) {
        showToast("Username atau kata sandi salah.", true);
        return;
      }
      sessionStorage.setItem("absenku.admin-session", "active");
      showApp();
      showToast("Berhasil masuk.");
    } catch (error) {
      console.error("Autentikasi admin gagal.", error);
      showToast(error.message || "Autentikasi gagal. Coba lagi.", true);
    }
  }

  function showAuth() {
    stopCamera();
    $("#authView").classList.remove("hidden");
    $("#appView").classList.add("hidden");
    const setup = !state.admin;
    $("#setupNotice").classList.toggle("hidden", !setup);
    $("#authSubmit").textContent = setup ? "Daftarkan admin & masuk" : "Masuk ke dashboard";
    $("#authHint").textContent = setup
      ? 'Untuk pendaftaran admin awal, masukkan username "MASUK GURU" dan kata sandi "GURU AJA".'
      : "Akses hanya untuk admin yang terdaftar.";
    $("#authUsername").value = "";
    $("#authPassword").value = "";
  }

  function showApp() {
    $("#authView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    $("#adminName").textContent = state.admin?.username || ADMIN_USERNAME;
    renderAll();
    showPage("dashboard");
  }

  function showPage(page) {
    $$(".page-section").forEach(section => section.classList.toggle("active", section.id === `page-${page}`));
    $$("[data-page]").forEach(link => link.classList.toggle("active", link.dataset.page === page));
    if (page !== "camera") stopCamera();
    if (page === "camera") {
      $("#scanMessage").textContent = "";
      $("#scanMessage").className = "scan-message";
    }
  }

  function signOut() {
    sessionStorage.removeItem("absenku.admin-session");
    showAuth();
  }

  function renderAll() {
    updateLiveClock();
    renderDashboard();
    renderStudents();
    renderCards();
    renderSettings();
    updateReportFilters();
    renderReport();
  }

  function updateLiveClock() {
    const now = new Date();
    $("#liveDateTime").textContent = new Intl.DateTimeFormat("id-ID", {
      weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(now);
  }

  function renderDashboard() {
    const records = state.attendance.filter(record => record.date === localDate());
    const activeStudents = state.students.filter(student => student.status === "Aktif");
    const count = status => records.filter(record => record.status === status).length;
    const present = count("present") + count("late");
    const permission = count("permission");
    const sick = count("sick");
    $("#statStudents").textContent = state.students.length;
    $("#statPresent").textContent = present;
    $("#statPresentDetail").textContent = `${count("present")} hadir tepat waktu`;
    $("#statLate").textContent = count("late");
    $("#statExcused").textContent = permission + sick;
    $("#statExcusedDetail").textContent = `Izin ${permission} · Sakit ${sick}`;
    $("#statMissing").textContent = Math.max(0, activeStudents.length - records.length);
    $("#statRate").textContent = activeStudents.length ? `${Math.round((present / activeStudents.length) * 100)}%` : "0%";
    renderRecent(records);
    renderChart();
  }

  function renderRecent(records) {
    const recent = [...records].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5);
    $("#recentActivity").innerHTML = recent.length ? recent.map(record => {
      const student = studentById(record.studentId);
      if (!student) return "";
      return `<div class="activity-item"><img class="activity-avatar" src="${student.photo || placeholderAvatar(student.name)}" alt=""><div><div class="activity-name">${escapeHtml(student.name)}</div><div class="activity-meta">${escapeHtml(student.className)} · <span class="badge ${attendanceClass(record.status)}">${ATTENDANCE_LABELS[record.status] || "Tercatat"}</span></div></div><time class="activity-time">${escapeHtml(record.time)}</time></div>`;
    }).join("") : '<p class="empty-state">Belum ada pemindaian hari ini.</p>';
  }

  function renderChart() {
    const days = [];
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      const dateKey = localDate(date);
      const dayRecords = state.attendance.filter(record => record.date === dateKey);
      days.push({
        label: new Intl.DateTimeFormat("id-ID", { weekday: "short" }).format(date),
        present: dayRecords.filter(record => record.status === "present").length,
        late: dayRecords.filter(record => record.status === "late").length
      });
    }
    const max = Math.max(1, ...days.map(day => day.present + day.late));
    $("#attendanceChart").innerHTML = days.map(day => {
      const presentHeight = Math.max(day.present ? 5 : 2, (day.present / max) * 100);
      const lateHeight = Math.max(day.late ? 5 : 2, (day.late / max) * 100);
      return `<div class="chart-column"><span class="chart-count">${day.present + day.late || ""}</span><div class="chart-bars"><div class="chart-bar" style="height:${presentHeight}%"></div><div class="chart-bar late" style="height:${lateHeight}%"></div></div><span class="chart-label">${escapeHtml(day.label)}</span></div>`;
    }).join("");
  }

  function statusBadge(student) {
    return `<span class="badge ${student.status === "Aktif" ? "badge-active" : "badge-inactive"}">${escapeHtml(student.status)}</span>`;
  }

  function filteredStudents(query, className = "") {
    const normalized = query.trim().toLocaleLowerCase("id-ID");
    return state.students.filter(student => {
      const matchesQuery = !normalized || [student.name, student.nis, student.className, student.major].some(value => String(value || "").toLocaleLowerCase("id-ID").includes(normalized));
      return matchesQuery && (!className || student.className === className);
    }).sort((a, b) => a.name.localeCompare(b.name, "id"));
  }

  function renderStudents() {
    const list = filteredStudents($("#studentSearch").value, $("#classFilter").value);
    $("#studentTableBody").innerHTML = list.map(student => `
      <tr><td><div class="student-cell"><img class="student-avatar" src="${student.photo || placeholderAvatar(student.name)}" alt=""><span><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.year || "")}</small></span></div></td><td>${escapeHtml(student.nis)}</td><td>${escapeHtml(student.className)}<br><span class="muted">${escapeHtml(student.major)}</span></td><td>${statusBadge(student)}</td><td><div class="row-actions"><button class="icon-action" data-action="view" data-id="${student.id}" title="Lihat kartu" aria-label="Lihat kartu ${escapeHtml(student.name)}">▤</button><button class="icon-action" data-action="edit" data-id="${student.id}" title="Edit" aria-label="Edit ${escapeHtml(student.name)}">✎</button><button class="icon-action" data-action="status" data-id="${student.id}" title="Atur status kehadiran" aria-label="Atur kehadiran ${escapeHtml(student.name)}">◷</button><button class="icon-action" data-action="delete" data-id="${student.id}" title="Hapus" aria-label="Hapus ${escapeHtml(student.name)}">×</button></div></td></tr>`).join("");
    $("#studentEmpty").classList.toggle("hidden", list.length !== 0);
    $("#studentTableBody").classList.toggle("hidden", list.length === 0);
    updateClassFilters();
  }

  function updateClassFilters() {
    const classes = [...new Set(state.students.map(student => student.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, "id"));
    const select = $("#classFilter");
    const selected = select.value;
    select.innerHTML = '<option value="">Semua kelas</option>' + classes.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    if (classes.includes(selected)) select.value = selected;
  }

  function qrMarkup(student, suffix = "") {
    const qrId = `qr-${student.id}-${suffix}`;
    return `<div class="qr-box" id="${qrId}" data-qr-value="absenku:v1:${student.token}"></div>`;
  }

  function cardMarkup(student, suffix = "") {
    const image = student.photo || placeholderAvatar(student.name);
    return `<article class="student-card" data-student-card="${student.id}">
      <header class="id-card-head"><span class="brand-mark">MU</span><div class="id-school">KARTU PELAJAR<small>${SCHOOL_NAME}</small></div></header>
      <div class="id-card-body"><img class="id-photo" src="${image}" alt="Foto ${escapeHtml(student.name)}"><div class="id-details"><strong>${escapeHtml(student.name)}</strong><p><b>NIS</b> ${escapeHtml(student.nis)}</p><p><b>Kelas</b> ${escapeHtml(student.className)}</p><p><b>Jurusan</b> ${escapeHtml(student.major)}</p></div>${qrMarkup(student, suffix)}</div>
      <footer class="id-card-foot"><span>Tahun ajaran ${escapeHtml(student.year)}</span><span>SMK Manbaul Ulum</span></footer>
    </article>`;
  }

  function createQrCodes(root = document) {
    if (typeof window.QRCode !== "function") {
      showToast("Pustaka QR tidak tersedia. Periksa koneksi internet lalu muat ulang halaman.", true);
      return;
    }
    $$(".qr-box", root).forEach(element => {
      element.replaceChildren();
      new QRCode(element, { text: element.dataset.qrValue, width: 76, height: 76, colorDark: "#14284a", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    });
  }

  function renderCards() {
    const list = filteredStudents($("#cardSearch").value).filter(student => student.status === "Aktif");
    $("#cardGrid").innerHTML = list.length ? list.map(student => `<div>${cardMarkup(student, "grid")}<div class="card-tile-actions"><button class="button button-secondary" data-card-action="view" data-id="${student.id}">Lihat Kartu</button><button class="button button-secondary" data-card-action="print" data-id="${student.id}">Cetak</button><button class="button button-primary" data-card-action="download" data-id="${student.id}">Unduh</button></div></div>`).join("") : '<p class="empty-state">Belum ada siswa aktif untuk dibuatkan kartu.</p>';
    createQrCodes($("#cardGrid"));
  }

  function openCard(studentId) {
    const student = studentById(studentId);
    if (!student) return;
    $("#cardDialogTitle").textContent = student.name;
    $("#cardPreviewHost").innerHTML = cardMarkup(student, "preview");
    $("#cardDialog").dataset.studentId = student.id;
    createQrCodes($("#cardPreviewHost"));
    $("#cardDialog").showModal();
  }

  function openStudentForm(student = null) {
    const form = $("#studentForm");
    form.reset();
    currentPhoto = student?.photo || "";
    $("#studentId").value = student?.id || "";
    $("#studentDialogTitle").textContent = student ? "Edit siswa" : "Tambah siswa";
    $("#studentNis").value = student?.nis || "";
    $("#studentName").value = student?.name || "";
    $("#studentClass").value = student?.className || "";
    $("#studentMajor").value = student?.major || "";
    $("#studentGender").value = student?.gender || "";
    $("#studentYear").value = student?.year || defaultAcademicYear();
    $("#studentStatus").value = student?.status || "Aktif";
    renderPhotoPreview();
    $("#studentDialog").showModal();
  }

  function defaultAcademicYear() {
    const now = new Date();
    const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    return `${start}/${start + 1}`;
  }

  function renderPhotoPreview() {
    const preview = $("#photoPreview");
    if (!currentPhoto) {
      preview.classList.add("hidden");
      preview.replaceChildren();
      return;
    }
    preview.classList.remove("hidden");
    preview.innerHTML = `<img src="${currentPhoto}" alt="Pratinjau foto siswa">`;
  }

  async function compressPhoto(file) {
    if (!file.type.startsWith("image/")) throw new Error("Pilih berkas gambar yang valid.");
    const imageUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = imageUrl;
      await image.decode();
      const scale = Math.min(1, 600 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.78);
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  }

  async function handlePhotoChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      currentPhoto = await compressPhoto(file);
      renderPhotoPreview();
    } catch (error) {
      console.error("Foto siswa gagal diproses.", error);
      showToast(error.message || "Foto gagal diproses.", true);
      event.target.value = "";
    }
  }

  function handleStudentSave(event) {
    event.preventDefault();
    const id = $("#studentId").value;
    const nis = $("#studentNis").value.trim();
    const existing = state.students.find(student => student.nis.toLocaleLowerCase("id-ID") === nis.toLocaleLowerCase("id-ID") && student.id !== id);
    if (existing) {
      showToast("NIS tersebut sudah digunakan siswa lain.", true);
      $("#studentNis").focus();
      return;
    }
    const name = $("#studentName").value.trim();
    const className = $("#studentClass").value.trim();
    const major = $("#studentMajor").value.trim();
    if (!nis || !name || !className || !major) {
      showToast("Lengkapi NIS, nama, kelas, dan jurusan.", true);
      return;
    }
    const previous = id ? studentById(id) : null;
    const studentId = previous?.id || uniqueStudentValue();
    const studentToken = previous?.token || uniqueStudentValue(studentId);
    const student = {
      id: studentId,
      token: studentToken,
      nis, name, className, major,
      gender: $("#studentGender").value,
      year: $("#studentYear").value.trim(),
      status: $("#studentStatus").value,
      photo: currentPhoto
    };
    if (previous) state.students = state.students.map(item => item.id === id ? student : item);
    else state.students.push(student);
    if (!saveState()) return;
    $("#studentDialog").close();
    renderAll();
    showToast(previous ? "Data siswa berhasil diperbarui." : "Siswa berhasil didaftarkan dan kartu QR dibuat.");
  }

  function confirmAction(title, message, buttonText = "Ya, lanjutkan") {
    const dialog = $("#confirmDialog");
    $("#confirmTitle").textContent = title;
    $("#confirmMessage").textContent = message;
    $("#confirmAccept").textContent = buttonText;
    dialog.showModal();
    return new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    });
  }

  async function deleteStudent(studentId) {
    const student = studentById(studentId);
    if (!student) return;
    const confirmed = await confirmAction("Hapus data siswa?", `Data ${student.name}, kartu, dan riwayat absensinya akan dihapus dari browser ini. Tindakan ini tidak dapat dibatalkan.`, "Hapus siswa");
    if (!confirmed) return;
    state.students = state.students.filter(item => item.id !== studentId);
    state.attendance = state.attendance.filter(record => record.studentId !== studentId);
    state.audit.push({ at: new Date().toISOString(), action: "hapus_siswa", studentId, reason: "Dihapus oleh admin" });
    if (!saveState()) return;
    renderAll();
    showToast("Data siswa dan riwayatnya telah dihapus.");
  }

  function adminSetAttendance(studentId) {
    const student = studentById(studentId);
    if (!student) return;
    const statusText = window.prompt(`Status untuk ${student.name}: masukkan Hadir, Terlambat, Izin, Sakit, atau Alfa.`);
    if (statusText === null) return;
    const statusMap = Object.fromEntries(Object.entries(ATTENDANCE_LABELS).map(([key, value]) => [value.toLocaleLowerCase("id-ID"), key]));
    const status = statusMap[statusText.trim().toLocaleLowerCase("id-ID")];
    if (!status) {
      showToast("Status tidak valid. Tidak ada perubahan yang disimpan.", true);
      return;
    }
    const reason = window.prompt("Tuliskan alasan/keterangan admin untuk perubahan status ini:");
    if (!reason?.trim()) {
      showToast("Alasan wajib diisi. Tidak ada perubahan yang disimpan.", true);
      return;
    }
    const date = localDate();
    const record = todayAttendance(studentId, date);
    const now = new Date();
    const updated = {
      studentId, date, time: record?.time || formatTime(now), timestamp: record?.timestamp || now.toISOString(),
      status, source: "admin", note: reason.trim()
    };
    if (record) state.attendance = state.attendance.map(item => item === record ? updated : item);
    else state.attendance.push(updated);
    state.audit.push({ at: now.toISOString(), action: "koreksi_absensi", studentId, status, reason: reason.trim() });
    if (!saveState()) return;
    renderAll();
    showToast(`Status ${student.name} diperbarui admin: ${ATTENDANCE_LABELS[status]}.`);
  }

  function attendanceForScan(student) {
    const now = new Date();
    const date = localDate(now);
    const time = formatTime(now);
    const status = time.slice(0, 5) < state.settings.cutoffTime ? "present" : "late";
    const record = { studentId: student.id, date, time, timestamp: now.toISOString(), status, source: "scan" };
    state.attendance.push(record);
    if (!saveState()) {
      state.attendance.pop();
      return null;
    }
    return record;
  }

  function setScanMessage(message, type) {
    const element = $("#scanMessage");
    element.textContent = message;
    element.className = `scan-message ${type || ""}`;
  }

  function showScanResult(student, record, duplicate = false) {
    const status = record?.status || "present";
    $("#scanResult").className = "";
    $("#scanResult").innerHTML = `<div class="scan-person"><img src="${student.photo || placeholderAvatar(student.name)}" alt="Foto ${escapeHtml(student.name)}"><h3>${escapeHtml(student.name)}</h3><p>NIS ${escapeHtml(student.nis)}</p><p>${escapeHtml(student.className)} · ${escapeHtml(student.major)}</p><span class="scan-status-large">${duplicate ? "Sudah tercatat hari ini" : ATTENDANCE_LABELS[status]}</span><p>${escapeHtml(record?.date ? `${displayDate(record.date)} · ${record.time}` : "")}</p></div>`;
  }

  async function acceptQrValue(value) {
    const prefix = "absenku:v1:";
    if (!value.startsWith(prefix) || value.length <= prefix.length || value.length > 100) {
      setScanMessage("QR tidak valid atau bukan kartu AbsenKu.", "error");
      return;
    }
    const token = value.slice(prefix.length);
    const student = state.students.find(item => item.token === token);
    if (!student || student.status !== "Aktif") {
      setScanMessage("Kartu tidak dikenal atau status siswa tidak aktif.", "error");
      return;
    }
    showScanResult(student, todayAttendance(student.id));
    if (todayAttendance(student.id)) {
      const existing = todayAttendance(student.id);
      setScanMessage("Siswa sudah memiliki catatan kehadiran hari ini.", "error");
      $("#scanMessage").append(" ");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = "Koreksi admin";
      button.addEventListener("click", () => adminSetAttendance(student.id));
      $("#scanMessage").append(button);
      showScanResult(student, existing, true);
      return;
    }
    const record = attendanceForScan(student);
    if (!record) {
      setScanMessage("Absensi gagal disimpan. Coba lagi atau hubungi admin.", "error");
      return;
    }
    renderDashboard();
    renderReport();
    showScanResult(student, record);
    setScanMessage("ABSENSI BERHASIL", "success");
    if (state.settings.soundEnabled) playNotification();
  }

  function playNotification() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Audio tidak didukung browser ini.");
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.07;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.16);
      oscillator.onended = () => context.close();
    } catch (error) {
      console.warn("Suara notifikasi tidak tersedia.", error);
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast("Kamera tidak tersedia. Buka website melalui localhost atau HTTPS pada browser yang mendukung kamera.", true);
      $("#cameraStatus").textContent = "Kamera tidak didukung";
      return;
    }
    if (typeof window.jsQR !== "function") {
      showToast("Pustaka pemindai QR gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.", true);
      $("#cameraStatus").textContent = "Pemindai QR tidak tersedia";
      return;
    }
    stopCamera();
    $("#cameraStatus").textContent = "Meminta izin kamera…";
    try {
      const selectedId = $("#cameraSelect").value;
      const constraints = { audio: false, video: selectedId ? { deviceId: { exact: selectedId } } : { facingMode: { ideal: "environment" } } };
      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      const video = $("#cameraVideo");
      video.srcObject = cameraStream;
      await video.play();
      $("#cameraPlaceholder").classList.add("hidden");
      $(".scan-frame").style.display = "block";
      $("#cameraStatus").textContent = "Kamera aktif · arahkan QR ke bingkai";
      $("#startScanButton").disabled = true;
      $("#stopScanButton").disabled = false;
      await loadCameraOptions();
      scanTimer = window.setInterval(scanVideoFrame, 250);
    } catch (error) {
      console.error("Kamera gagal dibuka.", error);
      const message = error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
        ? "Izin kamera ditolak. Izinkan kamera di pengaturan situs lalu coba lagi."
        : error.name === "NotFoundError" || error.name === "DevicesNotFoundError"
          ? "Kamera tidak ditemukan pada perangkat ini."
          : error.name === "NotReadableError"
            ? "Kamera sedang digunakan aplikasi lain atau tidak dapat dibuka."
            : "Kamera gagal dibuka. Pastikan halaman memakai HTTPS atau localhost.";
      $("#cameraStatus").textContent = "Kamera tidak aktif";
      showToast(message, true);
      stopCamera();
    }
  }

  async function loadCameraOptions() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const current = $("#cameraSelect").value;
      const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
      $("#cameraSelect").innerHTML = '<option value="">Kamera otomatis</option>' + cameras.map((camera, index) => `<option value="${escapeHtml(camera.deviceId)}">${escapeHtml(camera.label || `Kamera ${index + 1}`)}</option>`).join("");
      if (cameras.some(camera => camera.deviceId === current)) $("#cameraSelect").value = current;
    } catch (error) {
      console.warn("Daftar kamera tidak dapat dibaca.", error);
    }
  }

  function scanVideoFrame() {
    const video = $("#cameraVideo");
    if (scanBusy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || typeof window.jsQR !== "function") return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    const canvas = scanVideoFrame.canvas || (scanVideoFrame.canvas = document.createElement("canvas"));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    const result = window.jsQR(imageData.data, width, height, { inversionAttempts: "dontInvert" });
    if (!result?.data) return;
    const now = Date.now();
    if (result.data === lastScanCode && now - lastScanAt < 4000) return;
    lastScanCode = result.data;
    lastScanAt = now;
    scanBusy = true;
    acceptQrValue(result.data).catch(error => {
      console.error("QR gagal diproses.", error);
      setScanMessage("Terjadi kesalahan saat memproses QR.", "error");
    }).finally(() => {
      window.setTimeout(() => { scanBusy = false; }, 1600);
    });
  }

  function stopCamera() {
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = null;
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    const video = $("#cameraVideo");
    if (video) video.srcObject = null;
    if ($("#cameraPlaceholder")) $("#cameraPlaceholder").classList.remove("hidden");
    if ($(".scan-frame")) $(".scan-frame").style.display = "none";
    if ($("#startScanButton")) $("#startScanButton").disabled = false;
    if ($("#stopScanButton")) $("#stopScanButton").disabled = true;
    if ($("#cameraStatus")) $("#cameraStatus").textContent = "Kamera belum aktif";
  }

  async function changeCamera() {
    if (!cameraStream) return;
    await startCamera();
  }

  function renderSettings() {
    $("#cutoffTime").value = state.settings.cutoffTime;
    $("#soundEnabled").checked = Boolean(state.settings.soundEnabled);
  }

  async function markMissingAsAbsent() {
    const missing = state.students.filter(student => student.status === "Aktif" && !todayAttendance(student.id));
    if (!missing.length) {
      showToast("Tidak ada siswa aktif tanpa status kehadiran hari ini.");
      return;
    }
    const confirmed = await confirmAction("Tutup periode absensi?", `${missing.length} siswa aktif yang belum tercatat akan ditetapkan Alfa untuk hari ini. Pastikan periode absensi telah berakhir.`, "Tetapkan Alfa");
    if (!confirmed) return;
    const now = new Date();
    const date = localDate(now);
    for (const student of missing) state.attendance.push({ studentId: student.id, date, time: "—", timestamp: now.toISOString(), status: "absent", source: "admin", note: "Periode absensi ditutup oleh admin" });
    state.audit.push({ at: now.toISOString(), action: "tutup_absensi_alfa", reason: `${missing.length} siswa ditetapkan Alfa` });
    if (!saveState()) return;
    renderAll();
    showToast(`${missing.length} siswa ditetapkan Alfa dengan tindakan admin.`);
  }

  function updateReportFilters() {
    const reportClass = $("#reportClass");
    const selectedClass = reportClass.value;
    const classes = [...new Set(state.students.map(student => student.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, "id"));
    reportClass.innerHTML = '<option value="">Semua kelas</option>' + classes.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    if (classes.includes(selectedClass)) reportClass.value = selectedClass;
    const studentSelect = $("#reportStudent");
    const selectedStudent = studentSelect.value;
    studentSelect.innerHTML = '<option value="">Semua siswa</option>' + [...state.students].sort((a, b) => a.name.localeCompare(b.name, "id")).map(student => `<option value="${student.id}">${escapeHtml(student.name)} · ${escapeHtml(student.nis)}</option>`).join("");
    if (state.students.some(student => student.id === selectedStudent)) studentSelect.value = selectedStudent;
    if (!$("#reportDate").value) $("#reportDate").value = localDate();
    if (!$("#reportMonth").value) $("#reportMonth").value = localDate().slice(0, 7);
    if (!$("#reportStart").value) $("#reportStart").value = localDate();
    if (!$("#reportEnd").value) $("#reportEnd").value = localDate();
  }

  function selectedPeriod() {
    const type = $("#reportType").value;
    const selectedDate = $("#reportDate").value || localDate();
    if (type === "daily") return { start: selectedDate, end: selectedDate, label: `Harian · ${displayDate(selectedDate)}` };
    if (type === "weekly") {
      const end = new Date(`${selectedDate}T00:00:00`);
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      const startString = localDate(start);
      return { start: startString, end: selectedDate, label: `Mingguan · ${displayDate(startString)} – ${displayDate(selectedDate)}` };
    }
    if (type === "monthly") {
      const month = $("#reportMonth").value || localDate().slice(0, 7);
      const [year, monthNumber] = month.split("-").map(Number);
      const start = `${month}-01`;
      const end = localDate(new Date(year, monthNumber, 0));
      return { start, end, label: `Bulanan · ${new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(new Date(`${start}T00:00:00`))}` };
    }
    const start = $("#reportStart").value;
    const end = $("#reportEnd").value;
    return { start, end, label: `Rentang tanggal · ${displayDate(start)} – ${displayDate(end)}` };
  }

  function reportData() {
    const period = selectedPeriod();
    if (!period.start || !period.end || period.start > period.end) throw new Error("Rentang tanggal laporan tidak valid.");
    const className = $("#reportClass").value;
    const studentId = $("#reportStudent").value;
    const rows = state.attendance
      .filter(record => record.date >= period.start && record.date <= period.end)
      .map(record => ({ record, student: studentById(record.studentId) }))
      .filter(item => item.student)
      .filter(({ student }) => !className || student.className === className)
      .filter(({ student }) => !studentId || student.id === studentId)
      .sort((a, b) => a.record.date.localeCompare(b.record.date) || a.student.className.localeCompare(b.student.className, "id") || a.student.name.localeCompare(b.student.name, "id"));
    const counts = Object.fromEntries(Object.keys(ATTENDANCE_LABELS).map(status => [status, rows.filter(item => item.record.status === status).length]));
    const presentRate = rows.length ? Math.round(((counts.present + counts.late) / rows.length) * 100) : 0;
    const filters = { className, studentId };
    return { ...period, rows, counts, presentRate, filters };
  }

  function renderReport() {
    if (!$("#reportTableBody")) return;
    try {
      const report = reportData();
      $("#reportPeriodLabel").textContent = `${report.label}${report.filters.className ? ` · Kelas ${report.filters.className}` : ""}${report.filters.studentId ? ` · ${studentById(report.filters.studentId)?.name || ""}` : ""}`;
      $("#reportTableBody").innerHTML = report.rows.map(({ record, student }, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(student.nis)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(student.className)}</td><td>${displayDate(record.date)}</td><td>${escapeHtml(record.time || "—")}</td><td><span class="badge ${attendanceClass(record.status)}">${ATTENDANCE_LABELS[record.status] || "—"}</span></td></tr>`).join("");
      $("#reportEmpty").classList.toggle("hidden", report.rows.length > 0);
      $("#reportTableBody").classList.toggle("hidden", report.rows.length === 0);
      $("#reportSummary").innerHTML = [
        ["Total tercatat", report.rows.length], ["Hadir", report.counts.present], ["Terlambat", report.counts.late],
        ["Izin", report.counts.permission], ["Sakit", report.counts.sick], ["Alfa", report.counts.absent]
      ].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`).join("") + `<div class="summary-item"><span>Persentase hadir</span><strong>${report.presentRate}%</strong></div>`;
    } catch (error) {
      $("#reportPeriodLabel").textContent = error.message;
      $("#reportTableBody").replaceChildren();
      $("#reportEmpty").classList.remove("hidden");
      $("#reportSummary").replaceChildren();
    }
  }

  function reportHtml(report) {
    const rows = report.rows.map(({ record, student }, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(student.nis)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(student.className)}</td><td>${displayDate(record.date)}</td><td>${escapeHtml(record.time || "—")}</td><td>${ATTENDANCE_LABELS[record.status] || "—"}</td></tr>`).join("");
    return `<div class="preview-report-heading"><span class="report-emblem">MU</span><strong>${SCHOOL_NAME}</strong><strong>LAPORAN ABSENSI SISWA</strong><small>${escapeHtml(report.label)}${report.filters.className ? ` · Kelas ${escapeHtml(report.filters.className)}` : ""}</small></div><table><thead><tr><th>No</th><th>NIS</th><th>Nama siswa</th><th>Kelas</th><th>Tanggal</th><th>Jam masuk</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="7">Tidak ada data absensi dalam periode ini.</td></tr>'}</tbody></table><p class="preview-summary"><strong>Ringkasan:</strong> Hadir ${report.counts.present} · Terlambat ${report.counts.late} · Izin ${report.counts.permission} · Sakit ${report.counts.sick} · Alfa ${report.counts.absent} · Persentase hadir ${report.presentRate}%</p><p class="preview-summary">Petugas: ____________________ &nbsp;&nbsp; Kepala sekolah: ____________________</p>`;
  }

  function previewReport() {
    try {
      const report = reportData();
      $("#reportPreviewHost").innerHTML = reportHtml(report);
      $("#previewDialog").showModal();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function makePdf(report) {
    if (!window.jspdf?.jsPDF) throw new Error("Pustaka PDF tidak tersedia. Periksa koneksi internet lalu muat ulang halaman.");
    const doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setFillColor(23, 65, 120);
    doc.roundedRect(14, 8, 13, 13, 2, 2, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.text("MU", 20.5, 16, { align: "center" });
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(13);
    doc.text(SCHOOL_NAME, 148.5, 14, { align: "center" });
    doc.setFontSize(12);
    doc.text("LAPORAN ABSENSI SISWA", 148.5, 21, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const classLabel = report.filters.className ? ` · Kelas ${report.filters.className}` : " · Seluruh kelas";
    const studentName = report.filters.studentId ? ` · Siswa ${studentById(report.filters.studentId)?.name || ""}` : "";
    doc.text(`${report.label}${classLabel}${studentName}`, 148.5, 27, { align: "center" });
    const rows = report.rows.map(({ record, student }, index) => [
      String(index + 1), student.nis, student.name, student.className, record.date, record.time || "—", ATTENDANCE_LABELS[record.status] || "—"
    ]);
    if (typeof doc.autoTable !== "function") throw new Error("Plugin tabel PDF tidak tersedia. Periksa koneksi internet lalu muat ulang halaman.");
    doc.autoTable({
      startY: 33,
      head: [["No", "NIS", "Nama siswa", "Kelas", "Tanggal", "Jam masuk", "Status kehadiran"]],
      body: rows.length ? rows : [["—", "—", "Tidak ada data absensi", "—", "—", "—", "—"]],
      theme: "grid",
      styles: { font: "helvetica", fontSize: 8, cellPadding: 2.4, overflow: "linebreak" },
      headStyles: { fillColor: [16, 40, 75], textColor: [255, 255, 255] },
      columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 27 }, 2: { cellWidth: 75 }, 3: { cellWidth: 32 }, 4: { cellWidth: 28 }, 5: { cellWidth: 24 }, 6: { cellWidth: 38 } },
      margin: { left: 14, right: 14, bottom: 18 },
      didDrawPage: () => {
        const pageHeight = doc.internal.pageSize.getHeight();
        const pageNumber = doc.internal.getNumberOfPages();
        doc.setFontSize(8);
        doc.text("Petugas: ____________________       Kepala sekolah: ____________________", 14, pageHeight - 8);
        doc.text(`Halaman ${pageNumber}`, doc.internal.pageSize.getWidth() - 14, pageHeight - 8, { align: "right" });
      }
    });
    const finalY = doc.lastAutoTable.finalY || 33;
    const pageHeight = doc.internal.pageSize.getHeight();
    if (finalY + 28 < pageHeight - 18) {
      doc.setFontSize(9);
      doc.text(`Ringkasan: Hadir ${report.counts.present} · Terlambat ${report.counts.late} · Izin ${report.counts.permission} · Sakit ${report.counts.sick} · Alfa ${report.counts.absent} · Persentase hadir ${report.presentRate}%`, 14, finalY + 8);
    } else {
      doc.addPage();
      doc.setFontSize(9);
      doc.text(`Ringkasan: Hadir ${report.counts.present} · Terlambat ${report.counts.late} · Izin ${report.counts.permission} · Sakit ${report.counts.sick} · Alfa ${report.counts.absent} · Persentase hadir ${report.presentRate}%`, 14, 18);
    }
    return doc;
  }

  function pdfAction(action) {
    try {
      const pdf = makePdf(reportData());
      const name = `AbsenKu-rekap-${localDate()}.pdf`;
      if (action === "download") pdf.save(name);
      else {
        const blob = pdf.output("blob");
        const url = URL.createObjectURL(blob);
        const printWindow = window.open(url, "_blank");
        if (!printWindow) {
          URL.revokeObjectURL(url);
          showToast("Popup diblokir. Izinkan popup agar laporan PDF dapat dibuka dan dicetak.", true);
          return;
        }
        printWindow.addEventListener("load", () => printWindow.print(), { once: true });
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (error) {
      console.error("Pembuatan PDF gagal.", error);
      showToast(error.message || "PDF gagal dibuat.", true);
    }
  }

  function exportCsv() {
    try {
      const report = reportData();
      const rows = [
        [SCHOOL_NAME], ["Laporan absensi", report.label], ["Kelas", report.filters.className || "Semua kelas"],
        ["No", "NIS", "Nama siswa", "Kelas", "Tanggal", "Jam masuk", "Status kehadiran"],
        ...report.rows.map(({ record, student }, index) => [index + 1, student.nis, student.name, student.className, record.date, record.time || "—", ATTENDANCE_LABELS[record.status] || "—"]),
        [], ["Ringkasan", "Hadir", report.counts.present, "Terlambat", report.counts.late, "Izin", report.counts.permission, "Sakit", report.counts.sick, "Alfa", report.counts.absent, "Persentase hadir", `${report.presentRate}%`]
      ];
      const csv = "\uFEFF" + rows.map(row => row.map(value => {
        const text = String(value ?? "");
        const safeText = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
        return `"${safeText.replaceAll('"', '""')}"`;
      }).join(",")).join("\r\n");
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `AbsenKu-rekap-${localDate()}.csv`);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function roundedRect(context, x, y, width, height, radius, fill) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    context.fillStyle = fill;
    context.fill();
  }

  async function drawCardToCanvas(student) {
    const qr = $(`#qr-${student.id}-preview`) || $(`#qr-${student.id}-grid`);
    let qrImage = null;
    if (qr) {
      const qrSource = qr.querySelector("canvas")?.toDataURL("image/png") || qr.querySelector("img")?.src;
      if (qrSource) {
        qrImage = new Image();
        qrImage.src = qrSource;
        await qrImage.decode();
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = 1011;
    canvas.height = 638;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    roundedRect(context, 0, 0, canvas.width, 142, 25, "#10284b");
    roundedRect(context, 34, 30, 79, 79, 20, "#ffffff");
    context.fillStyle = "#174178";
    context.font = "800 27px Arial";
    context.textAlign = "center";
    context.fillText("MU", 73, 79);
    context.textAlign = "left";
    context.fillStyle = "#ffffff";
    context.font = "700 27px Arial";
    context.fillText("KARTU PELAJAR", 137, 66);
    context.font = "500 19px Arial";
    context.fillText(SCHOOL_NAME, 137, 99);
    const photo = new Image();
    photo.src = student.photo || placeholderAvatar(student.name);
    await photo.decode();
    roundedRect(context, 38, 181, 206, 302, 18, "#edf2f9");
    context.save();
    context.beginPath();
    context.roundRect(38, 181, 206, 302, 18);
    context.clip();
    context.drawImage(photo, 38, 181, 206, 302);
    context.restore();
    const x = 280;
    context.fillStyle = "#17263d";
    context.textAlign = "left";
    context.font = "700 34px Arial";
    context.fillText(student.name.slice(0, 25), x, 220);
    context.font = "500 23px Arial";
    [["NIS", student.nis], ["Kelas", student.className], ["Jurusan", student.major]].forEach(([label, value], index) => {
      const y = 285 + index * 53;
      context.fillStyle = "#6c7a8d";
      context.fillText(label.toUpperCase(), x, y);
      context.fillStyle = "#23354f";
      context.font = "600 23px Arial";
      context.fillText(String(value).slice(0, 31), x + 130, y);
      context.font = "500 23px Arial";
    });
    if (qrImage) {
      context.fillStyle = "#fff";
      context.fillRect(796, 304, 170, 170);
      context.drawImage(qrImage, 808, 316, 146, 146);
    }
    context.fillStyle = "#738096";
    context.font = "500 18px Arial";
    context.fillText(`Tahun ajaran ${student.year}`, 38, 556);
    context.textAlign = "right";
    context.fillText("SMK Manbaul Ulum Cirebon", 969, 556);
    return canvas;
  }

  async function downloadCard(studentId) {
    const student = studentById(studentId);
    if (!student) return;
    try {
      const canvas = await drawCardToCanvas(student);
      canvas.toBlob(blob => {
        if (!blob) {
          showToast("Kartu gagal diekspor sebagai gambar.", true);
          return;
        }
        downloadBlob(blob, `Kartu-${student.nis}.png`);
      }, "image/png");
    } catch (error) {
      console.error("Kartu gagal dibuat.", error);
      showToast("Kartu gagal dibuat. Coba buka pratinjau kartu lalu ulangi.", true);
    }
  }

  async function printCard(studentId) {
    const student = studentById(studentId);
    if (!student) return;
    try {
      const canvas = await drawCardToCanvas(student);
      const imageUrl = canvas.toDataURL("image/png");
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        showToast("Popup diblokir. Izinkan popup untuk mencetak kartu.", true);
        return;
      }
      printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Kartu ${escapeHtml(student.name)}</title><style>@page{size:85.6mm 54mm;margin:0}*{box-sizing:border-box}html,body{margin:0;width:85.6mm;height:54mm}img{width:85.6mm;height:54mm;display:block}</style></head><body><img src="${imageUrl}" alt="Kartu pelajar ${escapeHtml(student.name)}"><script>window.onload=function(){window.print()}<\/script></body></html>`);
      printWindow.document.close();
    } catch (error) {
      console.error("Kartu gagal dicetak.", error);
      showToast("Kartu gagal dicetak.", true);
    }
  }

  function exportBackup() {
    const backup = { ...state, exportedAt: new Date().toISOString(), format: "absenku-prototype-v1" };
    downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }), `AbsenKu-cadangan-${localDate()}.json`);
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (backup.format !== "absenku-prototype-v1" || !Array.isArray(backup.students) || !Array.isArray(backup.attendance) || !Array.isArray(backup.audit)) {
        throw new Error("Format cadangan tidak dikenali atau datanya tidak lengkap.");
      }
      const ids = new Set();
      const tokens = new Set();
      const validStudents = backup.students.every(student => {
        if (!student.id || !student.token || !student.nis || ids.has(student.id) || tokens.has(student.token)) return false;
        ids.add(student.id);
        tokens.add(student.token);
        return true;
      });
      if (!validStudents || backup.attendance.some(record => !ids.has(record.studentId) || !ATTENDANCE_LABELS[record.status])) {
        throw new Error("Data siswa atau absensi pada berkas cadangan tidak valid.");
      }
      if (!await confirmAction("Pulihkan cadangan?", "Data lokal saat ini akan digantikan oleh isi berkas cadangan.", "Pulihkan data")) return;
      const previous = state;
      state = {
        admin: backup.admin || previous.admin,
        students: backup.students,
        attendance: backup.attendance,
        audit: backup.audit,
        settings: { ...DEFAULT_SETTINGS, ...(backup.settings || {}) }
      };
      if (!saveState()) {
        state = previous;
        return;
      }
      renderAll();
      showToast("Cadangan berhasil dipulihkan.");
    } catch (error) {
      console.error("Pemulihan cadangan gagal.", error);
      showToast(error.message || "Berkas cadangan tidak dapat dibaca.", true);
    } finally {
      event.target.value = "";
    }
  }

  async function handleSettingsSave(event) {
    event.preventDefault();
    const cutoffTime = $("#cutoffTime").value;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoffTime)) {
      showToast("Jam batas masuk tidak valid.", true);
      return;
    }
    state.settings = { cutoffTime, soundEnabled: $("#soundEnabled").checked };
    if (!saveState()) return;
    showToast("Pengaturan berhasil disimpan.");
  }

  function updateReportTypeControls() {
    const type = $("#reportType").value;
    $("#reportDateWrap").classList.toggle("hidden", type !== "daily" && type !== "weekly");
    $("#reportMonthWrap").classList.toggle("hidden", type !== "monthly");
    $("#reportStartWrap").classList.toggle("hidden", type !== "range");
    $("#reportEndWrap").classList.toggle("hidden", type !== "range");
    renderReport();
  }

  function printPreviewReport() {
    const report = reportData();
    const content = reportHtml(report);
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      showToast("Popup diblokir. Izinkan popup untuk mencetak laporan.", true);
      return;
    }
    printWindow.document.write(`<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Laporan AbsenKu</title><style>body{font:12px Arial,sans-serif;padding:20px;color:#17263d}.preview-report-heading{text-align:center;margin-bottom:18px}.preview-report-heading strong{display:block;margin:5px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd3df;padding:6px;text-align:left;font-size:10px}.preview-summary{font-size:10px;margin-top:12px}@page{size:landscape;margin:12mm}</style></head><body>${content}<script>window.onload=function(){window.print()}<\/script></body></html>`);
    printWindow.document.close();
  }

  function attachEvents() {
    $("#authForm").addEventListener("submit", handleAuth);
    $("#logoutButton").addEventListener("click", signOut);
    $$("[data-page]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault();
      if (!sessionStorage.getItem("absenku.admin-session")) {
        signOut();
        return;
      }
      showPage(button.dataset.page);
    }));
    $("#addStudentButton").addEventListener("click", () => openStudentForm());
    $("#studentForm").addEventListener("submit", handleStudentSave);
    $("#studentPhoto").addEventListener("change", handlePhotoChange);
    $("#studentSearch").addEventListener("input", renderStudents);
    $("#cardSearch").addEventListener("input", renderCards);
    $("#classFilter").addEventListener("change", renderStudents);
    $("#studentTableBody").addEventListener("click", event => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const student = studentById(button.dataset.id);
      if (!student) return;
      if (button.dataset.action === "view") openCard(student.id);
      if (button.dataset.action === "edit") openStudentForm(student);
      if (button.dataset.action === "delete") deleteStudent(student.id);
      if (button.dataset.action === "status") adminSetAttendance(student.id);
    });
    $("#cardGrid").addEventListener("click", event => {
      const button = event.target.closest("[data-card-action]");
      if (!button) return;
      if (button.dataset.cardAction === "view") openCard(button.dataset.id);
      if (button.dataset.cardAction === "print") printCard(button.dataset.id);
      if (button.dataset.cardAction === "download") downloadCard(button.dataset.id);
    });
    $$("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
    $("#startScanButton").addEventListener("click", startCamera);
    $("#stopScanButton").addEventListener("click", stopCamera);
    $("#cameraSelect").addEventListener("change", changeCamera);
    $("#settingsForm").addEventListener("submit", handleSettingsSave);
    $("#markAbsentButton").addEventListener("click", markMissingAsAbsent);
    $("#reportType").addEventListener("change", updateReportTypeControls);
    ["reportDate", "reportMonth", "reportStart", "reportEnd", "reportClass", "reportStudent"].forEach(id => $(`#${id}`).addEventListener("change", renderReport));
    $("#previewReportButton").addEventListener("click", previewReport);
    $("#downloadPdfButton").addEventListener("click", () => pdfAction("download"));
    $("#previewDownloadButton").addEventListener("click", () => pdfAction("download"));
    $("#printReportButton").addEventListener("click", printPreviewReport);
    $("#exportCsvButton").addEventListener("click", exportCsv);
    $("#exportBackupButton").addEventListener("click", exportBackup);
    $("#importBackupInput").addEventListener("change", importBackup);
    $("#cardDialog").addEventListener("click", event => {
      if (event.target.id === "printCardButton") printCard($("#cardDialog").dataset.studentId);
      if (event.target.id === "downloadCardButton") downloadCard($("#cardDialog").dataset.studentId);
    });
    $("#studentDialog").addEventListener("close", () => { $("#studentPhoto").value = ""; });
    window.addEventListener("pagehide", stopCamera);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopCamera();
    });
  }

  attachEvents();
  updateLiveClock();
  window.setInterval(updateLiveClock, 30000);
  if (sessionStorage.getItem("absenku.admin-session") === "active" && state.admin) showApp();
  else showAuth();
})();
