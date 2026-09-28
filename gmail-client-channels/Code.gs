/**
 * GMAIL CLIENT CHANNELS
 * ---------------------------------------------------------------------------
 * Gives every client its own Gmail label ("channel"), e.g. Clients/ABC Group,
 * and every bank its own label, e.g. Banks/HDFC. Driven entirely by a Google
 * Sheet (the "control panel") that this script is bound to.
 *
 *  - Old mail  : back-filled in small resumable chunks (newest first).
 *  - New mail  : picked up every 10 minutes via the Gmail History API.
 *  - Sent mail : included (To / Cc recipients are matched too).
 *  - Inbox     : untouched unless ARCHIVE_* settings are switched to TRUE.
 *  - New domain: channel auto-created + listed in a daily digest e-mail.
 *                Suspected newsletters / no-reply senders go to "Review".
 *
 * Sheet tabs (created by menu "Client Channels > 1. Set up sheet"):
 *   Settings    – switches (own domain, archive on/off, dry run, ...)
 *   DomainMap   – domain -> Client / Bank / Ignore / Review + channel name
 *   EmailMap    – individual address (e.g. a client's personal Gmail) -> channel
 *   Exclusions  – domains never turned into channels (public mail, govt, ...)
 *   Log         – run log
 *
 * Nothing is ever deleted from your mailbox. Removing a label never deletes
 * the e-mails inside it.
 */

// ----------------------------------------------------------------- constants
var TAB = { settings: 'Settings', domains: 'DomainMap', emails: 'EmailMap', excl: 'Exclusions', log: 'Log' };
var RUN_BUDGET_MS = 140 * 1000;   // per run; keeps a 10-min trigger inside the 6 h/day Workspace trigger quota
var TRIGGER_EVERY_MIN = 10;
var DIGEST_HOUR = 8;              // 8 AM, time zone from appsscript.json (Asia/Kolkata)
var ARCHIVE_MARKER = '_Channels-auto-archived';
var META_HEADERS = ['From', 'To', 'Cc', 'List-Unsubscribe', 'Precedence'];
var LOG_KEEP_ROWS = 1500;

var DOMAIN_HEADERS = ['Domain', 'Type', 'Channel Name', 'Status', 'First Seen', 'Digested', 'Applied Label', 'Notes'];
var D = { domain: 0, type: 1, channel: 2, status: 3, first: 4, digested: 5, applied: 6, notes: 7 };
var EMAIL_HEADERS = ['Email', 'Channel Name', 'Applied Label', 'Notes'];
var E = { email: 0, channel: 1, applied: 2, notes: 3 };
var TYPES = ['Client', 'Bank', 'Ignore', 'Review'];

// Two-part public suffixes, so "mail.abc.co.in" collapses to "abc.co.in".
var MULTI_SUFFIX = [
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'res.in', 'gov.in', 'nic.in', 'bank.in', 'fin.in', 'mil.in',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 're.kr', 'ac.kr',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'com.sg', 'edu.sg', 'co.jp', 'ne.jp', 'or.jp',
  'com.cn', 'com.hk', 'com.my', 'co.nz', 'co.za', 'com.br', 'co.id', 'com.tw', 'co.th', 'com.vn', 'com.ph', 'com.pk', 'com.bd', 'com.np', 'co.ae'
];

// Sender local-parts that usually mean automated / bulk mail (NOT "info@" — many small clients use it).
var BULK_SENDER_RE = /^(no-?reply|do-?not-?reply|donotreply|noreply|newsletters?|news|marketing|mailer|mailer-daemon|bounces?|notifications?|notify|alerts?|updates|offers?|promo|promotions|campaigns?|digest)([._+-]|@|$)/i;

var DEFAULT_SETTINGS = [
  ['OWN_DOMAINS', 'hkjain.com', 'Comma-separated. Your firm domain(s) – never a channel.'],
  ['OWN_EMAILS', '', 'Extra addresses of yours (e.g. old personal Gmail). Your login and Send-As aliases are added automatically.'],
  ['CLIENT_PARENT', 'Clients', 'Parent label for client channels.'],
  ['BANK_PARENT', 'Banks', 'Parent label for bank channels.'],
  ['AUTO_CREATE_CLIENTS', 'TRUE', 'TRUE = new client domains get a channel immediately (and appear in digest). FALSE = they go to Review.'],
  ['AUTO_DETECT_BANK_IN', 'TRUE', 'TRUE = any *.bank.in domain (RBI-mandated bank domain) is treated as a Bank automatically.'],
  ['ARCHIVE_CLIENT_MAIL', 'FALSE', 'TRUE = remove client mail from Inbox after labelling. Default keeps Inbox as is.'],
  ['ARCHIVE_BANK_MAIL', 'FALSE', 'TRUE = remove bank mail from Inbox after labelling.'],
  ['DRY_RUN', 'TRUE', 'TRUE = only fill DomainMap, do not touch Gmail. Review the list, then set FALSE.'],
  ['BACKFILL_QUERY', '', 'Gmail search limiting the back-fill of old mail, e.g. after:2019/04/01. Blank = all mail.'],
  ['DIGEST_TO', '', 'Where to send the daily digest. Blank = you.']
];

