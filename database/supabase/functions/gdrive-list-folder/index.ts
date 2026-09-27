import {
  CORS,
  assertUnderRoot,
  ensureArticlesRoot,
  findSharedDrive,
  folderIdFromUrl,
  getAccessToken,
  getFile,
  handleError,
  json,
  listChildren,
  mediaFolderPath,
} from "../_shared/gdrive_articles.ts";

interface ListFolderBody {
  folder_url?: string;
  folder_id?: string;
}

function classify(file: { mimeType: string; name: string }) {
  const name = file.name.toLowerCase();
  const isImage = file.mimeType.startsWith("image/");
  const isAudio = file.mimeType.startsWith("audio/");
  const isText =
    file.mimeType.startsWith("text/") ||
    file.mimeType === "application/vnd.google-apps.document" ||
    /\.(md|markdown|txt|docx?)$/i.test(name);

  const rank = isImage ? 0 : isAudio ? 1 : isText ? 2 : 3;
  return { isImage, isAudio, isText, rank };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json() as ListFolderBody;
    const folderId = body.folder_id ?? (body.folder_url ? folderIdFromUrl(body.folder_url) : null);
    if (!folderId) return json({ error: "folder_id or folder_url is required" }, 400);

    const token = await getAccessToken();
    const driveId = await findSharedDrive(token);
    const articlesRoot = await ensureArticlesRoot(token, driveId);
    const folder = await getFile(token, folderId);
    const chain = await assertUnderRoot(token, folder.id, articlesRoot.id);
    const children = await listChildren(token, driveId, folder.id);

    const files = children
      .map((file) => {
        const category = classify(file);
        return {
          id: file.id,
          name: file.name,
          mime_type: file.mimeType,
          size: file.size ? Number(file.size) : null,
          modified: file.modifiedTime ?? null,
          thumbnail_url: file.thumbnailLink ?? null,
          is_image: category.isImage,
          is_audio: category.isAudio,
          is_text: category.isText,
          rank: category.rank,
        };
      })
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return Date.parse(b.modified ?? "1970-01-01") - Date.parse(a.modified ?? "1970-01-01");
      })
      .map(({ rank: _rank, ...file }) => file);

    return json({
      folder_id: folder.id,
      folder_name: folder.name,
      media_folder_path: mediaFolderPath(chain),
      files,
    });
  } catch (err) {
    return handleError(err);
  }
});
