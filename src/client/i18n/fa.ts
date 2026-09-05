import type { Dict } from './en.js';

/**
 * Persian.
 *
 * `const fa: Dict` is the whole enforcement: `Dict` is `Record<keyof typeof en, string>`, so
 * a missing key or a typo is a **compile error** rather than a fallback nobody notices in a
 * language they do not read. `tests/unit/i18n.test.ts` covers what the type cannot — that no
 * value is empty, and that no value that has to be translated is still the English one.
 *
 * **Numbers and identifiers stay in Latin digits in both languages** and that is deliberate
 * rather than lazy: `Intl.NumberFormat('fa-IR')` yields `۸۰۸۰` for a port, `۹۴۰` for a byte
 * count, and a commit id that is not the commit id. The operator reads these to compare them
 * with a terminal and to paste them, so Persian digits would make them worse than
 * unlocalised. The Jalali *calendar* is kept, because a date is read rather than pasted.
 * See `lib/format.ts`.
 */
const fa: Dict = {
  // ── Chrome ───────────────────────────────────────────────────────────────
  'app.name': 'پنل کنترل',
  'app.signOut': 'خروج',
  'app.signedInAs': 'وارد شده با {username}',
  'nav.overview': 'نمای کلی',
  'nav.sessions': 'نشست‌ها',
  'nav.security': 'امنیت',
  'nav.secrets': 'کلیدها',
  'nav.audit': 'گزارش رویدادها',
  'nav.skipToContent': 'پرش به محتوا',

  // ── Generic ──────────────────────────────────────────────────────────────
  'common.cancel': 'لغو',
  'common.confirm': 'تأیید',
  'common.close': 'بستن',
  'common.copy': 'کپی',
  'common.copied': 'کپی شد',
  'common.loading': 'در حال بارگذاری…',
  'common.retry': 'تلاش دوباره',
  'common.refresh': 'به‌روزرسانی',
  'common.none': 'هیچ',
  'common.never': 'هرگز',
  'common.unknown': 'نامعلوم',
  'common.yes': 'بله',
  'common.no': 'خیر',
  'common.set': 'تنظیم‌شده',
  'common.notSet': 'تنظیم نشده',
  'common.characters': '{count} نویسه',
  'common.language': 'زبان',
  'table.expand': 'نمایش جزئیات',
  'table.collapse': 'پنهان‌کردن جزئیات',
  'table.more': '{count} مورد دیگر',
  'time.exact': 'دقیقاً {local} — {utc} به وقت UTC',
  'common.english': 'English',
  'common.persian': 'فارسی',

  // ── Login ────────────────────────────────────────────────────────────────
  'login.title': 'ورود',
  'login.username': 'نام کاربری',
  'login.password': 'گذرواژه',
  'login.submit': 'ادامه',
  'login.working': 'در حال بررسی…',
  'login.slowWarning':
    'این کار می‌تواند تا سی ثانیه طول بکشد. تأخیر با هر تلاش ناموفق بیشتر می‌شود و عمدی است — همین چیزی است که جای قفل‌کردن حساب را گرفته.',
  'login.inProgress': 'یک تلاش در جریان است. هر بار فقط یکی اجرا می‌شود؛ تا پایانش صبر کنید.',
  'login.failed': 'این اطلاعات پذیرفته نشد.',
  'login.rateLimited': 'درخواست‌ها بیش از حد است. {seconds} ثانیه دیگر تلاش کنید.',

  'totp.title': 'عامل دوم',
  'totp.explain':
    'کد شش‌رقمی برنامهٔ احرازهویت را وارد کنید. کد بازیابی هم در همین فیلد وارد می‌شود.',
  'totp.code': 'کد',
  'totp.submit': 'بررسی',
  'totp.failed': 'این کد پذیرفته نشد.',
  'totp.expiresIn': 'این مرحله در {time} منقضی می‌شود.',
  'totp.expired': 'پنجرهٔ ورود پس از پنج دقیقه بسته شد. از صفحهٔ گذرواژه دوباره شروع کنید.',
  'totp.usedRecoveryCode': 'از یک کد بازیابی استفاده شد. {count} کد باقی مانده است.',

  'enroll.title': 'راه‌اندازی احرازهویت دوعاملی',
  'enroll.explain':
    'احرازهویت دوعاملی الزامی است. این کلید را به برنامهٔ احرازهویت اضافه کنید و کدی که نشان می‌دهد را وارد کنید.',
  'enroll.secret': 'کلید',
  'enroll.uri': 'یا این نشانی را در برنامهٔ احرازهویت باز کنید',
  'enroll.noQr':
    'پنل کد QR نمی‌سازد: تصویر باید از خود کلید ساخته شود، و دوربین کاری می‌کند که تایپ‌کردن هم می‌کند.',
  'enroll.verify': 'تأیید کد',

  'recovery.title': 'کدهای بازیابی',
  'recovery.explain':
    'هر کد یک‌بار و به‌جای کد برنامهٔ احرازهویت کار می‌کند. این تنها بار نمایش آن‌هاست — پنل فقط درهم‌سازی‌شان را نگه می‌دارد و نمی‌تواند دوباره نشانشان دهد.',
  'recovery.acknowledge': 'این کدها را ذخیره کردم',
  'recovery.remaining': '{count} کد بازیابی استفاده‌نشده',
  'recovery.done': 'ادامه',

  // ── Step-up ──────────────────────────────────────────────────────────────
  'stepup.title': 'تأیید هویت',
  'stepup.explain':
    'این کار به گذرواژه و یک کد تازه نیاز دارد. تأییدیه پنج دقیقه و فقط روی همین نشست معتبر است.',
  'stepup.submit': 'تأیید',
  'stepup.active': 'تأیید‌شده تا {time}',
  'stepup.failed': 'این گذرواژه یا کد پذیرفته نشد.',

  // ── Sessions ─────────────────────────────────────────────────────────────
  'sessions.title': 'نشست‌ها',
  'sessions.explain':
    'هر نشستی که می‌تواند به این پنل برسد. لغو یک نشست در همان درخواست بعدی‌اش اثر می‌گذارد — نشست‌ها روی سرور نگه داشته می‌شوند دقیقاً برای همین که لغو، فاصله‌ای نداشته باشد.',
  'sessions.current': 'همین دستگاه',
  'sessions.created': 'شروع',
  'sessions.lastSeen': 'آخرین فعالیت',
  'sessions.expires': 'انقضای بی‌کاری',
  'sessions.absolute': 'انقضای قطعی',
  'sessions.level': 'سطح',
  'sessions.levelPre': 'فقط گذرواژه',
  'sessions.levelFull': 'هر دو عامل',
  'sessions.userAgent': 'کلاینت',
  'sessions.clientSummary': '{browser} روی {platform}',
  'sessions.clientRaw': 'رشتهٔ کلاینت، دقیقاً همان‌طور که دریافت شد',
  'sessions.revoke': 'لغو',
  'sessions.revokeOthers': 'لغو همهٔ نشست‌های دیگر',
  'sessions.revoked': '{count} نشست لغو شد',
  'sessions.noIpNote':
    'ستون نشانی وجود ندارد و عمدی است: هیچ‌چیز در این پنل بر اساس نشانی کلاینت تصمیم نمی‌گیرد، پس به‌عنوان چیزی که باید به آن واکنش داد نگه داشته نمی‌شود.',

  // ── Security ─────────────────────────────────────────────────────────────
  'security.title': 'امنیت',
  'security.password.title': 'تغییر گذرواژه',
  'security.password.new': 'گذرواژهٔ جدید',
  'security.password.repeat': 'تکرار گذرواژه',
  'security.password.mismatch': 'دو مقدار یکسان نیستند.',
  'security.password.consequence':
    'همهٔ نشست‌های دیگر بی‌درنگ لغو می‌شوند. تنها دلیل تغییر گذرواژه این است که ممکن است لو رفته باشد، و تغییر روی یک دستگاه، کسی را که نگرانش هستید وارد نگه می‌داشت.',
  'security.password.submit': 'تغییر گذرواژه',
  'security.password.done': 'گذرواژه تغییر کرد. {count} نشست دیگر لغو شد.',

  'security.recovery.title': 'ساخت دوبارهٔ کدهای بازیابی',
  'security.recovery.consequence':
    'ده کد فعلی بی‌درنگ از کار می‌افتند. ده کد تازه یک‌بار نشان داده می‌شوند و هرگز دوباره.',
  'security.recovery.submit': 'ساخت دوباره',

  'security.2fa.title': 'خاموش‌کردن احرازهویت دوعاملی',
  'security.2fa.consequence':
    'گذرواژه تنها چیزی می‌شود که میان این پنل و هر کسی که نشانی‌اش را پیدا کرده باقی می‌ماند. کدهای بازیابی هم با آن از بین می‌روند. هیچ دلیلی برای این کار نیست جز رفتن به برنامهٔ احرازهویت تازه، و ثبت‌نام دوباره همان کار را بدون خاموش‌کردن انجام می‌دهد.',
  'security.2fa.submit': 'خاموش‌کردن دوعاملی',
  'security.2fa.done': 'احرازهویت دوعاملی خاموش است. از صفحهٔ ورود دوباره ثبت‌نام کنید.',

  'security.basePath.title': 'ساخت دوبارهٔ نشانی محرمانه',
  'security.basePath.consequence':
    'نشانی‌ای که الان استفاده می‌کنید از کار می‌افتد. پنل باید دوباره راه‌اندازی شود تا نشانی تازه اثر کند، و تا وقتی نشانی جدید را باز نکنید راهی برای برگشتن نیست — پنل نمی‌تواند از صفحه‌ای که دیگر ارائه نمی‌دهد آن را دوباره نشان دهد.',
  'security.basePath.submit': 'ساخت دوبارهٔ نشانی',
  'security.basePath.typeToConfirm': 'برای تأیید {word} را تایپ کنید',
  'security.basePath.newValue': 'نشانی تازه',
  'security.basePath.saveIt':
    'همین حالا و پیش از راه‌اندازی دوباره ذخیره کنید. در config/instance.json روی حجم هم نوشته شده است.',
  'security.basePath.restart': 'پنل را دوباره راه‌اندازی کنید و بعد نشانی تازه را باز کنید.',
  'security.basePath.envPinned':
    'PANEL_BASE_PATH در محیط تنظیم شده و در هر راه‌اندازی برنده است. آن را همان‌جا تغییر دهید.',

  // ── Secrets ──────────────────────────────────────────────────────────────
  'secrets.title': 'کلیدها',
  'secrets.explain':
    'رمزنگاری‌شده ذخیره می‌شوند و به‌صورت تنظیم‌شده یا تنظیم‌نشده با یک طول نشان داده می‌شوند. هرگز مقدار ماسک‌شده: چهار نویسهٔ آخر یک شناسهٔ نه‌رقمی بیشترِ آن است.',
  'secrets.scope': 'دامنه',
  'secrets.name': 'نام',
  'secrets.updated': 'به‌روزرسانی',
  'secrets.reveal': 'نمایش',
  'secrets.hide': 'پنهان‌کردن',
  'secrets.revealed': '{seconds} ثانیه دیگر دوباره پنهان می‌شود.',
  'secrets.revealWarning':
    'نمایش یک سطر در گزارش رویدادها می‌نویسد. مقدار با پنهان‌شدن از صفحه بیرون می‌رود.',
  'secrets.clipboardWarning':
    'کلیپ‌بورد بیشتر از این صفحه عمر می‌کند و هر چیزی که بتواند بچسباند می‌تواند بخواندش.',
  'secrets.set': 'تنظیم مقدار',
  'secrets.value': 'مقدار',
  'secrets.save': 'ذخیره',
  'secrets.saved': 'ذخیره شد.',
  'secrets.empty': 'هنوز هیچ کلیدی ذخیره نشده است.',

  'telegram.title': 'اعلان‌های تلگرام',
  'telegram.configured': 'تنظیم‌شده',
  'telegram.notConfigured': 'تنظیم نشده',
  'telegram.botToken': 'توکن بات',
  'telegram.chatId': 'شناسهٔ گفت‌وگو',
  'telegram.queue': 'صف',
  'telegram.queueCounts':
    '{pending} در انتظار، {sending} در حال ارسال، {sent} ارسال‌شده، {abandoned} رهاشده',
  'telegram.lastSuccess': 'آخرین تحویل',
  'telegram.lastFailure': 'آخرین خطا',
  'telegram.dropped': '{count} رویداد رد شد چون صف پر بود',
  'telegram.test': 'ارسال پیام آزمایشی',
  'telegram.testQueued': 'با شناسهٔ {id} در صف قرار گرفت. تحویل هرگز همزمان نیست.',
  'telegram.healthy': 'در حال تحویل',
  'telegram.stale': '{age} است که چیزی تحویل نشده',
  'telegram.neverDelivered': 'هرگز چیزی تحویل نشده است',
  'telegram.moreInM25': 'تنظیم بات کار M2.5 است. این صفحه فقط گزارش می‌دهد و آزمایش می‌کند.',

  // ── Audit ────────────────────────────────────────────────────────────────
  'audit.title': 'گزارش رویدادها',
  'audit.explain':
    'فقط افزودنی است و با کلیدی مشتق‌شده از کلید اصلی زنجیرهٔ درهم‌سازی دارد. هیچ مسیری در آن نمی‌نویسد و هرگز نخواهد نوشت.',
  'audit.when': 'زمان',
  'audit.event': 'رویداد',
  'audit.outcome': 'نتیجه',
  'audit.client': 'کلاینت',
  'audit.meta': 'جزئیات',
  'audit.metaRaw': 'فراداده، دقیقاً همان‌طور که ذخیره شده است',
  'audit.filter': 'رویداد',
  'audit.filterAll': 'همهٔ رویدادها',
  'audit.more': 'قدیمی‌ترها',
  'audit.end': 'این تمام گزارش است.',
  'audit.verify': 'بررسی زنجیره',
  'audit.verifyOk': 'زنجیره روی {count} سطر درست است.',
  'audit.verifyBroken': 'زنجیره درست نیست. نخستین شکست در سطر {id}: {reason}.',
  'audit.verifyHint':
    'شکست در قدیمی‌ترین سطر باقی‌مانده بسیار محتمل‌تر است که تغییر PANEL_MASTER_KEY باشد تا دست‌کاری — درهم‌سازی سطرها کلیددار است، پس کلید دیگر همهٔ سطرها را یک‌جا باطل می‌کند، در حالی که دست‌کاری همه‌چیز پیش از سطر تغییر‌یافته را سالم می‌گذارد.',
  'audit.verifyMeaning':
    'شکست یعنی سطری با چیزی جز این پنل تغییر کرده، حذف شده یا افزوده شده است. گزارش نمی‌تواند خودش را تعمیر کند؛ یک پشتیبان بگیرید و مقایسه کنید.',

  // ── Resources ────────────────────────────────────────────────────────────
  'resources.title': 'منابع',
  'resources.memory': 'حافظه',
  'resources.cpu': 'پردازنده',
  'resources.disk': 'حجم',
  'resources.database': 'پایگاه داده',
  'resources.usedOfLimit': '{used} از {limit}',
  'resources.noLimit': 'این کانتینر سقفی گزارش نمی‌کند، پس درصدی برای نشان‌دادن وجود ندارد.',
  'resources.measuring': 'در حال اندازه‌گیری…',
  'resources.cpuOfQuota': '{percent} از {cores} هسته',
  'resources.hostWide':
    'این اعداد میزبان را توصیف می‌کنند نه پنل را: cgroup خوانده نشد، و میزبان بسیار بیشتر از سهم این کانتینر حافظه دارد.',
  'resources.available': '{available} آزاد',
  'resources.watchdog': 'هشدارها',
  'resources.watchdogOff': 'دیده‌بان خاموش است، پس چیزی پایش نمی‌شود.',
  'resources.armed': 'در حال پایش، هشدار در {threshold}',
  'resources.disarmedNoLimit':
    'خاموش: این کانتینر سقف حافظه گزارش نمی‌کند، پس چیزی نیست که درصدی از آن باشد.',
  'resources.disarmedUnavailable': 'خاموش: این عدد اینجا خواندنی نیست.',
  'resources.disarmedDisabled': 'خاموش: دیده‌بان غیرفعال است.',
  'resources.above': 'از {time} بالای آستانه',
  'resources.clearing':
    'از {time} زیر خط پاک‌شدن؛ پیام بازگشت وقتی فرستاده می‌شود که {window} در همین وضع بماند.',
  'resources.oomKills': '{count} فرایند به‌خاطر حافظه کشته شد',
  'resources.oomNoBaseline': 'شمارندهٔ کشتار هنوز خوانده نشده است.',
  'resources.uncleanRestart':
    'اجرای پیشین تمیز خاموش نشد. آخرین بار در {time} با {used} دیده شد.',
  'resources.cleanRestart': 'اجرای پیشین تمیز خاموش شد.',
  'resources.notChecked': 'اجرای پیشین بررسی نشد، چون دیده‌بان خاموش است.',
  'resources.sampledAt': 'نمونه‌برداری {time}',

  // ── Errors ───────────────────────────────────────────────────────────────
  'error.unauthenticated': 'وارد نشده‌اید.',
  'error.stepUpRequired': 'این کار به تأیید تازه نیاز دارد.',
  'error.csrfInvalid': 'درخواست برای ایمنی رد شد. صفحه را دوباره بارگذاری کنید و باز تلاش کنید.',
  'error.rateLimited': 'درخواست‌ها بیش از حد است. {seconds} ثانیه دیگر تلاش کنید.',
  'error.authInProgress': 'یک تلاش احرازهویت در جریان است.',
  'error.badCredentials': 'این اطلاعات پذیرفته نشد.',
  'error.weakPassword': 'این گذرواژه ضعیف یا بسیار رایج است.',
  'error.notFound': 'چنین چیزی وجود ندارد.',
  'error.conflict': 'این کار در وضعیت کنونی پنل ممکن نیست.',
  'error.tooLarge': 'این درخواست بزرگ‌تر از حد بود.',
  'error.badRequest': 'پنل نتوانست این درخواست را بخواند.',
  'error.server': 'مشکلی در سرور رخ داد. دلیلش در لاگ است، نه اینجا.',
  'error.network': 'دسترسی به پنل ممکن نشد.',
  'error.unknown': 'مشکلی رخ داد.',

  // ── Not found ────────────────────────────────────────────────────────────
  'notFound.title': 'چنین صفحه‌ای نیست',
  'notFound.explain': 'این نشانی بخشی از پنل نیست.',
  'notFound.home': 'رفتن به نمای کلی',
};

export default fa;
