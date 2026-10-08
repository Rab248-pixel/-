const APP_USERS_KEY = 'OBSERVATION_APP_USERS_V1';
const SESSION_PREFIX = 'OBSERVATION_SESSION_';
const SESSION_TTL_SECONDS = 21600; // 6 ساعات كحد أقصى في CacheService

/** يُعرض ملف HTML باسم index من تطبيق الويب. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('بطاقة الملاحظة الصفية')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * تهيئة حساب المدير الأول مرة واحدة.
 * قبل التشغيل: أضف FIRST_ADMIN_EMAIL و FIRST_ADMIN_PASSWORD إلى Script Properties.
 * تُحذف خصائص كلمة المرور بعد نجاح الإنشاء.
 */
function initializeFirstAdmin() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(APP_USERS_KEY)) {
    throw new Error('تمت تهيئة حسابات النظام مسبقاً.');
  }
  const email = normalizeEmail_(props.getProperty('FIRST_ADMIN_EMAIL'));
  const password = props.getProperty('FIRST_ADMIN_PASSWORD') || '';
  validateCredentialsInput_(email, password);
  const users = {};
  users[email] = makeUser_(email, password, 'admin');
  props.setProperty(APP_USERS_KEY, JSON.stringify(users));
  props.deleteProperty('FIRST_ADMIN_EMAIL');
  props.deleteProperty('FIRST_ADMIN_PASSWORD');
  return 'تم إنشاء حساب المدير الأول بنجاح. احذف أي بيانات اختبار مؤقتة من سجل التنفيذ.';
}

/** التحقق من بيانات الدخول وإصدار جلسة مؤقتة. */
function loginUser(email, password, requestedRole) {
  email = normalizeEmail_(email);
  password = String(password || '');
  requestedRole = String(requestedRole || '');
  if (!email || !password || !['admin', 'supervisor'].includes(requestedRole)) {
    return { ok: false, message: 'تحقق من البريد الإلكتروني وكلمة المرور ونوع الحساب.' };
  }

  const user = getUsers_()[email];
  if (!user || user.role !== requestedRole || !safeEquals_(user.passwordHash, hashPassword_(password, user.salt))) {
    return { ok: false, message: 'البريد الإلكتروني أو كلمة المرور أو نوع الحساب غير صحيح.' };
  }

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const publicUser = { email: user.email, role: user.role };
  CacheService.getScriptCache().put(SESSION_PREFIX + token, JSON.stringify(publicUser), SESSION_TTL_SECONDS);
  return { ok: true, token: token, user: publicUser };
}

/** التحقق من جلسة موجودة عند إعادة فتح الصفحة. */
function validateSession(token) {
  const user = getSessionUser_(token);
  return user ? { ok: true, user: user } : { ok: false, message: 'انتهت الجلسة؛ سجّل الدخول مرة أخرى.' };
}

/** إنهاء جلسة المستخدم الحالي. */
function logoutUser(token) {
  if (token) CacheService.getScriptCache().remove(SESSION_PREFIX + String(token));
  return { ok: true };
}

/**
 * إنشاء حساب مدير/مشرف جديد. متاحة للمدير المسجل فقط.
 * تُستدعى من واجهة الإدارة داخل الصفحة.
 */
function createManagedUser(token, email, password, role) {
  const actor = getSessionUser_(token);
  if (!actor || actor.role !== 'admin') throw new Error('هذه العملية متاحة للمدير فقط.');

  email = normalizeEmail_(email);
  password = String(password || '');
  role = String(role || '');
  validateCredentialsInput_(email, password);
  if (!['admin', 'supervisor'].includes(role)) throw new Error('نوع الحساب غير صالح.');

  const users = getUsers_();
  if (users[email]) throw new Error('هذا البريد مسجل مسبقاً.');
  users[email] = makeUser_(email, password, role);
  PropertiesService.getScriptProperties().setProperty(APP_USERS_KEY, JSON.stringify(users));
  return { ok: true, message: 'تم إنشاء الحساب بنجاح.', user: { email: email, role: role } };
}

function getSessionUser_(token) {
  token = String(token || '');
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const value = CacheService.getScriptCache().get(SESSION_PREFIX + token);
  if (!value) return null;
  try {
    const user = JSON.parse(value);
    const current = getUsers_()[normalizeEmail_(user.email)];
    if (!current || current.role !== user.role) return null;
    return { email: current.email, role: current.role };
  } catch (e) {
    return null;
  }
}

function getUsers_() {
  const value = PropertiesService.getScriptProperties().getProperty(APP_USERS_KEY);
  if (!value) return {};
  try { return JSON.parse(value) || {}; }
  catch (e) { throw new Error('تعذر قراءة سجل المستخدمين من Script Properties.'); }
}

function makeUser_(email, password, role) {
  const salt = Utilities.getUuid();
  return { email: email, role: role, salt: salt, passwordHash: hashPassword_(password, salt), createdAt: new Date().toISOString() };
}

function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + '\u0000' + String(password),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function normalizeEmail_(email) { return String(email || '').trim().toLowerCase(); }

function validateCredentialsInput_(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('أدخل بريداً إلكترونياً صالحاً.');
  if (String(password).length < 8) throw new Error('يجب أن تكون كلمة المرور 8 أحرف على الأقل.');
}

function safeEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
