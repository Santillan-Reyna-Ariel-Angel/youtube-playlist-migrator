# Guía paso a paso: migrar playlists de YouTube con la API oficial

Esta guía resume el flujo que funcionó para habilitar YouTube Data API v3, configurar la pantalla de consentimiento de OAuth y crear las credenciales para migrar playlists desde una cuenta origen a una cuenta destino.

## Paso 1: Activar la YouTube Data API v3

1. Entrá a la [Google Cloud Console](https://console.cloud.google.com/?chat=true).
2. En el menú lateral, andá a **APIs y servicios** > **Biblioteca**.
3. Buscá **YouTube Data API v3**.
4. Hacé clic en el resultado y presioná **Habilitar**.

## Paso 2: Configurar la pantalla de consentimiento de OAuth

1. Andá a **APIs y servicios** > **Pantalla de consentimiento de OAuth**.

Al abrir la pantalla verás primero una pantalla de configuración inicial; seguí estos pasos en ese primer formulario:

- En **User Type (Tipo de usuario)**, elegí **Externo**.
- Hacé clic en **Crear**.
- En **Información de la aplicación**, escribí un nombre para la app, por ejemplo: `Mi App de YouTube`.
- En **Correo electrónico de asistencia al usuario**, elegí tu correo desde la lista desplegable.
- En **Información de contacto del desarrollador**, escribí tu correo electrónico.
- Hacé clic en **Guardar y continuar**.

Luego, dentro de la misma pantalla(consentimiento de OAuth), selecciona la opcion "Publico" del menu y completá la configuración restante:

- Usuarios de prueba: si dejás la app en modo **Prueba**, hacé clic en **+ ADD USERS**, agregá tus direcciónes de Gmail(u de otros) y hacé clic en **Add/Añadir**. Mientras la app esté en prueba, solo los correos agregados podrán usar la API.
- Guardá y continuá hasta finalizar la configuración.

## Paso 3: Crear las credenciales OAuth 2.0

1. En el menú lateral, andá a **APIs y servicios** > **Credenciales**.
2. Hacé clic en **+ CREAR CREDENCIALES** > **ID de cliente de OAuth**.
3. En **Tipo de aplicación**, seleccioná **App de escritorio**.
4. En **Nombre**, poné un nombre descriptivo, por ejemplo: `Credenciales Node App`.
5. Hacé clic en **Crear**.
6. En la ventana emergente, hacé clic en **Descargar JSON**.
7. Guardá el archivo en la carpeta del proyecto. Si querés, podés renombrarlo a `credentials.json` para usarlo más fácil.

## Paso 4: Instalación de herramientas (JavaScript/Node.js)

Para usar estas credenciales en un proyecto de JavaScript con Node.js, abrí la terminal en la carpeta del proyecto e instalá la librería oficial de Google.

Con `npm`:

```bash
npm install googleapis
```

Con `pnpm`:

```bash
pnpm add googleapis
```

## Paso 5: Ejecutar el flujo con un solo comando

La primera vez que corras el script, va a abrir el navegador para autorizar la cuenta origen y después la cuenta destino. Cuando termina de guardar los refresh tokens en `.youtube-refresh-tokens.json`, arranca la migración.

Después, en las siguientes ejecuciones, reutiliza automáticamente esas credenciales y va directo a migrar.

```bash
pnpm run start
```

Si preferís cargar los tokens manualmente en `.env`, también podés hacerlo. En ese caso el script usa primero lo que encuentre en variables de entorno y, si no hay nada, usa el archivo local cacheado.

## 6. Configurar el proyecto para JavaScript moderno

Usá un archivo `.js` normal con sintaxis ESM. No necesitás `.mjs`.

Si tu proyecto no tiene `package.json`, crealo. Si ya existe, agregá:

```json
{
  "type": "module"
}
```

Con eso podés usar `import` y `export` directamente en `.js`.

## 7. Configurar OAuth

La migración se hace en dos autenticaciones separadas:

- Cuenta origen: para leer la playlist.
- Cuenta destino: para crear la nueva playlist y agregar los videos.

Ejemplo de configuración:

```js
import { google } from "googleapis";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback"
);

const youtube = google.youtube({ version: "v3", auth: oauth2Client });
```

Si necesitás repasar el flujo completo de OAuth 2.0 de Google, revisá la [documentación oficial](https://developers.google.com/identity/protocols/oauth2?hl=es-419).

## 8. Generar la URL de autorización

Antes de ejecutar el script, tenés que autorizar tu cuenta de YouTube:

```js
const scopes = ["https://www.googleapis.com/auth/youtube"];
const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: scopes,
});

console.log("Visita esta URL para autenticar:", authUrl);
```

Pasos:

1. Abrí la URL en el navegador.
2. Iniciá sesión en la cuenta que quieras usar.
3. Copiá el código de autorización que te devuelve Google.

## 9. Intercambiar el código por tokens

```js
const { tokens } = await oauth2Client.getToken("CODIGO_DE_AUTORIZACION");
oauth2Client.setCredentials(tokens);
console.log("Autenticación completada.");
```

Importante: primero hacé este proceso con la cuenta origen y después repetilo con la cuenta destino.

## 10. Leer los videos de la playlist origen

Con la cuenta origen autenticada, podés obtener los IDs de los videos de la playlist:

```js
async function getPlaylistItems(playlistId) {
  const res = await youtube.playlistItems.list({
    part: "snippet",
    playlistId,
    maxResults: 50,
  });

  return res.data.items.map((item) => item.snippet.resourceId.videoId);
}
```

## 11. Crear la playlist destino

Con la cuenta destino autenticada, creás una nueva playlist:

```js
async function createPlaylist(title) {
  const res = await youtube.playlists.insert({
    part: "snippet,status",
    requestBody: {
      snippet: { title },
      status: { privacyStatus: "private" },
    },
  });

  return res.data.id;
}
```

## 12. Agregar videos a la playlist destino

Una vez creada la playlist, agregás cada video uno por uno:

```js
async function addVideoToPlaylist(playlistId, videoId) {
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
```

## 13. Ejecutar el flujo completo

```js
async function migratePlaylist() {
  const origen = "ID_DE_TU_PLAYLIST_ORIGEN";
  const videos = await getPlaylistItems(origen);

  const destino = await createPlaylist("Mi Playlist Migrada");

  for (const videoId of videos) {
    await addVideoToPlaylist(destino, videoId);
    console.log(`Agregado: ${videoId}`);
  }
}

await migratePlaylist();
```

## 14. Notas importantes

- La primera vez podés dejar que el script haga toda la autorización y guarde los tokens por vos.
- Si preferís, también podés seguir usando los comandos separados para generar la URL e intercambiar el código.
- El Client Secret se obtiene en la misma sección donde creaste el Client ID.
- Si la playlist es privada, OAuth es obligatorio.
- Una API key sola no sirve para escribir en la cuenta.
- Este método sirve también para playlists grandes, como migraciones de cientos de videos.

## 15. Resumen rápido

1. Creás credenciales OAuth en Google Cloud.
2. Instalás `googleapis`.
3. Autorizás la cuenta origen y leés los videos.
4. Autorizás la cuenta destino.
5. Creás una playlist nueva.
6. Copiás los videos a la playlist destino.

## 16. Conclusión

Este enfoque es:

- Fiable, porque usa la API oficial.
- Escalable, porque funciona con muchas playlists y muchos videos.
- Seguro, porque el acceso queda controlado por OAuth y tus credenciales.