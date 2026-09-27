const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  modifiedTime?: string;
  thumbnailLink?: string;
}

export class HttpError extends Error {
  status: number;
  retryAfter?: string;

  constructor(status: number, message: string, retryAfter?: string) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, ...extraHeaders, "Content-Type": "application/json" },
  });
}

export function getServiceAccount(): ServiceAccountKey {
  const raw =
    Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")?.trim() ??
    Deno.env.get("GDRIVE_SERVICE_ACCOUNT_JSON")?.trim() ??
    Deno.env.get("GDRIVE_SERVICE_ACCOUNT")?.trim();

  if (!raw) {
    throw new HttpError(
      500,
      "missing GDRIVE_SERVICE_ACCOUNT: set GOOGLE_SERVICE_ACCOUNT_JSON in Supabase secrets",
    );
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(500, "invalid GOOGLE_SERVICE_ACCOUNT_JSON");
  }
}

function b64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function encodeJson(obj: object): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function getAccessToken(key = getServiceAccount()): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    encodeJson({ alg: "RS256", typ: "JWT" }),
    encodeJson({
      iss: key.client_email,
      scope: DRIVE_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  ].join(".");

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

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(new Uint8Array(signature))}`,
    }),
  });

  if (!response.ok) {
    throw new HttpError(500, `Google token exchange failed: ${await response.text()}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.token;
}

export async function driveRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    const text = await response.text();
    const message = response.status === 429
      ? "Drive API rate limit"
      : `Drive API error ${response.status}: ${text}`;
    throw new HttpError(response.status, message, retryAfter);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function quoteQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function findSharedDrive(token: string, name = "Whiteport Team"): Promise<string> {
  const data = await driveRequest<{ drives?: { id: string; name: string }[] }>(
    token,
    `/drives?pageSize=100&fields=drives(id,name)`,
  );
  const drive = data.drives?.find((candidate) => candidate.name === name);
  if (!drive) {
    throw new HttpError(404, `Shared Drive "${name}" not found`);
  }
  return drive.id;
}

export async function findFolderByName(
  token: string,
  driveId: string,
  name: string,
  parentId?: string,
): Promise<DriveFile | null> {
  const parentClause = parentId ? ` and '${quoteQuery(parentId)}' in parents` : "";
  const q = encodeURIComponent(
    `name = '${quoteQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false${parentClause}`,
  );

  const data = await driveRequest<{ files?: DriveFile[] }>(
    token,
    `/files?q=${q}&driveId=${driveId}&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=drive&pageSize=10&fields=files(id,name,mimeType,parents)`,
  );

  return data.files?.[0] ?? null;
}

export async function createFolder(
  token: string,
  driveId: string,
  name: string,
  parentId: string,
): Promise<DriveFile> {
  return driveRequest<DriveFile>(
    token,
    `/files?supportsAllDrives=true&fields=id,name,mimeType,parents`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      }),
    },
  );
}

export async function ensureArticlesRoot(token: string, driveId: string): Promise<DriveFile> {
  const existing = await findFolderByName(token, driveId, "Articles");
  if (existing) return existing;
  return createFolder(token, driveId, "Articles", driveId);
}

export async function getFile(token: string, fileId: string): Promise<DriveFile> {
  try {
    return await driveRequest<DriveFile>(
      token,
      `/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,parents,size,modifiedTime,thumbnailLink`,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new HttpError(404, "folder not found or not accessible");
    }
    throw err;
  }
}

export async function listChildren(token: string, driveId: string, folderId: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${quoteQuery(folderId)}' in parents and trashed = false`);
  const data = await driveRequest<{ files?: DriveFile[] }>(
    token,
    `/files?q=${q}&driveId=${driveId}&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=drive&orderBy=modifiedTime%20desc&pageSize=100&fields=files(id,name,mimeType,size,modifiedTime,thumbnailLink)`,
  );
  return data.files ?? [];
}

export async function assertUnderRoot(
  token: string,
  folderId: string,
  articlesRootId: string,
): Promise<DriveFile[]> {
  const chain: DriveFile[] = [];
  let current = await getFile(token, folderId);

  for (let depth = 0; depth < 25; depth += 1) {
    chain.unshift(current);
    if (current.id === articlesRootId) return chain;
    const parentId = current.parents?.[0];
    if (!parentId) break;
    current = await getFile(token, parentId);
  }

  throw new HttpError(403, "folder not under Whiteport/Articles/");
}

export function mediaFolderPath(chainFromArticles: DriveFile[]): string {
  return chainFromArticles.map((file) => file.name).join("/");
}

export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export function folderIdFromUrl(url: string): string | null {
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function handleError(err: unknown): Response {
  if (err instanceof HttpError) {
    const headers: Record<string, string> = err.retryAfter ? { "Retry-After": err.retryAfter } : {};
    return json({ error: err.message }, err.status, headers);
  }
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: message }, 500);
}
