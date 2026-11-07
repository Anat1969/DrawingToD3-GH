// מפיק את public/creations.json: כתבות ויצירות מתוך דף "שיטה" והסטודיו של האפליקציה (תקן "יצירות", AppOfApp-GH/docs/creations-standard.md).
// הרצה: node tools/creations.mjs
// מקור: index.html. כל שלב בשיטה (<ol class="method">) הוא "<b>תווית:</b> ערך<p>הסבר</p>", עם המחקר שהוא נשען עליו.
// בקוד הזה כתובים רק שמות החדרים, התוויות וההייקו (מסומנים "הייקו מקורי"). כל משפט אחר נקרא מהדף, ונבדק שהוא קיים בו.
// תמונות: צילומי הבמה של האפליקציה עצמה, מהציור לדוגמה (public/sample-drawing.svg) ומהציור במרחב, ב-public/creations/img.
import fs from 'fs';
import path from 'path';

const HTML = fs.readFileSync('index.html', 'utf8');
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const plain = (s) => String(s).replace(/\*\*|==/g, '');
const has = (s) => { if (!strip(HTML).includes(plain(s))) throw new Error(`לא נמצא באפליקציה: ${plain(s)}`); return s; };

// שלבי השיטה, לפי התווית
const M = {};
for (const m of HTML.matchAll(/<li><b>([^<:]+):<\/b>\s*([^<]+)<p>([\s\S]*?)<\/p><\/li>/g)) M[m[1].trim()] = { label: m[1].trim(), value: m[2].trim(), text: strip(m[3]) };
const need = (k) => { if (!M[k]) throw new Error(`שלב לא נמצא: ${k}`); return M[k]; };
// משפטים מתוך הסבר, לפי מספר (0 הוא הראשון)
const sents = (t) => t.match(/[^.]+(?:\.(?=\s|$)|$)/g).map((s) => s.trim()).filter(Boolean);
const S = (k, ...ix) => { const all = sents(need(k).text); return ix.map((i) => all[i]).join(' '); };
const ledeOf = (id) => strip(HTML.match(new RegExp(`aria-labelledby="${id}"[\\s\\S]*?<p class="lede">([\\s\\S]*?)</p>`))[1].replace(/<br>/g, ' '));

const CREDIT = 'צילום מהבמה של ציור לתלת-ממד: הציור לדוגמה של האפליקציה';
const CREDIT_SK = 'צילום מהבמה של ציור לתלת-ממד: ציור במרחב';
const IMG = (f, pos) => ({ image: `creations/img/${f}.jpg`, credit: /^sketch/.test(f) ? CREDIT_SK : CREDIT, ...(pos ? { pos } : {}) });
const haiku = (lines, text) => ({ style: 'haiku', lines, text: `הייקו מקורי. ${text}` });
const T = (id, zone, title, sub, creations, kicker) => ({ id, zone, title, sub, creations: creations.filter(Boolean).map((c) => ({ id: c.id || c.style, kicker: c.kicker || kicker, ...c })) });
const app = (q, cite) => ({ style: 'quote', quote: has(q), who: 'ציור לתלת-ממד', cite });

const METHOD_LEDE = ledeOf('method-title');

