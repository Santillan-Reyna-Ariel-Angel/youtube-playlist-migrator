import dotenv from "dotenv";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

dotenv.config();

const SCOPES = ["https://www.googleapis.com/auth/youtube"];
const DEFAULT_REDIRECT_URI = "http://localhost:3000";
const ACCOUNT_PROMPTS = {
  source: {
    title: "CUENTA ORIGEN",
    detail: "la cuenta de YouTube de donde se LEERÁ la playlist a copiar",
  },
  dest: {
    title: "CUENTA DESTINO",
    detail: "la cuenta de YouTube donde se CREARÁ la playlist nueva",
  },
};
const TOKEN_STORE_FILE = fileURLToPath(new URL(".youtube-refresh-tokens.json", import.meta.url));

function requireEnv(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

function getConfig() {
  return {
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirectUri: requireEnv("GOOGLE_REDIRECT_URI", DEFAULT_REDIRECT_URI),
    sourceRefreshToken: process.env.SOURCE_REFRESH_TOKEN,
    destRefreshToken: process.env.DEST_REFRESH_TOKEN,
    destPlaylistTitle: process.env.DEST_PLAYLIST_TITLE,
    destPlaylistId: process.env.DEST_PLAYLIST_ID,
    destPrivacyStatus: process.env.DEST_PRIVACY_STATUS || "private",
  };
}

async function loadTokenStore() {
  try {
    const raw = await readFile(TOKEN_STORE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function saveTokenStore(store) {
  await writeFile(TOKEN_STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function buildExportFileName(playlistId) {
  // Un único archivo por playlist: el ID es la clave que permite reanudar.
  return `playlist-${playlistId}.json`;
}

function getExportPath(playlistId) {
  return fileURLToPath(new URL(buildExportFileName(playlistId), import.meta.url));
}

async function savePlaylistExport(playlistInfo, items) {
  const filePath = getExportPath(playlistInfo.id);

  // Si ya existe un backup de esta playlist, preservamos el destPlaylistId
  // guardado en una corrida anterior para no perder la reanudación automática.
  let previousDestPlaylistId = null;
  try {
    const previous = JSON.parse(await readFile(filePath, "utf8"));
    previousDestPlaylistId = previous.destPlaylistId ?? null;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    playlist: playlistInfo,
    destPlaylistId: previousDestPlaylistId,
    totalVideos: items.length,
    videos: items,
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return filePath;
}

async function promptInput(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function extractPlaylistId(input) {
  const value = (input || "").trim();
  // Acepta una URL (https://www.youtube.com/playlist?list=PLxxxx) o el ID pelado.
  const match = value.match(/[?&]list=([^&]+)/);
  return match ? match[1] : value;
}

async function resolveSourcePlaylistId() {
  const answer = await promptInput(
    "Ingresá el ID o la URL de la playlist ORIGEN: "
  );
  const playlistId = extractPlaylistId(answer);

  if (!playlistId) {
    throw new Error("No ingresaste un ID de playlist válido.");
  }

  return playlistId;
}

function openUrl(url) {
  const platform = process.platform;

  if (platform === "win32") {
    // En Windows, cmd interpreta `&` como separador de comandos y corta la URL
    // en el primer parámetro. Hay que pasarla entre comillas como un solo
    // argumento y desactivar el escaping propio de Node con windowsVerbatimArguments.
    spawn("cmd", ["/c", "start", '""', `"${url}"`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    }).unref();
    return;
  }

  const command = platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function createOAuthClient(config) {
  return new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri
  );
}

function getRedirectTarget(config) {
  return new URL(config.redirectUri);
}

async function getAuthCodeFromBrowser(config, authUrl) {
  const redirectTarget = getRedirectTarget(config);
  const port = Number(redirectTarget.port || 80);
  const expectedPath = redirectTarget.pathname;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url || "/", `http://localhost:${port}`);

      if (requestUrl.pathname !== expectedPath) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        res.statusCode = 400;
        res.end(`Error en la autorización: ${error}`);
        server.close();
        reject(new Error(`Error en la autorización: ${error}`));
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.end("No se recibió el código de autorización.");
        return;
      }

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<h1>Autorización completada</h1><p>Ya podés volver a la terminal.</p>"
      );
      server.close();
      resolve(code);
    });

    server.on("error", reject);

    server.listen(port, redirectTarget.hostname, () => {
      console.log("Se abrió el navegador para autorizar la cuenta...");
      openUrl(authUrl);
      console.log(`Si no se abre solo, visitá esta URL:\n${authUrl}`);
    });
  });
}

function createYoutubeClient(config, refreshToken) {
  const oauth2Client = createOAuthClient(config);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return {
    oauth2Client,
    youtube: google.youtube({ version: "v3", auth: oauth2Client }),
  };
}

async function getPlaylistInfo(youtube, playlistId) {
  const response = await youtube.playlists.list({
    part: "snippet,contentDetails",
    id: playlistId,
    maxResults: 1,
  });

  const playlist = response.data.items?.[0];
  if (!playlist) {
    throw new Error(`No se encontró la playlist ${playlistId}`);
  }

  return {
    id: playlist.id,
    title: playlist.snippet?.title || "",
    description: playlist.snippet?.description || "",
    channelTitle: playlist.snippet?.channelTitle || "",
    itemCount: playlist.contentDetails?.itemCount ?? null,
  };
}

async function getPlaylistItems(youtube, playlistId) {
  const items = [];
  let pageToken;

  do {
    const response = await youtube.playlistItems.list({
      part: "snippet,contentDetails",
      playlistId,
      maxResults: 50,
      pageToken,
    });

    const pageItems = response.data.items || [];
    for (const item of pageItems) {
      const videoId = item?.snippet?.resourceId?.videoId;
      if (!videoId) {
        continue;
      }

      items.push({
        videoId,
        title: item?.snippet?.title || "",
        channelTitle: item?.snippet?.videoOwnerChannelTitle || "",
        position: item?.snippet?.position ?? null,
        publishedAt: item?.contentDetails?.videoPublishedAt || null,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      });
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return items;
}

async function createPlaylist(youtube, title, privacyStatus) {
  const response = await youtube.playlists.insert({
    part: "snippet,status",
    requestBody: {
      snippet: { title },
      status: { privacyStatus },
    },
  });

  return response.data.id;
}

async function addVideoToPlaylist(youtube, playlistId, videoId) {
  await youtube.playlistItems.insert({
    part: "snippet",
    requestBody: {
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId },
      },
    },
  });
}

function buildAuthUrl(config) {
  const oauth2Client = createOAuthClient(config);

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    response_type: "code",
    scope: SCOPES,
  });
}

