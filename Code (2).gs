const APP_USERS_KEY = 'OBSERVATION_APP_USERS_V1';
const DB_SHEET_KEY = 'OBSERVATION_DB_SPREADSHEET_ID';
const ADMIN_EMAIL_KEY = 'ADMIN_APPROVAL_EMAIL';
const SESSION_PREFIX = 'OBSERVATION_SESSION_';
const SESSION_TTL_SECONDS = 21600; // ست ساعات كحد أقصى
const ACCOUNT_HEADERS = ['accountId', 'status', 'name', 'nationalId', 'phone', 'email', 'role', 'salt', 'passwordHash', 'createdAt', 'approvedAt'];

/** يعرض الواجهة عبر Google Apps Script HTML Service. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('بطاقة الملاحظة الصفية')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * التهيئة الأولى فقط: أضف FIRST_ADMIN_EMAIL و FIRST_ADMIN_PASSWORD في Script Properties،
 * ثم شغّل هذه الدالة مرة واحدة من محرر Apps Script. يحذف النظام كلمة المرور المؤقتة.
 */
function initializeFirstAdmin() {
  // استدعاء Gmail هنا يطلب تفويض مالك المشروع قبل بدء استقبال طلبات التسجيل.
  GmailApp.getRemainingDailyQuota();
  const props = PropertiesService.getScriptProperties();
  const email = normalizeEmail_(props.getProperty('FIRST_ADMIN_EMAIL'));
  const password = props.getProperty('FIRST_ADMIN_PASSWORD') || '';
  validateEmailPassword_(email, password);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getAccountsSheet_();
    if (sheet.getLastRow() > 1) throw new Error('توجد حسابات مسجلة مسبقاً؛ لم يتم إنشاء مدير إضافي.');
    const adminEmail = normalizeEmail_(props.getProperty(ADMIN_EMAIL_KEY) || email);
    if (!isValidEmail_(adminEmail)) throw new Error('بريد المدير المسؤول عن الموافقات غير صالح.');
    props.setProperty(ADMIN_EMAIL_KEY, adminEmail);
    appendAccount_(sheet, {
      accountId: Utilities.getUuid(), status: 'approved', name: 'مدير النظام', nationalId: '', phone: '',
      email: email, role: 'admin', salt: Utilities.getUuid(), passwordHash: '', createdAt: new Date().toISOString(), approvedAt: new Date().toISOString()
    }, password);
    props.deleteProperty('FIRST_ADMIN_EMAIL');
    props.deleteProperty('FIRST_ADMIN_PASSWORD');
    return { ok: true, message: 'تم إنشاء حساب المدير الأول وجدول الحسابات. أعد نشر تطبيق الويب بإصدار جديد.' };
  } finally {
    lock.releaseLock();
  }
}

