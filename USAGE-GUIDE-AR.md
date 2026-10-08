# دليل الاستخدام الكامل — Nazamly ERP SaaS CLI

نظام بيحوّل مشروع ERP واحد إلى نسخ SaaS منفصلة لكل عميل: كل عميل بياخد موقع مستقل على Firebase Hosting وقاعدة بيانات Firestore خاصة بيه، من غير ما تغيّر كود المشروع الأصلي.

---

## 1. النظام بيشتغل إزاي

```
D:\Job\
├── nazamly-erp\                 ← المشروع الأصلي (الكود بتاعك، فيه {{PLACEHOLDER}})
│   ├── index.html, orders.html ...
│   ├── cli\                     ← أدوات التشغيل (السكربتات)
│   │   └── .build-cache\        ← نسخ البناء المؤقتة (بتتمسح بعد 7 أيام)
│   └── ...
│
└── nazamly-clients-vault\        ← الـ Vault (خارج المشروع تمامًا)
    ├── .vault-key               ← مفتاح التشفير (اختياري)
    ├── _audit\audit.log         ← سجل كل العمليات
    └── <client-id>\             ← فولدر لكل عميل:
        ├── .env                 ← بيانات العميل (14 مفتاح)
        ├── service-account.json ← مفتاح Firebase Admin (بتحطه بإيدك)
        ├── deploy-history.json  ← تاريخ كل عمليات الرفع
        ├── backups\             ← النسخ الاحتياطية بتاعة Firestore
        └── tombstone.json       ← علامة "العميل ده اتشال" (بعد destroy)
```

**الفكرة:** المشروع الأصلي فيه رموز زي `{{FIREBASE_API_KEY}}` و`{{CLIENT_BRAND}}`. عند الرفع، السكربت بينسخ المشروع وبيستبدل الرموز دي ببيانات كل عميل من ملف `.env` بتاعه، وبيرفع النسخة على مشروع Firebase بتاع العميل ده.

---

## 2. الإعداد أول مرة (مرة واحدة بس)

```bash
# 1. Node.js نسخة 18 أو أحدث لازم تكون متسطبة

# 2. سطّب مكتبات المشروع (من جذر المشروع nazamly-erp)
npm install

# 3. سطّب أدوات Firebase
npm install -g firebase-tools

# 4. سجّل دخول بحساب Google بتاعك
npx firebase-tools login
```

ولكل عميل جديد لازم يكون عندك قبل أي حاجة:

1. **مشروع Firebase جديد** معمول من [Firebase Console](https://console.firebase.google.com) (باسم العميل).
2. **Web App متسجل** جوه المشروع ده — منه بتاخد المفاتيح الخمسة (API Key, Auth Domain, Project ID, Storage Bucket, App ID) من: `Project Settings → General → Your apps → Web app → Config`.
3. **Firestore + Authentication مفعّلين** جوه المشروع.
4. (للبذر والنسخ الاحتياطي) **service-account.json**: من `Project Settings → Service accounts → Generate new private key`، وحط الملف في: `nazamly-clients-vault\<client-id>\service-account.json`.

---

## 3. إضافة عميل جديد من الألف للياء

### الخطوة 1 — جمع بيانات العميل

```bash
node cli/create-client.js
# أو: npm run create-client
# أو مع تحديد الـ ID من الأول: node cli/create-client.js --client elnour
```

هيفتح معك wizard بيسأل بالترتيب:

| السؤال | ملاحظات |
|---|---|
| Client ID | اسم بالإنجليزية small-case، زي `elnour` — بيتستخدم في كل الأوامر |
| Brand name | الاسم العربي الظاهر في الموقع، زي `شركة النور` |
| Custom domain | اختياري — سيبها فاضية لو مفيش |
| WhatsApp support number | اختياري |
| Admin email + password | حساب أدمن العميل (الباسورد: 8+ حروف فيه capital وsmall ورقم) |
| مفاتيح Firebase الخمسة | بتنسخها من Firebase Console (شوف فوق) |
| مدة الاشتراك | 1 / 3 / 6 / 12 شهر |
| Deployment target | `production` أو `staging` |

بعدين بيعرض ملخص، ولما تأكد بيكتب ملف `.env` في الـ vault. لو فيه `service-account.json` هيختبر الاتصال بـ Firebase تلقائيًا.

### الخطوة 2 — حط مفتاح الخدمة

نزّل `service-account.json` من Firebase Console وحطه في:

```
nazamly-clients-vault\elnour\service-account.json
```

### الخطوة 3 — ازرع قاعدة البيانات (مرة واحدة لكل عميل)

```bash
node cli/create-client.js --seed elnour
```

بيعمل 4 خطوات بالترتيب:

1. **Super Admin** — من بيانات `cli\seeder-config.json` (حسابك أنت، مش خاضع لقفل الاشتراك).
2. **Client Admin** — بحساب الإيميل والباسورد اللي دخلتهم في الـ wizard (دوره `admin`).
3. **System Config** — إعدادات الموقع (اسم البراند، إعدادات الواجهة...).
4. **Subscription** — مستند الاشتراك (تاريخ البداية والنهاية حسب المدة اللي اخترتها).

### الخطوة 4 — ارفع الموقع

```bash
node cli/deploy.js --client elnour
```

بيعمل بالترتيب: بيقرا `.env` من الـ vault → بينسخ المشروع في `cli\.build-cache\elnour-ws-<timestamp>\public` مع استبدال كل الـ placeholders ببيانات العميل → بيولّد `firebase.json` و`.firebaserc` → بيرفع على Firebase Hosting بالأمر `npx -y firebase-tools deploy --only hosting --project <projectId>` → بيسجل العملية في `deploy-history.json`.

الموقع هيبقى متاح على: `https://<FIREBASE_PROJECT_ID>.web.app`

### الخطوة 5 — تأكد إن كله تمام

```bash
node cli/audit.js --health
```

---

## 4. مرجع الأوامر الكامل

### 4.1 `create-client.js` — إنشاء عميل

```bash
node cli/create-client.js [options]
```

| Option | بيعمل إيه |
|---|---|
| `--client, -c <id>` | يملا الـ ID مقدمًا (وبيشيك إنه مش موجود قبل كده) |
| `--seed, -s [id]` | بدون ID: بيزرع DB بعد الـ wizard. مع ID: وضع "بذر فقط" لعميل موجود |
| `--dry-run, -n` | فحص البيانات وطباعتها من غير كتابة أي ملف |
| `--skip-test` | يتخطى اختبار الاتصال بـ Firebase |
| `--key <passphrase>` | مفتاح تشفير `.env` |
| `--key-file <path>` | ملف فيه المفتاح |

قواعد التحقق: الـ API Key لازم يبدأ بـ `AIza`، الـ Project ID من 6 لـ 30 حرف small-case، الـ Sender ID من 10 لـ 12 رقم، والـ App ID بصيغة `1:<number>:web:<hex>`.

### 4.2 `deploy.js` — الرفع

```bash
node cli/deploy.js [options]
```

| Option | بيعمل إيه |
|---|---|
| `--client, -c <id>` | رفع عميل واحد |
| `--all, -a` | رفع كل العملاء في الـ vault ورا بعض |
| `--continue` | مع `--all`: يكمل لو فشل عميل بدل ما يقف |
| `--dry-run, -n` | بناء واستبدال فقط — من غير رفع على Firebase |
| `--verbose, -v` | يعرض output بتاع Firebase مباشرة أثناء الرفع |
| `--source, -s <path>` | مصدر غير افتراضي للملفات (الافتراضي: جذر المشروع) |
| `--rollback, -r` | رجوع للنسخة السابقة (بيطلب `--client`) |
| `--also-restore` | مع `--rollback`: كمان يسترجع بيانات Firestore من الباكب |
| `--list, -l` | يعرض كل العملاء القابلين للرفع |
| `--cleanup` | يمسح مجلدات `.build-cache` الأقدم من 7 أيام |

ملاحظات:

- وقت الرفع الافتراضي 5 دقايق، وكل عملية بتتسجل (مع الـ git commit الحالي) في `deploy-history.json` — محفوظ آخر 100 عملية.
- الـ rollback بيجرّب الأول `firebase hosting:clone` للنسخة السابقة، ولو فشل بيعيد البناء والرفع من الكود.
- ملفات بتتبعد من النسخة تلقائيًا: `node_modules`, `.git`, `cli`, `package.json`, `.env`, الصور والخطوط بتتنسخ زي ما هي.
- النسخة الاحتياطية **مش** بتتعمل أوتوماتيك قبل الرفع — شغّل `backup.js` بإيدك قبل أي تحديث مهم.

### 4.3 `backup.js` — نسخة احتياطية من Firestore

```bash
node cli/backup.js --client elnour            # باكب لعميل
node cli/backup.js --all                      # باكب للكل
node cli/backup.js --client elnour --list      # عرض الباكبات الموجودة
node cli/backup.js --client elnour --prune     # حذف القديم، إبقاء آخر 10
node cli/backup.js --client elnour --collections orders,products  # collections معينة
node cli/backup.js --client elnour --compact   # JSON مضغوط (أصغر حجمًا)
```

الملفات بتتحفظ في: `nazamly-clients-vault\<client>\backups\` كملفات JSON باسم فيها التاريخ.

### 4.4 `restore.js` — استرجاع بيانات (خطر: بيكتب فوق البيانات)

```bash
node cli/restore.js --client elnour --latest --dry-run   # معاينة من غير كتابة
node cli/restore.js --client elnour --latest --confirm    # تنفيذ فعلي
node cli/restore.js --client elnour --backup <path> --confirm
node cli/restore.js --client elnour --latest --confirm --collections orders  # جزء معين
node cli/restore.js --client elnour --latest --confirm --merge  # دمج بدل الكتابة فوق
```

- `--confirm` **إلزامي** للتنفيذ، وكمان بيطلب تأكيد interactively تاني مرة.
- **دايمًا** ابدأ بـ `--dry-run` الأول عشان تشوف إيه اللي هيرجع.

### 4.5 `audit.js` — المراقبة والتقارير (قراءة فقط، آمن في أي وقت)

```bash
node cli/audit.js --health                    # جدول حالة كل العملاء
node cli/audit.js --health --csv > tenants.csv  # تصدير CSV
node cli/audit.js --logs                      # آخر العمليات المسجلة
node cli/audit.js --logs --client elnour --action deploy_completed --since 2025-01-01 --limit 50
node cli/audit.js --client elnour             # تقرير تفصيلي لعميل واحد
```

### 4.6 `destroy.js` — حذف عميل نهائيًا (أخطر أمر في النظام)

```bash
node cli/destroy.js --client elnour                # معاينة فقط (الافتراضي — مبيعملش حاجة)
node cli/destroy.js --client elnour --confirm      # التنفيذ الفعلي
```

لو شغلت `--confirm`:

1. بياخد **نسخة احتياطية أخيرة** أوتوماتيك قبل أي حذف.
2. بيمسح كل documents من كل collections في Firestore (باتشات 500).
3. بيمسح كل حسابات المستخدمين من Firebase Auth.
4. بيعمل rename للـ `.env` إلى `.env.destroyed` وبيكتب `tombstone.json` (علامة بتمنع إعادة استخدام نفس الـ ID).

| Option | بيعمل إيه |
|---|---|
| `--keep-vault` | يحافظ على فولدر الـ vault زي ما هو |
| `--skip-firestore` | يمنع مسح قاعدة البيانات |
| `--skip-auth` | يمنع مسح حسابات المستخدمين |

**تأكيدات إلزامية لا يمكن تخطيها:** لازم تكتب الـ client ID بالظبط، وبعدين تكتب `DELETE ALL DATA` بالظبط.

---

## 5. التشفير وحماية البيانات

- ملفات `.env` ممكن تتشفر — وده بيحصل لما يكون فيه master key.
- مصادر المفتاح بالأولوية: `--key <passphrase>` ثم `--key-file <path>` ثم ملف `.vault-key` في جذر الـ vault (بيتحمل أوتوماتيك).
- لو الـ `.env` مشفر ومفيش مفتاح، أي سكربت هيرفض يكمل و هيطلب منك `--key`.
- حط مفتاحك في `nazamly-clients-vault\.vault-key` مرة واحدة، وكل السكربتات هتلاقيه لوحدها (مستحيل تعمل commit للمفتاح لأن الـ vault خارج المشروع).

---

## 6. الـ Placeholders في الكود

لما تعدّل المشروع الأصلي، استخدم الرموز دي وكل عميل هياخد قيمته تلقائيًا عند الرفع:

| الرمز | المصدر |
|---|---|
| `{{FIREBASE_API_KEY}}` | `.env` العميل |
| `{{FIREBASE_AUTH_DOMAIN}}` | `.env` العميل |
| `{{FIREBASE_PROJECT_ID}}` | `.env` العميل |
| `{{FIREBASE_STORAGE_BUCKET}}` | `.env` العميل |
| `{{FIREBASE_MSG_SENDER_ID}}` | `.env` العميل |
| `{{FIREBASE_APP_ID}}` | `.env` العميل |
| `{{CLIENT_BRAND}}` | اسم البراند العربي |
| `{{CLIENT_ID}}` | معرّف العميل |
| `{{CLIENT_DOMAIN}}` | الدومين (فاضي لو مفيش) |
| `{{SUPPORT_PHONE}}` | رقم الواتساب |
| `{{THEME_INIT_SCRIPT}}` | يتحول لسكربت inline لمنع وميض الثيم |
| `{{LIGHT_THEME_CSS}}` | يتحول لـ `<link>` لملف light-theme.css |

الاستبدال بيحصل في ملفات `.html`, `.htm`, `.js`, `.json`, `.txt` فقط.

---

## 7. سيناريوهات شائعة

### عملت تعديل في الكود وعايز كل العملاء ياخدوه

```bash
node cli/deploy.js --all
```

### رفع تحديث لعميل واحد بس

```bash
node cli/deploy.js --client elnour
```

### الرفع فشل والموقع باظ — رجّع النسخة السابقة

```bash
node cli/deploy.js --client elnour --rollback
# ولو البيانات نفسها اتلخبطت كمان:
node cli/deploy.js --client elnour --rollback --also-restore
```

### تجربة تعديل من غير ما تلمس الموقع الحقيقي

```bash
node cli/deploy.js --client elnour --dry-run --verbose
```

### نقل بيانات عميل لسيرفر تاني / استرجاع بعد كارثة

```bash
node cli/backup.js --client elnour
node cli/restore.js --client elnour --latest --dry-run   # اعرف إيه اللي هيرجع الأول
node cli/restore.js --client elnour --latest --confirm
```

### تجديد اشتراك أو تغيير بيانات عميل

مفيش أمر تعديل مباشر — عدّل ملف `nazamly-clients-vault\<client>\.env` بإيدك (أو أعد إنشاء العميل) ثم:

```bash
node cli/deploy.js --client elnour   # التغييرات اللي في الكود بتتطبق بالplaceholders
```

> بيانات الاشتراك نفسها بتتحدد وقت الـ seed — لتغييرها عدّل مستند `system_status/subscription` في Firestore أو أعد الـ seed.

---

## 8. مشاكل شائعة وحلولها

| المشكلة | السبب والحل |
|---|---|
| `firebase-tools not found` | سطّبه: `npm install -g firebase-tools` |
| `Client "x" not found in vault` | العميل مش متعمل — شغّل `create-client.js` الأول، أو اتأكد إن الـ vault في `D:\Job\nazamly-clients-vault` |
| `.env is encrypted and no master key is available` | اكتب `--key <passphrase>` أو حط المفتاح في `.vault-key` |
| الـ seed فشل في خطوة معينة | غالبًا `service-account.json` ناقص أو مش موجود في مكانه الصح |
| الرفع بيوصل timeout | الافتراضي 5 دقايق — جرّب تاني والاتصال أحسن، أو استخدم `--verbose` لتشوف فين واقف |
| الموقع رفع بس التغييرات مش ظاهرة | الـ headers بتاعة JS/CSS بتسمح بالتحديث (`must-revalidate`) — اعمل hard refresh (Ctrl+F5) |
| مفيش عميل اترفض ينشأ بـ "already exists" | الـ ID مستخدم قبل كده (حتى لو مدمر — شوف الـ tombstone) — اختار ID تاني |
| مساحة الديسك بتمتلي | `node cli/deploy.js --cleanup` بيمسح builds أقدم من 7 أيام |

---

## 9. الخلاصة السريعة (Cheat Sheet)

```bash
# عميل جديد كامل:
node cli/create-client.js --client <id>     # بيانات + .env في الـ vault
# >> حط service-account.json في الـ vault <<
node cli/create-client.js --seed <id>       # ازرع Firestore (أدمن + اشتراك)
node cli/deploy.js --client <id>            # انسخ + استبدل + ارفع

# متابعة:
node cli/audit.js --health                  # حالة كل العملاء
node cli/deploy.js --list                   # قائمة العملاء

# صيانة:
node cli/backup.js --client <id>            # باكب
node cli/restore.js --client <id> --latest --dry-run   # معاينة استرجاع
node cli/deploy.js --client <id> --rollback # رجوع لنسخة سابقة
node cli/deploy.js --cleanup                # نضّف البناء القديم

# حذر:
node cli/restore.js --client <id> --latest --confirm    # كتابة فوق البيانات
node cli/destroy.js --client <id>         # معاينة الحذف
node cli/destroy.js --client <id> --confirm  # حذف نهائي (تأكيد مزدوج)
```

وتقدر كمان تستخدم اختصارات npm: `npm run create-client`, `npm run deploy -- --client elnour`, `npm run backup`, `npm run restore`, `npm run audit`, `npm run destroy`.