async function exchangeCodeForTokens(config, code) {
  const oauth2Client = createOAuthClient(config);
  const { tokens } = await oauth2Client.getToken(code);

  return tokens;
}

async function authorizeAccount(config, accountLabel) {
  const oauth2Client = createOAuthClient(config);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    response_type: "code",
    scope: SCOPES,
  });

  const prompt = ACCOUNT_PROMPTS[accountLabel] || {
    title: accountLabel.toUpperCase(),
    detail: "",
  };

  console.log("\n============================================================");
  console.log(`  Iniciá sesión con tu ${prompt.title}.`);
  if (prompt.detail) {
    console.log(`  Es ${prompt.detail}.`);
  }
  console.log("  En unos segundos se abrirá el navegador...");
  console.log("============================================================\n");

  // Pequeña pausa para que el usuario alcance a leer antes de que se abra el navegador.
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const code = await getAuthCodeFromBrowser(config, authUrl);
  const tokens = await exchangeCodeForTokens(config, code);

  if (!tokens.refresh_token) {
    throw new Error(
      `No se obtuvo refresh_token para la cuenta ${accountLabel}. Volvé a intentar la autorización.`
    );
  }

  return tokens.refresh_token;
}

async function resolveRefreshToken(config, accountLabel, envToken, store) {
  if (envToken) {
    return envToken;
  }

  if (store?.[accountLabel]?.refreshToken) {
    return store[accountLabel].refreshToken;
  }

  const refreshToken = await authorizeAccount(config, accountLabel);
  store[accountLabel] = {
    refreshToken,
    savedAt: new Date().toISOString(),
  };
  await saveTokenStore(store);

  return refreshToken;
}

