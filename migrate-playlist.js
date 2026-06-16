import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/youtube"];
const DEFAULT_REDIRECT_URI = "http://localhost:3000/oauth2callback";
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
    sourcePlaylistId: process.env.SOURCE_PLAYLIST_ID,
    destPlaylistTitle: process.env.DEST_PLAYLIST_TITLE || "Mi Playlist Migrada",
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

function openUrl(url) {
  const platform = process.platform;

  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
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

async function getPlaylistItems(youtube, playlistId) {
  const videoIds = [];
  let pageToken;

  do {
    const response = await youtube.playlistItems.list({
      part: "snippet",
      playlistId,
      maxResults: 50,
      pageToken,
    });

    const items = response.data.items || [];
    for (const item of items) {
      const videoId = item?.snippet?.resourceId?.videoId;
      if (videoId) {
        videoIds.push(videoId);
      }
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return videoIds;
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
    scope: SCOPES,
  });

  console.log(`Autorizando cuenta ${accountLabel}...`);
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

async function migrate(config) {
  if (!config.sourcePlaylistId) {
    throw new Error("Falta SOURCE_PLAYLIST_ID");
  }

  const tokenStore = await loadTokenStore();
  const sourceRefreshToken = await resolveRefreshToken(
    config,
    "source",
    config.sourceRefreshToken,
    tokenStore
  );
  const destRefreshToken = await resolveRefreshToken(
    config,
    "dest",
    config.destRefreshToken,
    tokenStore
  );

  const { youtube: sourceYoutube } = createYoutubeClient(
    config,
    sourceRefreshToken
  );
  const { youtube: destYoutube } = createYoutubeClient(
    config,
    destRefreshToken
  );

  console.log("Leyendo playlist origen...");
  const videoIds = await getPlaylistItems(sourceYoutube, config.sourcePlaylistId);
  console.log(`Videos encontrados: ${videoIds.length}`);

  console.log("Creando playlist destino...");
  const destinationPlaylistId = await createPlaylist(
    destYoutube,
    config.destPlaylistTitle,
    config.destPrivacyStatus
  );
  console.log(`Playlist creada: ${destinationPlaylistId}`);

  for (let index = 0; index < videoIds.length; index += 1) {
    const videoId = videoIds[index];
    await addVideoToPlaylist(destYoutube, destinationPlaylistId, videoId);
    console.log(`Agregado ${index + 1}/${videoIds.length}: ${videoId}`);
  }

  console.log("Migración completada.");
  console.log(`Playlist destino: ${destinationPlaylistId}`);
}

async function main() {
  const config = getConfig();
  const [command, account, value] = process.argv.slice(2);

  if (!command || command === "migrate") {
    await migrate(config);
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