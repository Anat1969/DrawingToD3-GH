// Client for the two serverless endpoints.
export const ERRORS = {
  no_file: 'לא נבחר קובץ.',
  unsupported_type: 'סוג הקובץ לא נתמך. בוחרים PNG, JPG או WEBP.',
  file_too_large: 'הקובץ גדול מ-20MB. בוחרים קובץ קטן יותר.',
  too_large: 'הציור גדול מדי גם אחרי הקטנה. בוחרים תמונה פשוטה יותר.',
  server_not_configured: 'שירות ההמרה עדיין לא מחובר בשרת. אפשר לפתוח קובץ תלת-ממד קיים או לצפות במודל לדוגמה.',
  generator_unreachable: 'שירות ההמרה לא זמין כרגע. נסו שוב בעוד כמה דקות.',
  generator_rejected: 'שירות ההמרה דחה את הבקשה. נסו ציור אחר.',
  generator_bad_response: 'שירות ההמרה החזיר תשובה לא צפויה.',
  no_credits: 'נגמרו הקרדיטים בחשבון שירות ההמרה.',
  rate_limited: 'יותר מדי בקשות בבת אחת. נסו שוב בעוד דקה.',
  not_found: 'ההמרה לא נמצאה. ייתכן שפג תוקפה.',
  invalid_id: 'מזהה ההמרה לא תקין.',
  network: 'אין חיבור לשרת. בודקים את החיבור לאינטרנט ומנסים שוב.',
  failed: 'ההמרה נכשלה. נסו ציור עם נושא ברור יותר.',
  no_subject: 'לא נמצא נושא בציור. נסו ציור עם קו ברור על רקע בהיר.',
  no_background: 'הציור ממלא את כל הדף, ואין רקע להפריד ממנו. חותכים את הציור כך שיישאר שוליים בהירים, או מצלמים על רקע אחיד.',
  read: 'לא ניתן לקרוא את הציור. בוחרים תמונה אחרת.',
};

export class ApiError extends Error {
  constructor(code, detail) {
    super(ERRORS[code] || ERRORS.failed);
    this.code = code;
    this.detail = detail;
  }
}

async function call(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'failed');
  return data;
}

export function startConversion(image, texture) {
  return call('/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, texture }),
  });
}

export function getStatus(id) {
  return call('/api/status?id=' + encodeURIComponent(id), { cache: 'no-store' });
}