const topics = [
  T('thread', 'ידע', 'קו במרחב: חוט אחד', has(S('קו במרחב', 0)), [
    { style: 'poster', title: 'הקו השחור הופך לחוט', text: has('הקו כחוט רציף שמתלפף סביב הנפח, והצבע כענן. חינם, במכשיר.'), ...IMG('wrap') },
    { style: 'essay', title: 'מציור לחוט, שלב אחר שלב', text: S('קו במרחב', 0), body: [
      `**סף אדפטיבי.** ${S('קו במרחב', 0)}`, `**שלד.** ${S('קו במרחב', 1)}`, `**עומק.** ${S('קו במרחב', 3)}`,
    ] },
    { style: 'insight', title: 'הכול מתחבר לחוט אחד', text: S('קו במרחב', 4) },
    { style: 'fromto', title: 'מקו על דף לנפח', fromLabel: 'קו מתאר', from: has('קו מתאר יושב על שפת הצורה'), toLabel: 'קו פנימי', to: has('קו פנימי על פני הצורה'), text: S('קו במרחב', 4) },
    haiku(['קו דיו על נייר', 'מתלפף סביב הגוף', 'חוט אחד בחלל'], 'הנפח נוצר מ**ליפוף**, לא ממילוי.'),
  ], 'קו במרחב'),

  T('inflate', 'ידע', 'גוף מנופח: המרחק הופך לגובה', has(S('גוף מנופח', 0)), [
    { style: 'poster', title: 'ניפוח', text: has('הקו השחור בולט כנפח.'), ...IMG('clay') },
    { style: 'essay', title: 'שלושה מנועים, גוף אחד', text: S('גוף מנופח', 0), body: [
      `**ניפוח מקומי.** ${has('הצורה כגוף מעוגל וסגור. חינם, במכשיר.')}`,
      `**בקרת איכות.** ${S('בקרת איכות', 0, 1)}`,
      `**בינה מלאכותית.** ${has('Meshy משלים גם את הצד האחורי. דורש מפתח בתשלום.')}`,
    ] },
    { style: 'insight', title: 'המרחק מהקו הופך לגובה', text: S('גוף מנופח', 1) },
    app(S('גוף מנופח', 2), 'דף השיטה, גוף מנופח'),
    { style: 'fromto', title: 'מקו מתאר לתבליט', fromLabel: 'ציור', from: 'מזהים את קו המתאר, ממלאים את השטח הסגור.', toLabel: 'גוף', to: S('גוף מנופח', 2), text: S('בקרת איכות', 0) },
    haiku(['קו סגור על הדף', 'נושם ומתמלא אוויר', 'תבליט עגול'], 'שיטת **Teddy** (1999): הצללית מתנפחת מהמתאר.'),
  ], 'גוף מנופח'),

  T('depth', 'הבנה', 'מאיפה בא העומק', has(S('קטגוריות', 0)), [
    { style: 'veil', title: 'לכל סוג תמונה סימן משלו', text: S('קטגוריות', 1), ...IMG('house') },
    { style: 'fromto', title: 'מסימן בטוח לעומק רציף', fromLabel: 'סימן עומק', from: S('קטגוריות', 5), toLabel: 'דיפוזיה', to: S('קטגוריות', 6), text: has('ולכן כל נקודה בתמונה מחוברת לעומק, בלי חורים ובלי פער') + '.' },
    { style: 'essay', title: 'ארבע קטגוריות', text: S('קטגוריות', 0), body: [
      `**ציור.** ${S('קטגוריות', 1)}`, `**פסל.** ${S('קטגוריות', 2)}`, `**נוף וצילום.** ${S('קטגוריות', 3, 4)}`,
    ] },
    { style: 'insight', title: 'עומק בלי חורים ובלי פער', text: has('העומק זורם בתוך כתם ונעצר בקצה') + '.' },
    haiku(['חד קרוב, רך רחוק', 'צל עמוק באור רך', 'העומק זורם'], 'כל סימן נותן עומק רק במקום שבו הוא **בטוח**.'),
  ], 'קטגוריות'),

  T('landscape', 'הבנה', 'נוף: הקרקע נפרשת לעומק', has(S('נוף', 0)), [
    { style: 'gradient', title: 'אופק ישר, שמיים שקטים', text: S('נוף', 0) },
    { style: 'fromto', title: 'מציור שטוח לבמה', fromLabel: 'התחתית', from: has('התחתית קרובה והאופק רחוק'), toLabel: 'השמיים', to: has('השמיים עומדים כקיר אחורי'), text: S('נוף', 2) },
    { style: 'essay', title: 'מהמצלמה שציירה את התמונה', text: S('נוף', 0), body: [S('נוף', 1), S('נוף', 2), S('נוף', 3)] },
    { style: 'insight', title: '"חזית" חוזרת למבט של הציור', text: S('נוף', 4) },
    haiku(['קו אופק ישר', 'הקרקע נמתחת אחורה', 'סירה עומדת'], 'נוף נקרא כ**במה**, לא כדבר.'),
  ], 'נוף'),

  T('space', 'הבנה', 'ציור במרחב: משטח שקוף', has(S('ציור במרחב', 0)), [
    { style: 'poster', title: 'קו אחד, נמשך ישר אל תוך החלל', text: S('ציור במרחב', 1), ...IMG('sketch-side', 'center 45%') },
    app(S('ציור במרחב', 3), 'דף השיטה, ציור במרחב'),
    { style: 'insight', title: 'הקו הבא נוחת בעומק אחר', text: S('ציור במרחב', 1) },
    { style: 'essay', title: 'משטחים, חוט, יד', text: S('ציור במרחב', 0), body: [S('ציור במרחב', 2), S('ציור במרחב', 4), S('ציור במרחב', 5, 6)] },
    haiku(['משטח שקוף באוויר', 'מקיפים, והקו הבא', 'נוחת עמוק יותר'], 'כמו **פסלי התיל** של קלדר: העבודה נשארת חוט אחד.'),
  ], 'ציור במרחב'),

  T('prepare', 'יישום', 'לפני שמעלים ציור', has(METHOD_LEDE.split('. ')[0] + '.'), [
    { style: 'post', title: 'ארבעה דברים לפני ההעלאה', ...IMG('ink'), text: ['נושא', 'רקע', 'קו', 'זווית'].map((k) => `**${need(k).value}.** ${S(k, 0)}`).join('\n'), tags: ['ציור_לתלת_ממד', 'שיטה'] },
    app(METHOD_LEDE, 'דף השיטה'),
    { style: 'fromto', title: 'מחזית שטוחה לשלושה רבעים', fromLabel: 'חזית', from: has('חזית שטוחה נותנת גוף שטוח.'), toLabel: 'שלושה רבעים', to: S('זווית', 0), text: S('רקע', 1) },
    { style: 'insight', title: 'נושא אחד, רקע נקי', text: has('PNG, JPG או WEBP, עד 20MB. נושא אחד, רקע נקי.') },
    haiku(['דף לבן אחד', 'קו סגור, זווית קלה', 'הגוף מחכה'], 'פרשנות טובה מתחילה ב**ציור נקי**.'),
  ], 'שיטה'),

  T('print', 'יישום', 'מהמסך אל המדפסת', has(S('בקרת איכות', 1)), [
    { style: 'poster', title: 'חימר וקו', text: S('בדיקה', 0), ...IMG('line') },
    { style: 'insight', title: 'גוף סגור להדפסה', text: S('בקרת איכות', 0) },
    { style: 'fromto', title: 'מפסל על המסך לקובץ', fromLabel: 'בדיקה', from: S('בדיקה', 0), toLabel: 'הדפסה', to: S('הדפסה', 0), text: S('בקרת איכות', 1) },
    app(ledeOf('studio-title'), 'הסטודיו'),
    { style: 'essay', title: 'שלוש בדיקות לפני הדפסה', text: S('בקרת איכות', 1), body: [`**${need('בדיקה').value}.** ${S('בדיקה', 0)}`, `**${need('בקרת איכות').value}.** ${S('בקרת איכות', 0, 1)}`, `**${need('הדפסה').value}.** ${S('הדפסה', 0)}`] },
    haiku(['חימר בלי צבע', 'כל צלע בין שני משולשים', 'הגוף אטום'], 'מה שנבדק על המסך **מודפס** בלי הפתעות.'),
  ], 'בקרת איכות'),

  T('archive', 'יישום', 'כל עבודה נשמרת, ונבנית מחדש', has(ledeOf('archive-title').split('. ')[0] + '.'), [
    { style: 'poster', title: 'ארכיון העבודות', text: ledeOf('archive-title'), ...IMG('drawing') },
    { style: 'insight', title: 'פתיחה בונה את הפסל מחדש', text: has('פתיחה בונה את הפסל מחדש מהציור. נשמר בדפדפן הזה בלבד.') },
    { style: 'fromto', title: 'מעבודה לארכיון, ובחזרה', fromLabel: 'אחרי פיסול', from: has('אחרי פיסול לוחצים "שמירה לארכיון", והעבודה תופיע כאן.'), toLabel: 'פתיחה', to: has('פתיחה בונה את הפסל מחדש מהציור.'), text: has('בפיסול המקומי הציור לא יוצא מהמכשיר.') },
    app(has('מעלים ציור. הקו השחור הופך לחוט רציף במרחב, או לגוף סגור.'), 'הסטודיו'),
    haiku(['ציור, הגדרות', 'ותמונה של הפסל', 'נשמרים יחד'], 'הארכיון שומר את **הדרך**, לא רק את התוצאה.'),
  ], 'ארכיון'),
];