// FASE 1: lee la playlist origen y la guarda en un JSON (un archivo por playlist).
async function exportPlaylist(config) {
  const sourcePlaylistId = await resolveSourcePlaylistId();

  const tokenStore = await loadTokenStore();
  const sourceRefreshToken = await resolveRefreshToken(
    config,
    "source",
    config.sourceRefreshToken,
    tokenStore
  );
  const { youtube: sourceYoutube } = createYoutubeClient(
    config,
    sourceRefreshToken
  );

  console.log("Leyendo playlist origen...");
  const playlistInfo = await getPlaylistInfo(sourceYoutube, sourcePlaylistId);
  const items = await getPlaylistItems(sourceYoutube, sourcePlaylistId);
  console.log(`Playlist origen: ${playlistInfo.title}`);
  console.log(`Videos encontrados: ${items.length}`);

  const exportPath = await savePlaylistExport(playlistInfo, items);
  console.log(`Backup guardado en: ${exportPath}`);

  return exportPath;
}

async function loadPlaylistExport(filePath) {
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data.videos)) {
    throw new Error(`El archivo ${filePath} no tiene una lista de videos válida`);
  }

  return data;
}

// La API de YouTube devuelve quotaExceeded/dailyLimitExceeded cuando se agota
// la cuota diaria (10.000 unidades; cada insert cuesta 50 → ~200 videos/día).
function isQuotaError(error) {
  const reasons =
    error?.errors || error?.response?.data?.error?.errors || [];
  const byReason = reasons.some(
    (e) => e.reason === "quotaExceeded" || e.reason === "dailyLimitExceeded"
  );
  return byReason || /exceeded your.*quota/i.test(error?.message || "");
}

// FASE 2: toma los datos de un backup y los recrea en la cuenta destino.
async function importPlaylist(config, data) {
  const tokenStore = await loadTokenStore();
  const destRefreshToken = await resolveRefreshToken(
    config,
    "dest",
    config.destRefreshToken,
    tokenStore
  );
  const { youtube: destYoutube } = createYoutubeClient(
    config,
    destRefreshToken
  );

  // Prioridad: el arg/env explícito gana sobre el guardado en el JSON.
  let destinationPlaylistId = config.destPlaylistId || data.destPlaylistId;
  let existingVideoIds = new Set();

  if (destinationPlaylistId) {
    // Reanudar sobre una playlist existente: leemos qué ya tiene para no duplicar.
    console.log(`Usando playlist destino existente: ${destinationPlaylistId}`);
    const existing = await getPlaylistItems(destYoutube, destinationPlaylistId);
    existingVideoIds = new Set(existing.map((video) => video.videoId));
    console.log(`Videos ya presentes en el destino: ${existingVideoIds.size}`);
  } else {
    const title =
      config.destPlaylistTitle || data.playlist?.title || "Mi Playlist Migrada";
    console.log("Creando playlist destino...");
    destinationPlaylistId = await createPlaylist(
      destYoutube,
      title,
      config.destPrivacyStatus
    );
    console.log(`Playlist creada: ${destinationPlaylistId}`);
  }

  const videos = data.videos;
  const failed = [];
  let added = 0;
  let skipped = 0;
  let quotaHit = false;

  for (let index = 0; index < videos.length; index += 1) {
    const { videoId, title: videoTitle } = videos[index];
    const label = videoTitle || videoId;

    if (existingVideoIds.has(videoId)) {
      skipped += 1;
      console.log(`Ya existe ${index + 1}/${videos.length}: ${label}`);
      continue;
    }

    try {
      await addVideoToPlaylist(destYoutube, destinationPlaylistId, videoId);
      added += 1;
      console.log(`Agregado ${index + 1}/${videos.length}: ${label}`);
    } catch (error) {
      if (isQuotaError(error)) {
        // No tiene sentido seguir: el resto fallaría igual. Cortamos limpio.
        quotaHit = true;
        console.error(
          `\nCuota diaria de la API agotada en el video ${index + 1}/${videos.length}.`
        );
        break;
      }
      // Un video borrado/privado no debe abortar toda la importación.
      failed.push({ videoId, title: videoTitle, reason: error?.message || String(error) });
      console.warn(`Falló ${index + 1}/${videos.length}: ${label} (${error?.message || error})`);
    }
  }

  console.log("\nResumen:");
  console.log(`  Playlist destino: ${destinationPlaylistId}`);
  console.log(`  Agregados ahora: ${added}`);
  console.log(`  Ya existían (saltados): ${skipped}`);
  console.log(`  Fallidos (borrados/privados): ${failed.length}`);

  if (quotaHit) {
    console.log(
      "\nLa cuota se reinicia a medianoche hora del Pacífico (PT)."
    );
    console.log("Mañana, para CONTINUAR sin duplicar, corré `pnpm run start`");
    const sourceId = data.playlist?.id;
    if (sourceId) {
      console.log(`y volvé a ingresar el mismo ID de playlist: ${sourceId}`);
    } else {
      console.log("y volvé a ingresar el mismo ID de playlist.");
    }
  }

  return { destinationPlaylistId, added, skipped, failed, quotaHit };
}

