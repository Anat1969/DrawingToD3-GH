# פרומפט בנייה ל-Claude Code

## פקודה להתחלה
```
uipro init --ai claude
```

## הפרומפט
```
Build a Hebrew RTL web app named "ציור לתלת-ממד" (no icons, clear navigation).

Goal: the user uploads a 2D drawing (PNG, JPG or WEBP up to 20MB), the app converts it to a 3D model, shows the model in an interactive viewer where it can be rotated 360 degrees, and lets the user download the result as GLB or STL.

Read docs/spec.md, docs/technical.md and docs/test-plan.md first. Follow them.

Architecture:
- Frontend: a single static page using Three.js 0.150.1 (cdnjs for three.min.js, jsDelivr for the loaders). Start from model-viewer.html, which already loads STL, OBJ and GLB and shows a 360 degree viewer. Keep it.
- Backend: a small FastAPI server with endpoints POST /api/convert, GET /api/jobs/{job_id}, GET /api/jobs/{job_id}/model.
- Generator adapters in server/adapters/: hunyuan.py (local Hunyuan3D service on a GPU) and meshy.py (Meshy API). Implement the adapter interface first and make Hunyuan3D the default. Meshy is optional and only used if MESHY_API_KEY is set.

Rules:
- Secrets only in .env (MESHY_API_KEY, HUNYUAN_URL). Never in the frontend, never committed.
- Validate file type and size on the server, not only in the browser.
- Delete temporary input and output files after a set time.
- Show all states: empty, uploading, processing with progress, done, failed with a clear message.
- Top bar on every page: app name links to the home page, plus the AI menu per the repo standard.

Before writing code, verify the current Hunyuan3D repository instructions (install steps, VRAM requirement) and the current Meshy API endpoint format. Do not guess them.

Start with the MVP only: one image, one conversion, viewer, GLB download. Write tests from docs/test-plan.md. Report what was tested and what was not.
```

## הערות לשימוש
- לפני הפרומפט, לוודא שהמחשב מזוהה עם GPU אם מתכננים Hunyuan3D מקומית (ראי setup-hardware.md).
- אם המחשב עדיין ללא GPU, לבחור Meshy וכתוב אותו בפרומפט במקום Hunyuan3D כברירת מחדל.