// מאגר המקורות ל"יצירת כתבה": כל שלב בשיטה, שלושת המנועים והמבואות
const ZONE = { 'נושא': 'יישום', 'רקע': 'יישום', 'קו': 'יישום', 'זווית': 'יישום', 'בדיקה': 'יישום', 'הדפסה': 'יישום', 'קו במרחב': 'ידע', 'גוף מנופח': 'ידע', 'בקרת איכות': 'ידע', 'קטגוריות': 'הבנה', 'נוף': 'הבנה', 'ציור במרחב': 'הבנה' };
const PIMG = { 'קו במרחב': 'wrap', 'גוף מנופח': 'clay', 'בקרת איכות': 'line', 'קטגוריות': 'house', 'ציור במרחב': 'sketch', 'קו': 'ink', 'זווית': 'house', 'בדיקה': 'clay', 'הדפסה': 'line' };
const pool = [];
for (const [k, zone] of Object.entries(ZONE)) {
  const m = need(k), ss = sents(m.text);
  const halves = ss.length >= 6 ? [ss.slice(0, Math.ceil(ss.length / 2)), ss.slice(Math.ceil(ss.length / 2))] : [ss];
  halves.forEach((part, i) => {
    const img = PIMG[k] ? IMG(PIMG[k]) : null;
    pool.push(T(`${['nose', 'reka', 'kav', 'zavit', 'bdika', 'hadpasa', 'thread', 'inflate', 'qa', 'depth', 'landscape', 'space'][Object.keys(ZONE).indexOf(k)]}${halves.length > 1 ? `-${i + 1}` : ''}`, zone, `${m.label}: ${m.value}${halves.length > 1 ? (i ? ' (המשך)' : '') : ''}`, part[0], [
      img && { style: 'poster', title: `${m.label}: ${m.value}`, text: part[0], ...img },
      { style: 'insight', title: m.value, text: part[part.length > 1 ? 1 : 0] },
      { style: 'essay', title: m.label, text: part[0], body: part.slice(1).length ? part.slice(1) : part },
      { style: 'post', title: `${m.label}: ${m.value}`, text: part.slice(0, 6).join('\n'), tags: ['ציור_לתלת_ממד', 'שיטה'] },
      !img && { style: 'gradient', title: m.label, text: part[0] },
    ], 'שיטה'));
  });
}
const ENGINES = [
  ['engine-line', 'קו במרחב', 'הקו כחוט רציף שמתלפף סביב הנפח, והצבע כענן. חינם, במכשיר.', 'wrap'],
  ['engine-inflate', 'גוף מנופח', 'הצורה כגוף מעוגל וסגור. חינם, במכשיר.', 'clay'],
  ['engine-ai', 'בינה מלאכותית', 'Meshy משלים גם את הצד האחורי. דורש מפתח בתשלום.', 'house'],
];
for (const [id, name, text, img] of ENGINES) pool.push(T(id, 'הבנה', `מנוע: ${name}`, has(text), [
  { style: 'veil', title: name, text, ...IMG(img) },
  { style: 'insight', title: 'מנוע: איך הציור יהפוך לגוף', text },
  app(METHOD_LEDE, 'דף השיטה'),
  { style: 'gradient', title: name, text: has('בלי מפתח Meshy אפשר להשתמש בפיסול המקומי, לצפות במודל לדוגמה ולפתוח קובץ תלת-ממד קיים.') },
], 'מנוע'));
pool.push(T('sketch-intro', 'הבנה', 'קו אחד, נמשך אל תוך החלל', has('מציירים על הדף כמו בעיפרון.'), [
  { style: 'poster', title: 'ציור במרחב', text: has('החוט מתלפף סביב הנפח, מלפנים, דרך השפה ומאחור.'), ...IMG('sketch') },
  { style: 'insight', title: 'הציור נקרא', text: has('הציור נקרא: קו המתאר יושב על שפת הגוף, הקו הפנימי על פניו.') },
  app('מציירים על הדף כמו בעיפרון.', 'ציור במרחב'),
  { style: 'gradient', title: 'עט: ציור במרחב', text: has('לחיצה ליד קו מתחילה ממנו, והמשטח עובר דרכו') + '.' },
], 'ציור במרחב'));

