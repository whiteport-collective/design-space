// list-media-folders v1 — WO-003 Mobile Publishing Pipeline
//
// Lists Google Drive article folders from Whiteport Team Shared Drive.
// Returns recent Communication/ and Events/ folders for mobile-Ivonne's
// routing prompt: "Vilken mapp bor det här i?"
//
// POST { action: "list", search?: string, limit?: number }
//
// Auth: PUBLISH_SECRET bearer token
// Drive auth: GOOGLE_SERVICE_ACCOUNT_JSON (same as astro-gdrive)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// Folder name pattern: "YYYY-MM-DD anything"
const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}\s/;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface DriveFolder {
  id: string;
  name: string;
  modifiedTime: string;
}

// ── JWT / Auth ──

function b64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodeJSON(obj: object): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function getGoogleAccessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJSON({ alg: "RS256", typ: "JWT" });
  const payload = encodeJSON({
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  const unsigned = `${header}.${payload}`;

  // Parse PEM private key
  const pem = key.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );

  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ── Drive API ──

async function driveGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${DRIVE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function findSharedDrive(token: string, name: string): Promise<string> {
  const data = await driveGet(token, `/drives?pageSize=20`) as { drives?: { id: string; name: string }[] };
  const drive = data.drives?.find((d) => d.name === name);
  if (!drive) throw new Error(`Shared Drive "${name}" not found. Check service account is a member.`);
  return drive.id;
}

async function findFolderInDrive(token: string, driveId: string, folderName: string): Promise<string> {
  const q = encodeURIComponent(
    `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const data = await driveGet(
    token,
    `/files?q=${q}&driveId=${driveId}&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=drive&fields=files(id,name)`,
  ) as { files?: { id: string; name: string }[] };

  const folder = data.files?.[0];
  if (!folder) throw new Error(`Folder "${folderName}" not found in Shared Drive.`);
  return folder.id;
}

async function listDateFolders(
  token: string,
  driveId: string,
  parentId: string,
  search: string | null,
): Promise<DriveFolder[]> {
  const nameFilter = search
    ? `and name contains '${search.replace(/'/g, "\\'")}'`
    : "";

  const q = encodeURIComponent(
    `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false ${nameFilter}`,
  );

  const data = await driveGet(
    token,
    `/files?q=${q}&driveId=${driveId}&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=drive&orderBy=name%20desc&pageSize=50&fields=files(id,name,modifiedTime)`,
  ) as { files?: DriveFolder[] };

  return (data.files ?? []).filter((f) => DATE_FOLDER_RE.test(f.name));
}

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
}

// ── Handler ──

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // Auth
  const secret = Deno.env.get("PUBLISH_SECRET");
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json() as { action?: string; search?: string; limit?: number };
    const { search = null, limit = 10 } = body;

    // Load service account
    const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
    if (!saJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set in Supabase secrets.");
    const saKey: ServiceAccountKey = JSON.parse(saJson);

    const token = await getGoogleAccessToken(saKey);

    // Find Shared Drive
    const driveId = await findSharedDrive(token, "Whiteport Team");

    // Find Communication and Events folder IDs
    const [commId, eventsId] = await Promise.all([
      findFolderInDrive(token, driveId, "Communication"),
      findFolderInDrive(token, driveId, "Events"),
    ]);

    // List dated subfolders in both
    const [commFolders, eventFolders] = await Promise.all([
      listDateFolders(token, driveId, commId, search),
      listDateFolders(token, driveId, eventsId, search),
    ]);

    const format = (folders: DriveFolder[], type: "Communication" | "Events") =>
      folders.slice(0, limit).map((f) => ({
        name: f.name,
        path: `${type}/${f.name}`,
        type,
        age_days: daysSince(f.modifiedTime),
      }));

    return new Response(
      JSON.stringify({
        communication: format(commFolders, "Communication"),
        events: format(eventFolders, "Events"),
        search_query: search,
        drive_id: driveId,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