var DEFAULT_EXCLUSIONS = [
  // Public / personal mail providers
  ['gmail.com', 'Public mail'], ['googlemail.com', 'Public mail'], ['yahoo.com', 'Public mail'], ['yahoo.co.in', 'Public mail'],
  ['yahoo.in', 'Public mail'], ['ymail.com', 'Public mail'], ['rocketmail.com', 'Public mail'], ['outlook.com', 'Public mail'],
  ['outlook.in', 'Public mail'], ['hotmail.com', 'Public mail'], ['hotmail.co.in', 'Public mail'], ['live.com', 'Public mail'],
  ['live.in', 'Public mail'], ['msn.com', 'Public mail'], ['rediffmail.com', 'Public mail'], ['rediff.com', 'Public mail'],
  ['icloud.com', 'Public mail'], ['me.com', 'Public mail'], ['mac.com', 'Public mail'], ['aol.com', 'Public mail'],
  ['protonmail.com', 'Public mail'], ['proton.me', 'Public mail'], ['zoho.com', 'Public mail'], ['zohomail.com', 'Public mail'],
  ['zohomail.in', 'Public mail'], ['gmx.com', 'Public mail'], ['mail.com', 'Public mail'], ['yandex.com', 'Public mail'],
  ['sify.com', 'Public mail'], ['vsnl.net', 'Public mail'], ['naver.com', 'Public mail (Korea)'], ['daum.net', 'Public mail (Korea)'],
  ['hanmail.net', 'Public mail (Korea)'], ['kakao.com', 'Public mail (Korea)'], ['nate.com', 'Public mail (Korea)'],
  ['qq.com', 'Public mail'], ['163.com', 'Public mail'], ['126.com', 'Public mail'],
  // Government, regulators, statutory bodies (suffix match covers every *.gov.in / *.nic.in site)
  ['gov.in', 'Government'], ['nic.in', 'Government'], ['gov', 'Government (US)'], ['go.kr', 'Government (Korea)'], ['gov.uk', 'Government (UK)'],
  ['rbi.org.in', 'Regulator'], ['icai.org', 'Professional body'], ['icai.in', 'Professional body'], ['icsi.edu', 'Professional body'],
  ['nsdl.co.in', 'Statutory intermediary'], ['nsdl.com', 'Statutory intermediary'], ['proteantech.in', 'Statutory intermediary'],
  ['protean-tinpan.com', 'Statutory intermediary'], ['cdslindia.com', 'Statutory intermediary'], ['utiitsl.com', 'Statutory intermediary'],
  ['npci.org.in', 'Statutory intermediary'], ['bseindia.com', 'Exchange'], ['nseindia.com', 'Exchange'], ['cersai.org.in', 'Statutory registry'],
  // Bulk mail platforms & common services / newsletters
  ['google.com', 'Service'], ['youtube.com', 'Service'], ['linkedin.com', 'Social'], ['facebookmail.com', 'Social'], ['instagram.com', 'Social'],
  ['x.com', 'Social'], ['twitter.com', 'Social'], ['whatsapp.com', 'Social'], ['quora.com', 'Social'], ['microsoft.com', 'Service'],
  ['office.com', 'Service'], ['apple.com', 'Service'], ['zoom.us', 'Service'], ['dropbox.com', 'Service'], ['adobe.com', 'Service'],
  ['docusign.net', 'Service'], ['canva.com', 'Service'], ['calendly.com', 'Service'], ['slack.com', 'Service'], ['notion.so', 'Service'],
  ['github.com', 'Service'], ['amazon.in', 'Shopping'], ['amazon.com', 'Shopping'], ['flipkart.com', 'Shopping'], ['myntra.com', 'Shopping'],
  ['swiggy.in', 'Shopping'], ['zomato.com', 'Shopping'], ['bigbasket.com', 'Shopping'], ['paytm.com', 'Payments'], ['phonepe.com', 'Payments'],
  ['makemytrip.com', 'Travel'], ['irctc.co.in', 'Travel'], ['uber.com', 'Travel'], ['olacabs.com', 'Travel'], ['bookmyshow.com', 'Shopping'],
  ['naukri.com', 'Jobs'], ['indeed.com', 'Jobs'], ['indiatimes.com', 'News'], ['moneycontrol.com', 'News'], ['substack.com', 'Newsletter'],
  ['medium.com', 'Newsletter'], ['taxguru.in', 'Newsletter'], ['caclubindia.com', 'Newsletter'], ['taxmann.com', 'Newsletter'],
  ['cleartax.in', 'Newsletter'], ['mailchimpapp.net', 'Bulk mailer'], ['mcsv.net', 'Bulk mailer'], ['rsgsv.net', 'Bulk mailer'],
  ['sendgrid.net', 'Bulk mailer'], ['amazonses.com', 'Bulk mailer'], ['mailgun.org', 'Bulk mailer'], ['zcsend.net', 'Bulk mailer']
];