pool.push(T('studio-intro', 'יישום', 'ציור אחד, אובייקט שאפשר להקיף', ledeOf('studio-title'), [
  { style: 'poster', title: 'אובייקט שאפשר להקיף', text: ledeOf('studio-title'), ...IMG('clay') },
  { style: 'insight', title: 'פרשנות, ולא שחזור', text: METHOD_LEDE },
  app(has('בפיסול המקומי הציור לא יוצא מהמכשיר.'), 'דף השיטה'),
  { style: 'gradient', title: 'מודל: הורדה', text: has('PNG, JPG או WEBP, עד 20MB. נושא אחד, רקע נקי.') },
], 'סטודיו'));

// בדיקות התקן
for (const t of [...topics, ...pool]) {
  const st = t.creations.map((c) => c.style);
  if (new Set(st).size !== st.length) throw new Error(`עיצוב חוזר: ${t.id}`);
  if (st.length < 4 || st.length > 6) throw new Error(`ב-${t.id} ${st.length} יצירות`);
  if (plain(t.title).split(/\s+/).length > 8) throw new Error(`כותרת ארוכה: ${t.title}`);
  for (const c of t.creations) {
    if (c.style === 'haiku' && c.lines.length !== 3) throw new Error(`הייקו: ${t.id}`);
    if (c.style === 'post' && c.text.split('\n').length > 6) throw new Error(`פוסט ארוך: ${t.id}`);
    if (c.image && !fs.existsSync(path.join('public', c.image))) throw new Error(`תמונה חסרה: ${c.image}`);
    for (const f of ['text', 'quote', 'from', 'to']) if (c[f] === undefined && ['text'].includes(f) && c.style !== 'quote') throw new Error(`שדה ריק: ${t.id}/${c.style}`);
  }
}
if (topics.length < 6 || new Set(topics.map((t) => t.zone)).size < 3) throw new Error('צריך 6 חדרים לפחות ושלושה שלבים');
if (pool.length < 20) throw new Error(`מאגר קטן: ${pool.length}`);

