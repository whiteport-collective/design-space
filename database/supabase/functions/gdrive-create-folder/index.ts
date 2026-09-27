import {
  CORS,
  assertUnderRoot,
  createFolder,
  ensureArticlesRoot,
  findFolderByName,
  findSharedDrive,
  folderUrl,
  getAccessToken,
  handleError,
  json,
  mediaFolderPath,
} from "../_shared/gdrive_articles.ts";

interface CreateFolderBody {
  name?: string;
  parent_id?: string | null;
}

function cleanName(input: string): string {
  return input
    .replace(/[\\/:*?"<>|#%{}[\]^~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function uniqueFolderName(
  token: string,
  driveId: string,
  parentId: string,
  baseName: string,
): Promise<{ name: string; collision: boolean }> {
  let candidate = baseName;
  for (let index = 1; index <= 100; index += 1) {
    const existing = await findFolderByName(token, driveId, candidate, parentId);
    if (!existing) return { name: candidate, collision: index > 1 };
    candidate = `${baseName} (${index + 1})`;
  }
  return { name: `${baseName} (${crypto.randomUUID().slice(0, 8)})`, collision: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json() as CreateFolderBody;
    const baseName = cleanName(body.name ?? "");
    if (!baseName) return json({ error: "name is required" }, 400);

    const token = await getAccessToken();
    const driveId = await findSharedDrive(token);
    const articlesRoot = await ensureArticlesRoot(token, driveId);

    const parentId = body.parent_id ?? articlesRoot.id;
    const parentChain = await assertUnderRoot(token, parentId, articlesRoot.id);
    const { name, collision } = await uniqueFolderName(token, driveId, parentId, baseName);
    const folder = await createFolder(token, driveId, name, parentId);

    return json({
      folder_id: folder.id,
      folder_url: folderUrl(folder.id),
      folder_name: folder.name,
      media_folder_path: mediaFolderPath([...parentChain, folder]),
      name_collision: collision,
    });
  } catch (err) {
    return handleError(err);
  }
});