// Starting list of bank domains -> bank name. Verify / extend in the DomainMap tab.
// Banks were required by RBI to move to *.bank.in by 31-Oct-2025; old domains still send mail, so both are kept.
var DEFAULT_BANKS = [
  ['hdfcbank.com', 'HDFC'], ['hdfcbank.net', 'HDFC'], ['hdfc.bank.in', 'HDFC'], ['icicibank.com', 'ICICI'], ['axisbank.com', 'Axis'],
  ['sbi.co.in', 'SBI'], ['sbi.bank.in', 'SBI'], ['sbicard.com', 'SBI Card'], ['kotak.com', 'Kotak'], ['yesbank.in', 'Yes Bank'],
  ['indusind.com', 'IndusInd'], ['idfcfirstbank.com', 'IDFC First'], ['bankofbaroda.in', 'Bank of Baroda'], ['pnbindia.in', 'PNB'],
  ['canarabank.com', 'Canara'], ['unionbankofindia.co.in', 'Union Bank'], ['bankofindia.co.in', 'Bank of India'],
  ['centralbankofindia.co.in', 'Central Bank'], ['indianbank.in', 'Indian Bank'], ['iob.in', 'IOB'], ['ucobank.com', 'UCO'],
  ['bankofmaharashtra.in', 'Bank of Maharashtra'], ['idbibank.in', 'IDBI'], ['federalbank.co.in', 'Federal'], ['rblbank.com', 'RBL'],
  ['aubank.in', 'AU Bank'], ['bandhanbank.com', 'Bandhan'], ['southindianbank.com', 'South Indian Bank'], ['kvb.co.in', 'Karur Vysya'],
  ['cityunionbank.com', 'City Union'], ['dcbbank.com', 'DCB'], ['jkbank.com', 'J&K Bank'], ['hsbc.co.in', 'HSBC'], ['sc.com', 'Standard Chartered'],
  ['dbs.com', 'DBS'], ['shinhan.com', 'Shinhan'], ['wooribank.com', 'Woori'], ['hanabank.com', 'Hana'], ['kbstar.com', 'KB Kookmin'], ['ibk.co.kr', 'IBK']
];

// Token of a *.bank.in domain -> display name (e.g. hdfc.bank.in -> HDFC). Unknown tokens are title-cased.
var BANK_TOKEN_NAMES = { hdfc: 'HDFC', icici: 'ICICI', sbi: 'SBI', axis: 'Axis', kotak: 'Kotak', yes: 'Yes Bank', indusind: 'IndusInd',
  idfcfirst: 'IDFC First', idfc: 'IDFC First', pnb: 'PNB', canara: 'Canara', unionbankofindia: 'Union Bank', union: 'Union Bank',
  bankofbaroda: 'Bank of Baroda', bob: 'Bank of Baroda', idbi: 'IDBI', federal: 'Federal', rbl: 'RBL', au: 'AU Bank', bandhan: 'Bandhan',
  hsbc: 'HSBC', iob: 'IOB', uco: 'UCO', indian: 'Indian Bank' };

// ------------------------------------------------------------------ menu / UI
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Client Channels')
    .addItem('1. Set up sheet (first time)', 'setupSheet')
    .addItem('2. Start automation (install triggers)', 'installTriggers')
    .addSeparator()
    .addItem('Run now', 'runChannels')
    .addItem('Send digest now', 'sendDigest')
    .addItem('Show status', 'showStatus')
    .addSeparator()
    .addItem('Pause automation (remove triggers)', 'removeTriggers')
    .addItem('Re-run back-fill of old mail', 'resetBackfill')
    .addSeparator()
    .addItem('UNDO: put auto-archived mail back in Inbox', 'undoArchive')
    .addItem('UNDO: delete all channel labels (e-mails are kept)', 'undoDeleteAllLabels')
    .addToUi();
}

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ensureTab_(ss, TAB.settings, ['Key', 'Value', 'What it does']);
  if (s.getLastRow() < 2) s.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);

  var x = ensureTab_(ss, TAB.excl, ['Domain (and all its subdomains)', 'Category', 'Notes']);
  if (x.getLastRow() < 2) x.getRange(2, 1, DEFAULT_EXCLUSIONS.length, 2).setValues(DEFAULT_EXCLUSIONS);

  var d = ensureTab_(ss, TAB.domains, DOMAIN_HEADERS);
  if (d.getLastRow() < 2) {
    var rows = DEFAULT_BANKS.map(function (b) {
      return [b[0], 'Bank', b[1], 'Preset', '', 'n/a', '', 'Starting list – verify'];
    });
    d.getRange(2, 1, rows.length, DOMAIN_HEADERS.length).setValues(rows);
  }
  d.getRange('B2:B').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(TYPES, true).build());

  ensureTab_(ss, TAB.emails, EMAIL_HEADERS);
  ensureTab_(ss, TAB.log, ['Time', 'Level', 'Message']);
  SpreadsheetApp.getUi().alert('Sheet ready.\n\n1) Check the Settings tab (DRY_RUN is TRUE for a safe first pass).\n' +
    '2) Menu > Client Channels > 2. Start automation.');
}

function ensureTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function installTriggers() {
  removeTriggers_();
  ScriptApp.newTrigger('runChannels').timeBased().everyMinutes(TRIGGER_EVERY_MIN).create();
  ScriptApp.newTrigger('sendDigest').timeBased().atHour(DIGEST_HOUR).everyDays(1).create();
  log_('INFO', 'Triggers installed: runChannels every ' + TRIGGER_EVERY_MIN + ' min, digest daily ~' + DIGEST_HOUR + ':00.');
  uiAlert_('Automation started. First run begins within ' + TRIGGER_EVERY_MIN + ' minutes (or use "Run now").');
}

function removeTriggers() { removeTriggers_(); uiAlert_('Automation paused. Labels already applied are kept.'); }

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['runChannels', 'sendDigest'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
}

function resetBackfill() {
  var p = PropertiesService.getScriptProperties();
  ['BACKFILL_TOKEN', 'BACKFILL_DONE', 'BACKFILL_COUNT'].forEach(function (k) { p.deleteProperty(k); });
  log_('INFO', 'Back-fill reset; old mail will be re-scanned (already-labelled threads are skipped cheaply).');
  uiAlert_('Back-fill will restart on the next run.');
}

function showStatus() {
  var p = PropertiesService.getScriptProperties().getProperties();
  uiAlert_('Back-fill: ' + (p.BACKFILL_DONE === 'yes' ? 'COMPLETE' : 'in progress') + ' – ' + (p.BACKFILL_COUNT || 0) + ' threads scanned\n' +
    'Last run: ' + (p.LAST_RUN || 'never') + '\nTriggers active: ' +
    ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(', '));
}

