# Cloud Run CIM Service

This service accepts direct PDF uploads and runs Gemini-based CIM extraction outside Vercel's upload limits.

## Required environment variables

- `GEMINI_API_KEY`
- `ALLOWED_ORIGINS`
- `CIM_SHARED_SECRET`

Optional:

- `GEMINI_EXTRACTION_MODEL`

## Local run

```powershell
cd cloud-run-cim
npm install
$env:GEMINI_API_KEY="your-key"
$env:ALLOWED_ORIGINS="https://your-vercel-app.vercel.app,http://localhost:3000"
$env:CIM_SHARED_SECRET="your-shared-secret"
npm start
```

## Deploy to Cloud Run

From the repo root:

```powershell
gcloud run deploy cim-extraction-service `
  --source cloud-run-cim `
  --region europe-west2 `
  --allow-unauthenticated `
  --set-env-vars GEMINI_API_KEY=your-key,ALLOWED_ORIGINS=https://your-vercel-app.vercel.app,CIM_SHARED_SECRET=your-shared-secret
```

Set the same `CIM_SHARED_SECRET` value in Vercel for the frontend app so `/api/cim-access-token` can mint short-lived access tokens for Cloud Run.
