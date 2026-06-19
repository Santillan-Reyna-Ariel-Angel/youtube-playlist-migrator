# youtube-playlist-migrator

Herramienta de línea de comandos para **migrar playlists entre dos cuentas de YouTube** utilizando la API oficial (YouTube Data API v3) con autenticación OAuth 2.0.

## Qué hace

Copia los videos de una playlist de una cuenta **origen** hacia una playlist en una cuenta **destino**:

- Autentica ambas cuentas mediante OAuth 2.0 y guarda los tokens para reutilizarlos en futuras ejecuciones.
- Lee la playlist origen y genera un respaldo local (`playlist-<id>.json`).
- Crea la playlist en la cuenta destino y agrega los videos.
- Es **idempotente**: si la migración se interrumpe (por ejemplo, al agotarse la cuota diaria), puede reanudarse con el mismo ID sin duplicar los videos ya cargados.
- Acepta tanto la **URL completa** de la playlist como su **ID**.

## Requisitos

- **Node.js** (se recomienda una versión LTS vigente, 18 o superior).
- **pnpm** o **npm** como gestor de paquetes.
- Un proyecto en **Google Cloud Console** con:
  - La **YouTube Data API v3** habilitada.
  - La **pantalla de consentimiento de OAuth** configurada.
  - Credenciales **OAuth 2.0** de tipo *App de escritorio* (Client ID y Client Secret).

> El detalle paso a paso para configurar Google Cloud se encuentra en [guide-migrate-playlists-youtube.md](guide-migrate-playlists-youtube.md).

## Instalación

Clonar el repositorio e instalar las dependencias declaradas en `package.json` (`googleapis` y `dotenv`):

```bash
pnpm install
```

O, alternativamente, con npm:

```bash
npm install
```

## Configuración

Las credenciales se leen desde variables de entorno. Se debe crear un archivo `.env` en la raíz del proyecto (puede partirse de `.env.example`) con, como mínimo, el `GOOGLE_CLIENT_ID` y el `GOOGLE_CLIENT_SECRET`.

El detalle de cada variable y el procedimiento completo para obtener las credenciales en Google Cloud están documentados en [guide-migrate-playlists-youtube.md](guide-migrate-playlists-youtube.md).

> **Seguridad:** los archivos `.env`, `client_secret.json` y `.youtube-refresh-tokens.json` contienen credenciales sensibles y están excluidos del repositorio mediante `.gitignore`. No deben subirse a GitHub.

## Uso

Ejecutar el flujo completo con un solo comando:

```bash
pnpm run start
```

En la **primera ejecución**, el script abre el navegador para autorizar la cuenta origen y luego la cuenta destino; al finalizar, guarda los refresh tokens en `.youtube-refresh-tokens.json` y por ultimo realiza la migracion. En las **ejecuciones siguientes**, reutiliza esas credenciales y procede directamente a migrar.

Cuando se solicita la playlist origen, se acepta tanto la URL completa como el ID:

```
https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```
PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> **Cuota diaria:** la YouTube Data API limita a 10.000 unidades por día y agregar cada video cuesta 50 unidades (~200 videos diarios). Para playlists grandes, la migración puede requerir varios días; el script se reanuda automáticamente sin duplicar. Más detalles en la [guía](guide-migrate-playlists-youtube.md).