const data = {
  app: {
    id: 'drawingtod3', name: 'ציור לתלת-ממד', url: 'https://drawing-to-3d-sigma.vercel.app', repo: 'Anat1969/DrawingToD3-GH',
    description: 'כתבות מתוך השיטה של ציור לתלת-ממד: איך קו על דף הופך לחוט, לגוף ולעומק, ועל איזה מחקר כל שלב נשען.',
    // גיליון שרטוט בדיו חום של חדר חשוך, עם אור החלון (ענבר) כצבע ההדגשה
    article: { layout: 'blueprint', css: '--ar-paper:#f7f3ec;--ar-mute:#6b5f4e;--ar-rule:#d8ccb8;background-image:linear-gradient(rgba(43,38,32,.10) .1cqw,transparent .1cqw),linear-gradient(90deg,rgba(43,38,32,.10) .1cqw,transparent .1cqw),linear-gradient(rgba(43,38,32,.045) .08cqw,transparent .08cqw),linear-gradient(90deg,rgba(43,38,32,.045) .08cqw,transparent .08cqw);& .ar-bp-c1 .ar-body{color:#2b2620}' },
    palette: {
      bp: '#2b2620', a: '#b8803f', b: '#e58f7b', c: '#6f6a52', s: '#6f6a52', accent: '#b8803f', marker: '#f2c98a',
      ink: '#14120f', paper: '#f7f3ec', paper2: '#ece6da', 'b-wash': '#f8e7e1', 's-wash': '#ebeadf',
    },
  },
  topics,
  pool,
};
fs.writeFileSync('public/creations.json', JSON.stringify(data, null, 2) + '\n');
console.log(`${topics.length} חדרים, ${topics.reduce((n, t) => n + t.creations.length, 0)} יצירות, ${pool.length} מקורות במאגר`);
