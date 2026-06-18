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
7. Guardá el archivo. De ahí vas a copiar el **Client ID** y el **Client Secret** al archivo `.env` en el próximo paso. El script **no lee este JSON directamente**: solo te sirve como fuente de esos dos valores.

## Paso 4: Configurar las variables de entorno

El script lee las credenciales desde variables de entorno, **no** desde el JSON descargado. Creá un archivo `.env` en la raíz del proyecto. Lo mínimo son el **Client ID** y el **Client Secret** (los sacás del JSON del Paso 3 o de la pantalla de credenciales de Google Cloud):

```bash
# --- Obligatorias ---
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-client-secret

# --- Opcionales (podés dejarlas vacías o borrarlas) ---
GOOGLE_REDIRECT_URI=http://localhost:3000
SOURCE_REFRESH_TOKEN=
DEST_REFRESH_TOKEN=
DEST_PRIVACY_STATUS=private
```

Sin las dos obligatorias, el script corta con un error como `Falta la variable de entorno GOOGLE_CLIENT_ID`.

### Detalle de cada variable

| Variable | ¿Obligatoria? | Valor por defecto | Cuándo / para qué se usa |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Sí | — | Identifica tu app ante Google. Se usa al crear el cliente OAuth. |
| `GOOGLE_CLIENT_SECRET` | Sí | — | Secreto de tu app. Va junto al Client ID en el OAuth. |
| `GOOGLE_REDIRECT_URI` | No | `http://localhost:3000` | A dónde vuelve Google tras el login. Cambiala solo si usás otro puerto. |
| `SOURCE_REFRESH_TOKEN` | No | (vacío) | Token de la cuenta origen. Si lo cargás, se saltea el login por navegador de origen. |
| `DEST_REFRESH_TOKEN` | No | (vacío) | Token de la cuenta destino. Si lo cargás, se saltea el login por navegador de destino. |
| `DEST_PRIVACY_STATUS` | No | `private` | Privacidad de la playlist nueva (`private`, `public` o `unlisted`). Se usa al crearla. |

> **Cuándo entran en juego los refresh tokens:** el script prioriza el `.env`. Si `SOURCE_REFRESH_TOKEN` / `DEST_REFRESH_TOKEN` están cargados, los usa directo y se saltea el navegador. Si están vacíos, hace el login por navegador y guarda el resultado en `.youtube-refresh-tokens.json` para reutilizarlo en las próximas corridas.

## Paso 5: Instalar las dependencias del proyecto

El proyecto ya trae su `package.json` con todo lo necesario (`googleapis` y `dotenv`). No hace falta agregar paquetes a mano: abrí la terminal en la carpeta del proyecto e instalá lo que ya está declarado. Eso descarga las librerías en la carpeta `node_modules`.

Con `pnpm`:

```bash
pnpm install
```

Con `npm`:

```bash
npm install
```

## Paso 6: Ejecutar el flujo con un solo comando

```bash
pnpm run start
```

La primera vez que corras el script, va a abrir el navegador para autorizar la cuenta origen y después la cuenta destino. Cuando termina de guardar los refresh tokens en `.youtube-refresh-tokens.json`, arranca la migración.

Después, en las siguientes ejecuciones, reutiliza automáticamente esas credenciales y va directo a migrar.


El flujo paso a paso queda así:

1. Aviso **CUENTA ORIGEN** → (pausa 2.5s) → se abre el navegador → login origen.
2. Aviso **CUENTA DESTINO** → (pausa 2.5s) → se abre el navegador → login destino.
3. `Ingresá el ID o la URL de la playlist ORIGEN:`
4. Lee la playlist origen → guarda `playlist-<id>.json`.
5. Migra → guarda el `destPlaylistId` dentro del JSON.
6. Próxima corrida con el **mismo ID** → reanuda sola, sin duplicar.

Primero se autentican las dos cuentas (el login no consume cuota de la API) y recién después se pide el ID, así la migración corre de corrido sin frenarse a mitad de camino para pedir un segundo login.

Si preferís cargar los tokens manualmente en `.env`, también podés hacerlo. En ese caso el script usa primero lo que encuentre en variables de entorno y, si no hay nada, usa el archivo local cacheado.


## Paso 7: Cuotas de la API y reanudación

Antes de migrar playlists grandes, tenés que entender el límite más importante de la YouTube Data API: la **cuota diaria**.

### Cuánto cuesta cada operación

La API no limita por cantidad de llamadas, sino por **unidades**. Tenés **10.000 unidades por día** (cuota gratuita por defecto) y cada operación gasta distinto:

| Operación | Método | Costo |
| --- | --- | --- |
| Leer una página (hasta 50 videos) | `playlistItems.list` | 1 unidad |
| Crear una playlist | `playlists.insert` | 50 unidades |
| Agregar un video | `playlistItems.insert` | 50 unidades |

### El techo práctico

Como agregar cada video cuesta 50 unidades:

```
10.000 unidades ÷ 50 por video ≈ 200 videos por día
```

Si tu playlist tiene más de ~200 videos, **necesitás varios días** para migrarla completa. No es un bug: es el límite de Google. Cuando lo superás, la API devuelve el error `quotaExceeded`.

La cuota se **reinicia a medianoche hora del Pacífico (PT)**. Si necesitás más, podés solicitar un aumento desde Google Cloud Console (es un trámite que Google revisa manualmente).

### Reanudar sin duplicar (idempotencia)

Si la migración se corta a la mitad (por cuota o cualquier otro error), no querés empezar de cero ni duplicar los videos ya cargados. La solución es **comparar contra el estado real del destino** antes de agregar:

1. Leés los videos que la playlist destino **ya tiene** (`playlistItems.list`).
2. Recorrés la lista origen y, por cada video, preguntás si **ya está** en el destino.
3. Si está, lo saltás; si no, lo agregás.

Así podés correr la importación las veces que necesites: siempre completa lo que falta y nada más.

Y lo mejor es el costo: **leer es 50 veces más barato que escribir**. Por ejemplo, para saltar 181 videos ya cargados:

| Acción | Cálculo | Costo |
| --- | --- | --- |
| Leer el destino para saber qué saltar | 181 ÷ 50 ≈ 4 páginas | 4 unidades |
| Re-agregarlos a ciegas (sin reanudar) | 181 × 50 | 9.050 unidades |

Pagás **4 unidades** de lectura para ahorrarte **9.050** de escritura inútil (y, de paso, evitás los duplicados). Esa es la diferencia entre un proceso fiable y uno frágil.


## Paso 8: Notas importantes

- La primera vez podés dejar que el script haga toda la autorización y guarde los tokens por vos.
- Si preferís, también podés seguir usando los comandos separados para generar la URL e intercambiar el código.
- El Client Secret se obtiene en la misma sección donde creaste el Client ID.
- Si la playlist es privada, OAuth es obligatorio.
- Una API key sola no sirve para escribir en la cuenta.
- Este método sirve también para playlists grandes, como migraciones de cientos de videos.


## Paso 9: Conclusión

Este enfoque es:

- Fiable, porque usa la API oficial.
- Escalable, porque funciona con muchas playlists y muchos videos.
- Seguro, porque el acceso queda controlado por OAuth y tus credenciales.