// ------------------------------------------------------------------ main run
function runChannels() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;   // previous run still going
  var start = Date.now();
  var ctx;
  try {
    ctx = loadContext_(start);
    if (!ctx.dryRun && !ctx.props.getProperty('LIVE_SINCE')) goLive_(ctx);
    syncSheetChanges_(ctx);
    processNewMail_(ctx);
    processBackfill_(ctx);
  } catch (e) {
    log_('ERROR', (e && e.stack) || String(e));
    throw e;
  } finally {
    if (ctx) flush_(ctx);
    PropertiesService.getScriptProperties().setProperty('LAST_RUN', new Date().toString());
    lock.releaseLock();
  }
}

function timeLeft_(ctx) { return RUN_BUDGET_MS - (Date.now() - ctx.start); }

function loadContext_(start) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ctx = { start: start, ss: ss, props: PropertiesService.getScriptProperties(), newRows: [], dirty: {}, dirtyEmails: {}, labels: {} };

  var sv = sheetValues_(ss, TAB.settings);
  var st = {};
  sv.forEach(function (r) { if (r[0]) st[String(r[0]).trim()] = String(r[1]).trim(); });
  ctx.settings = st;
  ctx.clientParent = cleanLabel_(st.CLIENT_PARENT || 'Clients');
  ctx.bankParent = cleanLabel_(st.BANK_PARENT || 'Banks');
  ctx.dryRun = isTrue_(st.DRY_RUN);
  ctx.autoCreate = st.AUTO_CREATE_CLIENTS === undefined ? true : isTrue_(st.AUTO_CREATE_CLIENTS);
  ctx.bankIn = st.AUTO_DETECT_BANK_IN === undefined ? true : isTrue_(st.AUTO_DETECT_BANK_IN);
  ctx.archiveClient = isTrue_(st.ARCHIVE_CLIENT_MAIL);
  ctx.archiveBank = isTrue_(st.ARCHIVE_BANK_MAIL);

  ctx.myEmails = {};
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  ctx.myEmails[me] = true;
  splitList_(st.OWN_EMAILS).forEach(function (e) { ctx.myEmails[e] = true; });
  try {
    (Gmail.Users.Settings.SendAs.list('me').sendAs || []).forEach(function (s) { ctx.myEmails[s.sendAsEmail.toLowerCase()] = true; });
  } catch (e) { log_('WARN', 'Could not read Send-As aliases: ' + e.message); }
  ctx.ownDomains = toSet_(splitList_(st.OWN_DOMAINS).concat([me.split('@')[1]]));
  ctx.exclusions = toSet_(sheetValues_(ss, TAB.excl).map(function (r) { return String(r[0]).trim().toLowerCase(); }));

  ctx.domainRows = sheetValues_(ss, TAB.domains).map(function (r) { return r.slice(0, DOMAIN_HEADERS.length); })
    .filter(function (r) { return r[D.domain]; });
  ctx.domainIndex = {};
  ctx.domainRows.forEach(function (r) {
    r[D.domain] = String(r[D.domain]).trim().toLowerCase().replace(/^@/, '');
    ctx.domainIndex[r[D.domain]] = r;
  });

  ctx.emailRows = sheetValues_(ss, TAB.emails).map(function (r) { return r.slice(0, EMAIL_HEADERS.length); })
    .filter(function (r) { return r[E.email]; });
  ctx.emailIndex = {};
  ctx.emailRows.forEach(function (r) { r[E.email] = String(r[E.email]).trim().toLowerCase(); ctx.emailIndex[r[E.email]] = r; });

  (api_(function () { return Gmail.Users.Labels.list('me'); }).labels || []).forEach(function (l) {
    ctx.labels[l.name.toLowerCase()] = l.id;
  });
  return ctx;
}

// ---------------------------------------------------------- classification
/** Returns the label name an address belongs to, or null. May add a new DomainMap row. */
function resolveAddress_(ctx, email, sig) {
  email = email.toLowerCase();
  if (ctx.myEmails[email]) return null;

  var em = ctx.emailIndex[email];
  if (em) return em[E.channel] ? ctx.clientParent + '/' + cleanLabel_(em[E.channel]) : null;

  var domain = email.split('@')[1];
  if (!domain) return null;
  if (suffixMatch_(domain, ctx.ownDomains)) return null;

  var row = findDomainRow_(ctx, domain);
  if (row) return labelForRow_(ctx, row);
  if (suffixMatch_(domain, ctx.exclusions)) return null;

  var base = registrableDomain_(domain);
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var nr;
  if (ctx.bankIn && /(^|\.)bank\.in$/.test(base)) {
    nr = [base, 'Bank', bankNameFromDomain_(base), 'Auto', today, '', '', 'Auto-detected *.bank.in'];
  } else if (!ctx.autoCreate) {
    nr = [base, 'Review', base, 'Auto', today, '', '', 'Auto-create is off'];
  } else if (!sig.sentByMe && (sig.bulk || BULK_SENDER_RE.test(email.split('@')[0]))) {
    nr = [base, 'Review', base, 'Auto', today, '', '', 'Looks like bulk / no-reply mail (' + email + ')'];
  } else {
    nr = [base, 'Client', base, 'Auto', today, '', '', sig.sentByMe ? 'First seen in mail you sent' : 'First seen from ' + email];
  }
  var label = labelForRow_(ctx, nr);
  if (label && !ctx.dryRun) nr[D.applied] = label;
  ctx.domainIndex[base] = nr;
  ctx.domainRows.push(nr);
  ctx.newRows.push(nr);
  return label;
}