async function importPlaylistFromFile(config, filePath) {
  console.log(`Leyendo backup: ${filePath}`);
  const data = await loadPlaylistExport(filePath);
  console.log(`Videos en el backup: ${data.videos.length}`);

  const result = await importPlaylist(config, data);

  // Guardamos el destPlaylistId en el JSON para reanudar solo la próxima vez.
  if (
    result.destinationPlaylistId &&
    data.destPlaylistId !== result.destinationPlaylistId
  ) {
    data.destPlaylistId = result.destinationPlaylistId;
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  return result;
}

// Atajo: exporta y luego importa desde el archivo recién creado.
// El JSON es la única fuente de verdad, así migrate e import se comportan igual.
async function migrate(config) {
  // SETUP: autenticamos ambas cuentas PRIMERO (el login no consume cuota de la API),
  // de corrido, para no frenar la migración a mitad de camino pidiendo un segundo login.
  // resolveRefreshToken cachea los tokens en disco; las fases siguientes los reutilizan,
  // así que aunque el ID se ingrese mal después, no hay que volver a loguearse.
  const tokenStore = await loadTokenStore();
  await resolveRefreshToken(config, "source", config.sourceRefreshToken, tokenStore);
  await resolveRefreshToken(config, "dest", config.destRefreshToken, tokenStore);

  // EJECUCIÓN: ya autenticados, pedimos el ID y migramos.
  const exportPath = await exportPlaylist(config);
  return importPlaylistFromFile(config, exportPath);
}

async function main() {
  const config = getConfig();
  const [command, account, value] = process.argv.slice(2);

  if (!command || command === "migrate") {
    await migrate(config);
    return;
  }

  if (command === "export") {
    await exportPlaylist(config);
    return;
  }

  if (command === "import") {
    if (!account) {
      throw new Error(
        "Uso: node migrate-playlist.js import <archivo.json> [destPlaylistId]"
      );
    }
    // Si pasás un destPlaylistId, importa sobre esa playlist (modo reanudar).
    if (value) {
      config.destPlaylistId = value;
    }
    await importPlaylistFromFile(config, account);
    return;
  }

  if (command === "auth-url") {
    console.log(buildAuthUrl(config));
    return;
  }

  if (command === "exchange-code") {
    if (!account || !value || !["source", "dest"].includes(account)) {
      throw new Error(
        "Uso: node migrate-playlist.js exchange-code source|dest CODIGO"
      );
    }

    const tokens = await exchangeCodeForTokens(config, value);
    console.log(JSON.stringify(tokens, null, 2));
    return;
  }

  throw new Error(
    [
      "Comandos disponibles:",
      "  node migrate-playlist.js migrate",
      "  node migrate-playlist.js export",
      "  node migrate-playlist.js import <archivo.json> [destPlaylistId]",
      "  node migrate-playlist.js auth-url",
      "  node migrate-playlist.js exchange-code source CODIGO",
      "  node migrate-playlist.js exchange-code dest CODIGO",
    ].join("\n")
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});