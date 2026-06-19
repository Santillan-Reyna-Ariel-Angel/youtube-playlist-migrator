# Guía paso a paso: migrar playlists de YouTube con la API oficial

Esta guía resume el flujo que permite habilitar YouTube Data API v3, configurar la pantalla de consentimiento de OAuth y crear las credenciales necesarias para migrar playlists desde una cuenta origen hacia una cuenta destino.

## Paso 1: Activar la YouTube Data API v3

1. Ingresar a la [Google Cloud Console](https://console.cloud.google.com/?chat=true).
2. En el menú lateral, dirigirse a **APIs y servicios** > **Biblioteca**.
3. Buscar **YouTube Data API v3**.
4. Hacer clic en el resultado y presionar **Habilitar**.

## Paso 2: Configurar la pantalla de consentimiento de OAuth

1. Dirigirse a **APIs y servicios** > **Pantalla de consentimiento de OAuth**.

Al abrir la pantalla se muestra primero un formulario de configuración inicial. En ese primer formulario se deben seguir estos pasos:

- En **User Type (Tipo de usuario)**, seleccionar **Externo**.
- Hacer clic en **Crear**.
- En **Información de la aplicación**, indicar un nombre para la app, por ejemplo: `Mi App de YouTube`.
- En **Correo electrónico de asistencia al usuario**, seleccionar el correo desde la lista desplegable.
- En **Información de contacto del desarrollador**, indicar el correo electrónico correspondiente.
- Hacer clic en **Guardar y continuar**.

A continuación, dentro de la misma pantalla (consentimiento de OAuth), se selecciona la opción "Público" del menú y se completa la configuración restante:

- Usuarios de prueba: si la app permanece en modo **Prueba**, se debe hacer clic en **+ ADD USERS**, agregar las direcciones de Gmail (origen y destino) correspondientes y hacer clic en **Add/Añadir**. Mientras la app esté en prueba, solo los correos agregados podrán utilizar la API.
- Guardar y continuar hasta finalizar la configuración.

## Paso 3: Crear las credenciales OAuth 2.0

1. En el menú lateral, dirigirse a **APIs y servicios** > **Credenciales**.
2. Hacer clic en **+ CREAR CREDENCIALES** > **ID de cliente de OAuth**.
3. En **Tipo de aplicación**, seleccionar **App de escritorio**.
4. En **Nombre**, indicar un nombre descriptivo, por ejemplo: `Credenciales Node App`.
5. Hacer clic en **Crear**.
6. En la ventana emergente, hacer clic en **Descargar JSON**.
7. Guardar el archivo. De ese archivo se copiarán el **Client ID** y el **Client Secret** al archivo `.env` en el próximo paso. El script **no lee este JSON directamente**: solo sirve como fuente de esos dos valores.

## Paso 4: Configurar las variables de entorno

Se debe crear un archivo `.env` en la raíz del proyecto. Lo mínimo necesario es el **Client ID** y el **Client Secret** (que se obtienen del JSON del Paso 3 o de la pantalla de credenciales de Google Cloud):

```bash
# --- Obligatorias ---
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-client-secret

# --- Opcionales (pueden quedar vacías o eliminarse) ---
GOOGLE_REDIRECT_URI=http://localhost:3000
SOURCE_REFRESH_TOKEN=
DEST_REFRESH_TOKEN=
DEST_PRIVACY_STATUS=private
```


### Detalle de cada variable

| Variable | ¿Obligatoria? | Valor por defecto | Cuándo / para qué se usa |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Sí | — | Identifica la app ante Google. Se usa al crear el cliente OAuth. |
| `GOOGLE_CLIENT_SECRET` | Sí | — | Secreto de la app. Acompaña al Client ID en el OAuth. |
| `GOOGLE_REDIRECT_URI` | No | `http://localhost:3000` | Dirección a la que retorna Google tras el login. Solo se modifica si se usa otro puerto. |
| `SOURCE_REFRESH_TOKEN` | No | (vacío) | Token de la cuenta origen. Si se carga, se omite el login por navegador de origen. |
| `DEST_REFRESH_TOKEN` | No | (vacío) | Token de la cuenta destino. Si se carga, se omite el login por navegador de destino. |
| `DEST_PRIVACY_STATUS` | No | `private` | Privacidad de la playlist nueva (`private`, `public` o `unlisted`). Se usa al crearla. |

> **Cuándo entran en juego los refresh tokens:** el script prioriza el `.env`. Si `SOURCE_REFRESH_TOKEN` / `DEST_REFRESH_TOKEN` están cargados, los utiliza directamente y omite el navegador. Si están vacíos, realiza el login por navegador y guarda el resultado en `.youtube-refresh-tokens.json` para reutilizarlo en las próximas ejecuciones.

## Paso 5: Instalar las dependencias del proyecto

El proyecto ya incluye su `package.json` con todo lo necesario (`googleapis` y `dotenv`). Solo se debe instalar las dependencias.

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

La primera vez que se ejecuta el script, este abre el navegador para autorizar la cuenta origen y luego la cuenta destino. Una vez que termina de guardar los refresh tokens en `.youtube-refresh-tokens.json`, comienza la migración.

En las ejecuciones siguientes, el script reutiliza automáticamente esas credenciales y procede directamente a migrar.


El flujo paso a paso es el siguiente:

1. Aviso **CUENTA ORIGEN** → (pausa 2.5s) → se abre el navegador → login origen.
2. Aviso **CUENTA DESTINO** → (pausa 2.5s) → se abre el navegador → login destino.
3. `Ingresá el ID o la URL de la playlist ORIGEN:`
4. Lectura de la playlist origen → se guarda `playlist-<id>.json`.
5. Migración → se guarda el `destPlaylistId` dentro del JSON.
6. Próxima ejecución con el **mismo ID** → se reanuda automáticamente, sin duplicar.

Primero se autentican las dos cuentas (el login no consume cuota de la API) y recién después se solicita el ID, de modo que la migración se ejecute de corrido sin detenerse.

Si se prefiere cargar los tokens manualmente en `.env`, también es posible. En ese caso el script utiliza primero lo que encuentre en las variables de entorno y, si no hay nada, recurre al archivo local cacheado.


## Paso 7: Cuotas de la API y reanudación

Antes de migrar playlists grandes, es necesario comprender el límite más importante de la YouTube Data API: la **cuota diaria**.

### Cuánto cuesta cada operación

La API no limita por cantidad de llamadas, sino por **unidades**. Se dispone de **10.000 unidades por día** (cuota gratuita por defecto) y cada operación tiene un costo distinto:

| Operación | Método | Costo |
| --- | --- | --- |
| Leer una página (hasta 50 videos) | `playlistItems.list` | 1 unidad |
| Crear una playlist | `playlists.insert` | 50 unidades |
| Agregar un video | `playlistItems.insert` | 50 unidades |

### El techo práctico

Dado que agregar cada video cuesta 50 unidades:

```
10.000 unidades ÷ 50 por video ≈ 200 videos por día
```

Si una playlist tiene más de ~200 videos, **se necesitan varios días** para migrarla completa. No se trata de un error: es el límite impuesto por Google. Al superarlo, la API devuelve el error `quotaExceeded`.

La cuota se **reinicia a medianoche hora del Pacífico (PT)**. Si se requiere un límite mayor, es posible solicitar un aumento desde Google Cloud Console (es un trámite que Google revisa manualmente).

### Reanudar sin duplicar (idempotencia)

Si la migración se interrumpe a la mitad (por cuota o por cualquier otro error), no conviene empezar de cero ni duplicar los videos ya cargados. La solución consiste en **comparar contra el estado real del destino** antes de agregar:

1. Se leen los videos que la playlist destino **ya contiene** (`playlistItems.list`).
2. Se recorre la lista origen y, por cada video, se verifica si **ya está** en el destino.
3. Si está presente, se omite; si no, se agrega.

De esta manera, la importación puede ejecutarse tantas veces como sea necesario: siempre completa lo que falta y nada más.

La ventaja principal es el costo: **leer es 50 veces más barato que escribir**. Por ejemplo, para omitir 181 videos ya cargados:

| Acción | Cálculo | Costo |
| --- | --- | --- |
| Leer el destino para saber qué omitir | 181 ÷ 50 ≈ 4 páginas | 4 unidades |
| Re-agregarlos a ciegas (sin reanudar) | 181 × 50 | 9.050 unidades |

Se pagan **4 unidades** de lectura para evitar **9.050** de escritura inútil (y, además, se evitan los duplicados). Esa es la diferencia entre un proceso fiable y uno frágil.


## Paso 8: Notas importantes

- En la primera ejecución, el script puede realizar toda la autorización y guardar los tokens automáticamente.
- De preferirlo, también es posible seguir utilizando los comandos separados para generar la URL e intercambiar el código.
- El Client Secret se obtiene en la misma sección donde se creó el Client ID.
- Si la playlist es privada, OAuth es obligatorio.
- Una API key por sí sola no permite escribir en la cuenta.
- Este método también sirve para playlists grandes, como migraciones de cientos de videos.


## Paso 9: Conclusión

Este enfoque resulta:

- Fiable, porque utiliza la API oficial.
- Escalable, porque funciona con múltiples playlists y gran cantidad de videos.
- Seguro, porque el acceso queda controlado por OAuth y las credenciales del usuario.