function labelForRow_(ctx, r) {
  var t = String(r[D.type] || '').trim().toLowerCase();
  var name = cleanLabel_(r[D.channel] || r[D.domain]);
  if (t === 'client') return ctx.clientParent + '/' + name;
  if (t === 'bank') return ctx.bankParent + '/' + name;
  return null;   // Ignore, Review, blank
}

function findDomainRow_(ctx, domain) {
  var parts = domain.split('.');
  for (var i = 0; i < parts.length - 1; i++) {
    var r = ctx.domainIndex[parts.slice(i).join('.')];
    if (r) return r;
  }
  return null;
}

function suffixMatch_(domain, set) {
  var parts = domain.split('.');
  for (var i = 0; i < parts.length; i++) if (set[parts.slice(i).join('.')]) return true;
  return false;
}

function registrableDomain_(domain) {
  var p = domain.split('.');
  if (p.length <= 2) return domain;
  var last2 = p.slice(-2).join('.');
  return MULTI_SUFFIX.indexOf(last2) >= 0 ? p.slice(-3).join('.') : last2;
}

function bankNameFromDomain_(d) {
  var tok = d.replace(/\.bank\.in$/, '').split('.').pop();
  var key = tok.replace(/bank$/, '');
  if (BANK_TOKEN_NAMES[tok]) return BANK_TOKEN_NAMES[tok];
  if (BANK_TOKEN_NAMES[key]) return BANK_TOKEN_NAMES[key];
  return key.length <= 4 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/** All channel labels a thread belongs to (From / To / Cc of every message). */
function channelsForThread_(ctx, thread) {
  var out = {};
  (thread.messages || []).forEach(function (m) {
    var ids = m.labelIds || [];
    if (ids.indexOf('SPAM') >= 0 || ids.indexOf('TRASH') >= 0 || ids.indexOf('DRAFT') >= 0) return;
    var h = {};
    ((m.payload && m.payload.headers) || []).forEach(function (x) { h[x.name.toLowerCase()] = (h[x.name.toLowerCase()] ? h[x.name.toLowerCase()] + ',' : '') + x.value; });
    var from = extractEmails_(h.from);
    var sentByMe = ids.indexOf('SENT') >= 0 || from.some(function (a) { return ctx.myEmails[a]; });
    var sig = { sentByMe: sentByMe, bulk: !sentByMe && (!!h['list-unsubscribe'] || /bulk|list|junk/i.test(h.precedence || '')) };
    from.concat(extractEmails_(h.to), extractEmails_(h.cc)).forEach(function (a) {
      var l = resolveAddress_(ctx, a, sig);
      if (l) out[l] = true;
    });
  });
  return Object.keys(out);
}

function extractEmails_(s) {
  if (!s) return [];
  return (String(s).match(/[A-Z0-9._%+'&-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(function (e) { return e.toLowerCase(); });
}

// ------------------------------------------------------------- Gmail writes
function processThread_(ctx, threadId) {
  var t;
  try {
    t = api_(function () { return Gmail.Users.Threads.get('me', threadId, { format: 'metadata', metadataHeaders: META_HEADERS }); });
  } catch (e) {
    if (/not found|404/i.test(e.message)) return;
    throw e;
  }
  applyToThread_(ctx, t, channelsForThread_(ctx, t));
}

function applyToThread_(ctx, t, labelNames) {
  if (!labelNames.length || ctx.dryRun) return;
  var msgs = (t.messages || []).filter(function (m) { var l = m.labelIds || []; return l.indexOf('SPAM') < 0 && l.indexOf('TRASH') < 0; });
  var add = [];
  labelNames.forEach(function (n) {
    var id = ensureLabel_(ctx, n);
    if (msgs.some(function (m) { return (m.labelIds || []).indexOf(id) < 0; })) add.push(id);
  });
  var remove = [];
  var isClient = labelNames.some(function (n) { return n.indexOf(ctx.clientParent + '/') === 0; });
  var isBank = labelNames.some(function (n) { return n.indexOf(ctx.bankParent + '/') === 0; });
  var inInbox = msgs.some(function (m) { return (m.labelIds || []).indexOf('INBOX') >= 0; });
  if (inInbox && ((ctx.archiveClient && isClient) || (ctx.archiveBank && isBank && !isClient))) {
    remove.push('INBOX');
    add.push(ensureLabel_(ctx, ARCHIVE_MARKER));   // lets "UNDO: put auto-archived mail back" find them
  }
  if (!add.length && !remove.length) return;
  api_(function () { return Gmail.Users.Threads.modify({ addLabelIds: add, removeLabelIds: remove }, 'me', t.id); });
}

function ensureLabel_(ctx, name) {
  var key = name.toLowerCase();
  if (ctx.labels[key]) return ctx.labels[key];
  var parts = name.split('/');
  for (var i = 1; i <= parts.length; i++) {
    var n = parts.slice(0, i).join('/');
    if (ctx.labels[n.toLowerCase()]) continue;
    var created = api_(function () {
      return Gmail.Users.Labels.create({ name: n, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, 'me');
    });
    ctx.labels[n.toLowerCase()] = created.id;
    log_('INFO', 'Created label ' + n);
  }
  return ctx.labels[key];
}

// ------------------------------------------------------ new mail (History API)
function processNewMail_(ctx) {
  var p = ctx.props;
  var hid = p.getProperty('HISTORY_ID');
  if (!hid) {   // very first run: remember "now"; everything older is handled by back-fill
    p.setProperty('HISTORY_ID', String(api_(function () { return Gmail.Users.getProfile('me'); }).historyId));
    return;
  }
  var threadIds = {}, latest = hid, pageToken = null;
  try {
    do {
      var res = api_(function () {
        return Gmail.Users.History.list('me', opts_({ startHistoryId: hid, historyTypes: ['messageAdded'], maxResults: 500, pageToken: pageToken }));
      });
      (res.history || []).forEach(function (h) {
        (h.messagesAdded || []).forEach(function (x) {
          var l = x.message.labelIds || [];
          if (l.indexOf('SPAM') >= 0 || l.indexOf('TRASH') >= 0 || l.indexOf('DRAFT') >= 0 || l.indexOf('CHAT') >= 0) return;
          threadIds[x.message.threadId] = true;
        });
      });
      if (res.historyId) latest = res.historyId;
      pageToken = res.nextPageToken;
    } while (pageToken);
  } catch (e) {
    // History IDs expire after roughly a week of inactivity – fall back to a date search.
    log_('WARN', 'History not available (' + e.message + '); scanning last 10 days instead.');
    listThreadIds_('newer_than:10d -in:chats').forEach(function (id) { threadIds[id] = true; });
    latest = api_(function () { return Gmail.Users.getProfile('me'); }).historyId;
  }
  var ids = Object.keys(threadIds);
  for (var i = 0; i < ids.length; i++) {
    if (timeLeft_(ctx) < 15000) { log_('WARN', 'New-mail pass ran out of time; will resume next run.'); return; }
    processThread_(ctx, ids[i]);
  }
  p.setProperty('HISTORY_ID', String(latest));
}

function listThreadIds_(q) {
  var out = [], token = null;
  do {
    var res = api_(function () { return Gmail.Users.Threads.list('me', opts_({ q: q, maxResults: 500, pageToken: token })); });
    (res.threads || []).forEach(function (t) { out.push(t.id); });
    token = res.nextPageToken;
  } while (token && out.length < 5000);
  return out;
}

// ------------------------------------------------------------ old mail back-fill
function processBackfill_(ctx) {
  var p = ctx.props;
  if (p.getProperty('BACKFILL_DONE') === 'yes') return;
  var q = ((ctx.settings.BACKFILL_QUERY || '') + ' -in:chats').trim();
  var token = p.getProperty('BACKFILL_TOKEN') || null;
  var count = Number(p.getProperty('BACKFILL_COUNT') || 0);
  while (timeLeft_(ctx) > 30000) {
    var res = api_(function () { return Gmail.Users.Threads.list('me', opts_({ q: q, maxResults: 100, pageToken: token })); });
    var list = res.threads || [];
    for (var i = 0; i < list.length; i++) {
      if (timeLeft_(ctx) < 10000) { p.setProperty('BACKFILL_COUNT', String(count)); return; }   // page is redone next run – safe
      processThread_(ctx, list[i].id);
      count++;
    }
    token = res.nextPageToken || null;
    p.setProperty('BACKFILL_COUNT', String(count));
    if (!token) {
      p.setProperty('BACKFILL_DONE', 'yes');
      p.deleteProperty('BACKFILL_TOKEN');
      log_('INFO', 'Back-fill complete: ' + count + ' threads scanned.');
      return;
    }
    p.setProperty('BACKFILL_TOKEN', token);
  }
}

// ------------------------------------------- apply edits made in the sheet
/**
 * First run with DRY_RUN = FALSE: treat every current row as already "applied" and re-scan all mail once,
 * so old mail is labelled in a single back-fill pass instead of one search per domain.
 */
function goLive_(ctx) {
  ctx.domainRows.forEach(function (r) { r[D.applied] = labelForRow_(ctx, r) || ''; ctx.dirty[r[D.domain]] = r; });
  ctx.emailRows.forEach(function (r) {
    r[E.applied] = r[E.channel] ? ctx.clientParent + '/' + cleanLabel_(r[E.channel]) : '';
    ctx.dirtyEmails[r[E.email]] = r;
  });
  ['BACKFILL_TOKEN', 'BACKFILL_DONE', 'BACKFILL_COUNT'].forEach(function (k) { ctx.props.deleteProperty(k); });
  ctx.props.setProperty('LIVE_SINCE', new Date().toString());
  log_('INFO', 'Live mode started: labelling all mail via back-fill.');
}

/**
 * Compares each row's wanted label with the label it last had ("Applied Label") and fixes Gmail:
 * rename / merge / delete old labels, and label historical mail for newly added or re-typed rows.
 */
function syncSheetChanges_(ctx) {
  if (ctx.dryRun) return;
  var wanted = {};
  ctx.domainRows.forEach(function (r) { var l = labelForRow_(ctx, r); if (l) wanted[l.toLowerCase()] = true; });
  ctx.emailRows.forEach(function (r) { if (r[E.channel]) wanted[(ctx.clientParent + '/' + cleanLabel_(r[E.channel])).toLowerCase()] = true; });

  ctx.domainRows.forEach(function (r) {
    if (timeLeft_(ctx) < 60000) return;
    var desired = labelForRow_(ctx, r) || '';
    var applied = String(r[D.applied] || '');
    if (desired === applied) return;
    var q = '{from:' + r[D.domain] + ' to:' + r[D.domain] + ' cc:' + r[D.domain] + '} -in:chats';
    var ret = retireLabel_(ctx, applied, desired, wanted);
    if (ret === 'partial') return;   // merge not finished – resume next run
    if (ret === 'renamed') { r[D.applied] = desired; ctx.dirty[r[D.domain]] = r; return; }
    if (desired && !labelBySearch_(ctx, q, desired, 'SYNC_D_' + r[D.domain])) return;   // not finished – resume next run
    r[D.applied] = desired;
    ctx.dirty[r[D.domain]] = r;
  });

  ctx.emailRows.forEach(function (r) {
    if (timeLeft_(ctx) < 60000) return;
    var desired = r[E.channel] ? ctx.clientParent + '/' + cleanLabel_(r[E.channel]) : '';
    var applied = String(r[E.applied] || '');
    if (desired === applied) return;
    var q = '{from:' + r[E.email] + ' to:' + r[E.email] + ' cc:' + r[E.email] + '} -in:chats';
    if (retireLabel_(ctx, applied, '', wanted) === 'partial') return;
    if (desired && !labelBySearch_(ctx, q, desired, 'SYNC_E_' + r[E.email])) return;
    r[E.applied] = desired;
    ctx.dirtyEmails[r[E.email]] = r;
  });
}

/** Old label no longer wanted by any row: rename it (cheap), merge it into the new one, or delete it. */
function retireLabel_(ctx, applied, desired, wanted) {
  if (!applied || wanted[applied.toLowerCase()]) return 'kept';
  var oldId = ctx.labels[applied.toLowerCase()];
  if (!oldId) return 'gone';
  if (desired && !ctx.labels[desired.toLowerCase()]) {
    var parent = desired.split('/').slice(0, -1).join('/');
    if (parent) ensureLabel_(ctx, parent);
    api_(function () { return Gmail.Users.Labels.patch({ name: desired }, 'me', oldId); });
    delete ctx.labels[applied.toLowerCase()];
    ctx.labels[desired.toLowerCase()] = oldId;
    log_('INFO', 'Renamed label ' + applied + ' -> ' + desired);
    return 'renamed';
  }
  if (desired) {   // merge: move every thread across, then drop the old label
    var newId = ensureLabel_(ctx, desired);
    while (timeLeft_(ctx) > 20000) {
      var res = api_(function () { return Gmail.Users.Threads.list('me', { labelIds: [oldId], maxResults: 100 }); });
      if (!(res.threads || []).length) break;
      res.threads.forEach(function (t) {
        api_(function () { return Gmail.Users.Threads.modify({ addLabelIds: [newId], removeLabelIds: [oldId] }, 'me', t.id); });
      });
    }
  }
  if (timeLeft_(ctx) <= 20000) return 'partial';
  api_(function () { return Gmail.Users.Labels.remove('me', oldId); });
  delete ctx.labels[applied.toLowerCase()];
  log_('INFO', 'Removed label ' + applied + (desired ? ' (merged into ' + desired + ')' : ''));
  return 'removed';
}

/** Labels every thread matching q. Resumable across runs; returns true when finished. */
function labelBySearch_(ctx, q, labelName, key) {
  var p = ctx.props, id = ensureLabel_(ctx, labelName);
  var token = p.getProperty(key) || null;
  while (timeLeft_(ctx) > 20000) {
    var res = api_(function () { return Gmail.Users.Threads.list('me', opts_({ q: q, maxResults: 100, pageToken: token })); });
    (res.threads || []).forEach(function (t) {
      api_(function () { return Gmail.Users.Threads.modify({ addLabelIds: [id] }, 'me', t.id); });
    });
    token = res.nextPageToken || null;
    if (!token) { p.deleteProperty(key); log_('INFO', 'Labelled history for ' + labelName + ' (' + q + ')'); return true; }
    p.setProperty(key, token);
  }
  return false;
}

// -------------------------------------------------------------- write back
function flush_(ctx) {
  var sh = ctx.ss.getSheetByName(TAB.domains);
  if (ctx.newRows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, ctx.newRows.length, DOMAIN_HEADERS.length).setValues(ctx.newRows);
    log_('INFO', ctx.newRows.length + ' new domain(s) added to DomainMap.');
  }
  writeApplied_(sh, ctx.dirty, D.applied, ctx.newRows);
  writeApplied_(ctx.ss.getSheetByName(TAB.emails), ctx.dirtyEmails, E.applied, []);
  ctx.newRows = []; ctx.dirty = {}; ctx.dirtyEmails = {};
}

/** Re-reads column A so edits made in the sheet during the run are not overwritten. */
function writeApplied_(sh, dirty, col, skipRows) {
  var keys = Object.keys(dirty);
  if (!keys.length || sh.getLastRow() < 2) return;
  var colA = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  colA.forEach(function (v, i) {
    var k = String(v[0]).trim().toLowerCase().replace(/^@/, '');
    if (dirty[k] && skipRows.indexOf(dirty[k]) < 0) sh.getRange(i + 2, col + 1).setValue(dirty[k][col]);
  });
}

// -------------------------------------------------------------------- digest
function sendDigest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB.domains);
  if (!sh || sh.getLastRow() < 2) return;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, DOMAIN_HEADERS.length).getValues();
  var pending = [];
  vals.forEach(function (r, i) { if (r[D.status] === 'Auto' && !r[D.digested]) pending.push({ row: i + 2, r: r }); });
  if (!pending.length) return;

  var settings = {};
  sheetValues_(ss, TAB.settings).forEach(function (r) { settings[r[0]] = String(r[1]).trim(); });
  var to = settings.DIGEST_TO || Session.getEffectiveUser().getEmail();
  var groups = { Client: [], Bank: [], Review: [], Ignore: [] };
  pending.forEach(function (x) { (groups[x.r[D.type]] || groups.Review).push(x.r); });

  var html = '<p>New sender domains found by Client Channels. Change the <b>Type</b> or <b>Channel Name</b> in the ' +
    '<a href="' + ss.getUrl() + '">control sheet</a> (DomainMap tab); the next run applies it.</p>';
  [['Client', 'New client channels created'], ['Bank', 'New bank channels created'], ['Review', 'Needs your decision (not labelled yet)']]
    .forEach(function (g) {
      if (!groups[g[0]].length) return;
      html += '<h3>' + g[1] + ' (' + groups[g[0]].length + ')</h3><table border="1" cellpadding="4" style="border-collapse:collapse">' +
        '<tr><th>Domain</th><th>Channel</th><th>Note</th></tr>' +
        groups[g[0]].map(function (r) { return '<tr><td>' + esc_(r[D.domain]) + '</td><td>' + esc_(r[D.channel]) + '</td><td>' + esc_(r[D.notes]) + '</td></tr>'; }).join('') +
        '</table>';
    });
  MailApp.sendEmail({ to: to, subject: 'Client Channels – ' + pending.length + ' new domain(s) to review', htmlBody: html });
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  pending.forEach(function (x) { sh.getRange(x.row, D.digested + 1).setValue(stamp); });
}

// ----------------------------------------------------------------------- undo
function undoArchive() {
  var ctx = { labels: {} };
  (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) { ctx.labels[l.name.toLowerCase()] = l.id; });
  var id = ctx.labels[ARCHIVE_MARKER.toLowerCase()];
  if (!id) return uiAlert_('Nothing to undo – no mail was auto-archived.');
  var n = 0, start = Date.now(), res;
  do {
    res = api_(function () { return Gmail.Users.Threads.list('me', { labelIds: [id], maxResults: 100 }); });
    (res.threads || []).forEach(function (t) {
      api_(function () { return Gmail.Users.Threads.modify({ addLabelIds: ['INBOX'], removeLabelIds: [id] }, 'me', t.id); });
      n++;
    });
  } while ((res.threads || []).length && Date.now() - start < 300000);
  if (!(res.threads || []).length) api_(function () { return Gmail.Users.Labels.remove('me', id); });
  uiAlert_(n + ' thread(s) moved back to Inbox.' + ((res.threads || []).length ? ' More remain – run again.' : ''));
}