/** تسجيل طلب حساب جديد؛ لا يُفعّل الحساب إلا بعد موافقة المدير. */
function registerAccount(form) {
  form = form || {};
  const name = String(form.name || '').trim().replace(/\s+/g, ' ');
  const nationalId = normalizeDigits_(form.nationalId);
  const phone = normalizePhone_(form.phone);
  const email = normalizeEmail_(form.email);
  const password = String(form.password || '');
  const role = String(form.role || '');
  if (form.consent !== true) return { ok: false, message: 'يرجى الموافقة على استخدام بيانات التسجيل قبل الإرسال.' };
  if (name.length < 2 || name.length > 100) return { ok: false, message: 'أدخل الاسم كاملاً (من حرفين إلى 100 حرف).' };
  if (!/^\d{5,20}$/.test(nationalId)) return { ok: false, message: 'رقم الهوية يجب أن يتكون من 5 إلى 20 رقماً.' };
  if (!/^\d{8,15}$/.test(phone)) return { ok: false, message: 'أدخل رقم جوال صحيحاً من 8 إلى 15 رقماً.' };
  if (!isValidEmail_(email)) return { ok: false, message: 'أدخل بريداً إلكترونياً صالحاً.' };
  if (password.length < 8 || password.length > 128) return { ok: false, message: 'كلمة المرور مطلوبة وبحد أدنى 8 أحرف.' };
  if (!['admin', 'supervisor'].includes(role)) return { ok: false, message: 'اختر الصفة المطلوبة.' };

  const props = PropertiesService.getScriptProperties();
  const adminEmail = normalizeEmail_(props.getProperty(ADMIN_EMAIL_KEY));
  if (!isValidEmail_(adminEmail)) return { ok: false, message: 'لم يُضبط بريد المدير للموافقات في Script Properties.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let request;
  try {
    const sheet = getAccountsSheet_();
    const accounts = readAccounts_(sheet);
    if (accounts.some(a => a.email === email)) return { ok: false, message: 'هذا البريد مستخدم مسبقاً أو لديه طلب قيد المراجعة.' };
    if (accounts.some(a => a.nationalId === nationalId)) return { ok: false, message: 'رقم الهوية مسجل مسبقاً.' };
    request = {
      accountId: Utilities.getUuid(), status: 'pending', name: name, nationalId: nationalId, phone: phone,
      email: email, role: role, salt: Utilities.getUuid(), passwordHash: '', createdAt: new Date().toISOString(), approvedAt: ''
    };
    appendAccount_(sheet, request, password);
  } finally {
    lock.releaseLock();
  }

  let emailSent = true;
  try {
    const appUrl = ScriptApp.getService().getUrl() || '';
    const linkLine = appUrl ? '\nافتح لوحة النظام لمراجعة الطلبات: ' + appUrl : '\nافتح تطبيق بطاقة الملاحظة الصفية لمراجعة طلبات التفعيل.';
    // لا نرسل رقم الهوية أو الجوال بالبريد؛ يراجع المدير التفاصيل بعد تسجيل الدخول.
    const body = 'ورد طلب تفعيل حساب جديد.\nالاسم: ' + request.name + '\nالبريد: ' + request.email + '\nالصفة المطلوبة: ' + roleLabel_(role) + linkLine;
    const htmlBody = '<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.9"><h2>طلب تفعيل حساب جديد</h2><p><b>الاسم:</b> ' + escapeHtml_(request.name) + '</p><p><b>البريد:</b> ' + escapeHtml_(request.email) + '</p><p><b>الصفة المطلوبة:</b> ' + escapeHtml_(roleLabel_(role)) + '</p><p>رقم الهوية والجوال لا يُرسلان بالبريد. سجّل الدخول إلى لوحة النظام للاطلاع عليهما ومراجعة الطلب.</p>' + (appUrl ? '<p><a href="' + escapeHtml_(appUrl) + '">فتح لوحة إدارة الطلبات</a></p>' : '') + '</div>';
    GmailApp.sendEmail(adminEmail, 'طلب تفعيل حساب — بطاقة الملاحظة الصفية', body, { htmlBody: htmlBody });
  } catch (e) {
    emailSent = false;
    console.error('Admin notification failed: ' + e.message);
  }
  return {
    ok: true,
    pending: true,
    emailSent: emailSent,
    message: emailSent
      ? 'تم استلام طلبك وإرسال إشعار إلى المدير. سيُفعّل الحساب بعد موافقته.'
      : 'تم استلام طلبك، لكن تعذر إرسال إشعار البريد. سيظهر الطلب للمدير عند دخوله إلى النظام.'
  };
}

/** تسجيل الدخول للحسابات التي تمت الموافقة عليها فقط. */
function loginUser(email, password, requestedRole) {
  email = normalizeEmail_(email);
  password = String(password || '');
  requestedRole = String(requestedRole || '');
  if (!isValidEmail_(email) || !password || !['admin', 'supervisor'].includes(requestedRole)) {
    return { ok: false, message: 'تحقق من البريد الإلكتروني وكلمة المرور والصفة.' };
  }
  const user = findAccountByEmail_(email);
  if (user && user.status === 'pending') return { ok: false, message: 'طلب الحساب بانتظار موافقة المدير.' };
  if (!user || user.status !== 'approved' || user.role !== requestedRole || !safeEquals_(user.passwordHash, hashPassword_(password, user.salt))) {
    return { ok: false, message: 'البريد الإلكتروني أو كلمة المرور أو الصفة غير صحيحة.' };
  }
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const publicUser = { email: user.email, role: user.role, name: user.name };
  CacheService.getScriptCache().put(SESSION_PREFIX + token, JSON.stringify(publicUser), SESSION_TTL_SECONDS);
  return { ok: true, token: token, user: publicUser };
}

/** تحقق جلسة الواجهة عند إعادة فتحها. */
function validateSession(token) {
  const user = getSessionUser_(token);
  return user ? { ok: true, user: user } : { ok: false, message: 'انتهت الجلسة؛ سجّل الدخول مرة أخرى.' };
}

function logoutUser(token) {
  if (token) CacheService.getScriptCache().remove(SESSION_PREFIX + String(token));
  return { ok: true };
}

/** إرجاع بيانات الطلبات المعلقة للمدير فقط. */
function getPendingRequests(token) {
  const actor = getSessionUser_(token);
  if (!actor || actor.role !== 'admin') throw new Error('هذه الصفحة متاحة للمدير فقط.');
  return readAccounts_(getAccountsSheet_())
    .filter(a => a.status === 'pending')
    .map(a => ({ accountId: a.accountId, name: a.name, nationalId: a.nationalId, phone: a.phone, email: a.email, role: a.role, createdAt: a.createdAt }));
}

/** قبول أو رفض طلب معلق؛ الرفض يحذف بيانات الطلب لتقليل الاحتفاظ بالبيانات الشخصية. */
function reviewSignup(token, accountId, decision) {
  const actor = getSessionUser_(token);
  if (!actor || actor.role !== 'admin') throw new Error('هذه العملية متاحة للمدير فقط.');
  if (!['approve', 'reject'].includes(String(decision))) throw new Error('قرار المراجعة غير صالح.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getAccountsSheet_();
    const last = sheet.getLastRow();
    if (last < 2) throw new Error('لم يُعثر على طلب التفعيل.');
    const ids = sheet.getRange(2, 1, last - 1, 1).getDisplayValues().flat();
    const index = ids.indexOf(String(accountId));
    if (index < 0) throw new Error('الطلب غير موجود أو تمت مراجعته.');
    const row = index + 2;
    const status = sheet.getRange(row, 2).getDisplayValue();
    if (status !== 'pending') throw new Error('تمت مراجعة هذا الطلب مسبقاً.');
    if (decision === 'approve') {
      sheet.getRange(row, 2).setValue('approved');
      sheet.getRange(row, 11).setValue(new Date().toISOString());
      SpreadsheetApp.flush();
      return { ok: true, message: 'تمت الموافقة وتفعيل الحساب.' };
    }
    sheet.deleteRow(row);
    return { ok: true, message: 'تم رفض الطلب وحذف بياناته من سجل الحسابات.' };
  } finally {
    lock.releaseLock();
  }
}

function getSessionUser_(token) {
  token = String(token || '');
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const value = CacheService.getScriptCache().get(SESSION_PREFIX + token);
  if (!value) return null;
  try {
    const session = JSON.parse(value);
    const account = findAccountByEmail_(normalizeEmail_(session.email));
    if (!account || account.status !== 'approved' || account.role !== session.role) return null;
    return { email: account.email, role: account.role, name: account.name };
  } catch (e) { return null; }
}

function getAccountsSheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(DB_SHEET_KEY);
  let spreadsheet;
  if (id) {
    try { spreadsheet = SpreadsheetApp.openById(id); }
    catch (e) { throw new Error('تعذر فتح جدول الحسابات؛ تحقق من صلاحيات حساب مالك Apps Script.'); }
  } else {
    spreadsheet = SpreadsheetApp.create('سجل حسابات بطاقة الملاحظة الصفية');
    const sheet = spreadsheet.getSheets()[0];
    sheet.setName('Accounts');
    sheet.getRange(1, 1, 1, ACCOUNT_HEADERS.length).setValues([ACCOUNT_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, ACCOUNT_HEADERS.length).setFontWeight('bold');
    sheet.setColumnWidths(1, ACCOUNT_HEADERS.length, 150);
    props.setProperty(DB_SHEET_KEY, spreadsheet.getId());
    return sheet;
  }
  let sheet = spreadsheet.getSheetByName('Accounts');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('Accounts');
    sheet.getRange(1, 1, 1, ACCOUNT_HEADERS.length).setValues([ACCOUNT_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendAccount_(sheet, account, password) {
  account.passwordHash = hashPassword_(password, account.salt);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 3, 1, 4).setNumberFormat('@');
  sheet.getRange(row, 1, 1, ACCOUNT_HEADERS.length).setValues([[
    account.accountId, account.status, account.name, account.nationalId, account.phone, account.email,
    account.role, account.salt, account.passwordHash, account.createdAt, account.approvedAt
  ]]);
  SpreadsheetApp.flush();
}

function readAccounts_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, ACCOUNT_HEADERS.length).getDisplayValues().map(r => ({
    accountId: r[0], status: r[1], name: r[2], nationalId: r[3], phone: r[4], email: normalizeEmail_(r[5]),
    role: r[6], salt: r[7], passwordHash: r[8], createdAt: r[9], approvedAt: r[10]
  }));
}

function findAccountByEmail_(email) {
  email = normalizeEmail_(email);
  return readAccounts_(getAccountsSheet_()).find(a => a.email === email) || null;
}

function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + '\u0000' + String(password), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}
function normalizeEmail_(value) { return String(value || '').trim().toLowerCase(); }
function normalizeDigits_(value) {
  return String(value || '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).replace(/\D/g, '');
}
function normalizePhone_(value) { return normalizeDigits_(value); }
function isValidEmail_(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '')); }
function validateEmailPassword_(email, password) {
  if (!isValidEmail_(email)) throw new Error('أدخل بريداً إلكترونياً صالحاً في FIRST_ADMIN_EMAIL.');
  if (String(password).length < 8) throw new Error('يجب أن تكون كلمة مرور المدير 8 أحرف على الأقل.');
}
function roleLabel_(role) { return role === 'admin' ? 'المدير' : 'المشرف'; }
function escapeHtml_(value) { return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