function undoDeleteAllLabels() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var st = {};
  sheetValues_(ss, TAB.settings).forEach(function (r) { st[r[0]] = String(r[1]).trim(); });
  var parents = [cleanLabel_(st.CLIENT_PARENT || 'Clients'), cleanLabel_(st.BANK_PARENT || 'Banks')];
  if (ui.alert('Delete every label under ' + parents.join('/ and ') + '/ ?\n\nE-mails are NOT deleted – they stay in Inbox / All Mail. ' +
      'Automation will be paused.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  removeTriggers_();
  var labels = (Gmail.Users.Labels.list('me').labels || []).filter(function (l) {
    return l.type === 'user' && parents.some(function (p) { return l.name === p || l.name.indexOf(p + '/') === 0; });
  });
  labels.sort(function (a, b) { return b.name.length - a.name.length; });   // children first
  labels.forEach(function (l) { api_(function () { return Gmail.Users.Labels.remove('me', l.id); }); });
  [[TAB.domains, D.applied], [TAB.emails, E.applied]].forEach(function (x) {
    var sh = ss.getSheetByName(x[0]);
    if (sh && sh.getLastRow() > 1) sh.getRange(2, x[1] + 1, sh.getLastRow() - 1, 1).clearContent();
  });
  var p = PropertiesService.getScriptProperties();
  Object.keys(p.getProperties()).forEach(function (k) {
    if (k.indexOf('SYNC_') === 0 || k.indexOf('BACKFILL_') === 0 || k === 'LIVE_SINCE') p.deleteProperty(k);
  });
  log_('INFO', 'UNDO: deleted ' + labels.length + ' labels, triggers removed.');
  ui.alert(labels.length + ' label(s) deleted. Your e-mails are untouched. Use "2. Start automation" to rebuild later.');
}

// --------------------------------------------------------------- utilities
/** Calls the Gmail API with retry on rate-limit / transient errors. */
function api_(fn) {
  for (var attempt = 0; ; attempt++) {
    try { return fn(); } catch (e) {
      var msg = String(e && e.message);
      if (attempt >= 4 || !/rate|quota|backend|503|500|429|Internal|timed out|Service invoked too many/i.test(msg)) throw e;
      Utilities.sleep(Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500));
    }
  }
}

function sheetValues_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}

function log_(level, msg) {
  try {
    console.log(level + ' ' + msg);
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.log);
    if (!sh) return;
    sh.appendRow([new Date(), level, String(msg).slice(0, 5000)]);
    if (sh.getLastRow() > LOG_KEEP_ROWS + 200) sh.deleteRows(2, sh.getLastRow() - LOG_KEEP_ROWS - 1);
  } catch (e) { console.log('log failed: ' + e); }
}

function opts_(o) { Object.keys(o).forEach(function (k) { if (o[k] === null || o[k] === undefined) delete o[k]; }); return o; }
function uiAlert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { log_('INFO', msg); } }
function cleanLabel_(s) { return String(s).replace(/\//g, '-').replace(/\s+/g, ' ').trim(); }
function isTrue_(v) { return /^(true|yes|y|1)$/i.test(String(v).trim()); }
function splitList_(s) { return String(s || '').split(/[,;\s]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(String); }
function toSet_(arr) { var o = {}; arr.forEach(function (x) { if (x) o[x] = true; }); return o; }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
