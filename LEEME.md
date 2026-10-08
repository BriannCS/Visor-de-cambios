# Visor de Cambios: PWA (iPhone y Android) + APK

Hay un solo código web en `www/`, y de ahí salen dos formas de instalar la app:

| Destino | Cómo se instala | Se actualiza |
|---|---|---|
| **iPhone / iPad** | PWA: abrir el enlace en Safari → Compartir → *Agregar a pantalla de inicio* | Sola, cada vez que se publica |
| **Android (navegador)** | PWA: abrir el enlace en Chrome → *Instalar app* | Sola |
| **Android (APK)** | Descargar `VisorDeCambios.apk` desde *Releases* e instalar | Se descarga la APK nueva |

Los datos siguen saliendo de tu Google Sheet a través de Apps Script (`Código.gs`, que ahora también responde JSON).

```
Código.gs                 → pegar en Apps Script (sirve la web Y la API JSON)
www/index.html            → tu Index.html + 9 líneas en el <head> (paso 2)
www/config.js             → URL /exec de tu Apps Script
www/puente.js             → emula google.script.run, compartir y copiar en la APK
www/sw.js, manifest       → hacen la PWA instalable y que abra sin conexión
assets/logo.png           → ícono base de la APK
capacitor.config.json     → configuración de la APK
.github/workflows/        → GitHub compila la APK y publica la PWA (gratis)
```

---

## Paso 1: Apps Script

1. Reemplaza tu `Código.gs` por el de esta carpeta. Solo cambió `doGet`.
2. **Implementar → Gestionar implementaciones → ✏️ → Versión: Nueva versión → Implementar.**
   *Ejecutar como:* Yo · *Acceso:* Cualquier usuario. La URL `/exec` sigue siendo la misma.
3. Prueba en el navegador: `TU_URL/exec?api=obtenerPaquete`. Tiene que responder un JSON con `"ok":true`.
4. Pega esa URL en `www/config.js` → `API_URL`.

## Paso 2: `www/index.html` ✅ (ya hecho)

`www/index.html` es tu `Index.html` sin cambios, más estas 9 líneas en el `<head>`:

```html
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#0a0a0c">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Visor">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<script src="config.js"></script>
<script src="puente.js"></script>
```

El resto del archivo no se cambia: `puente.js` hace que `google.script.run…obtenerPaquete(fecha)` funcione igual que dentro de Apps Script.

> Cuando cambies el diseño, cámbialo en `www/index.html` y copia ese archivo a Apps Script, sin las 9 líneas (allí no hacen falta).

## Paso 3: subir a GitHub (una sola vez)

1. Crea un repositorio en github.com (por ejemplo `visor-de-cambios`). Para GitHub Pages gratis tiene que ser **público**.
2. Sube esta carpeta (`git init`, `git add .`, `git commit`, `git push` a la rama `main`).
3. En el repositorio: **Settings → Pages → Source: GitHub Actions.**

Con cada `push`:
- **Publicar PWA** deja la app en `https://TU_USUARIO.github.io/visor-de-cambios/`. Ese es el enlace para iPhone.
- **APK Android** compila la APK y la publica en *Releases*. Este enlace siempre da la última versión:
  `https://github.com/TU_USUARIO/visor-de-cambios/releases/latest/download/VisorDeCambios.apk`

## Paso 4 (recomendado antes de repartir la APK): firma fija

Si no configuras una firma, cada compilación sale con una firma distinta y, para actualizar, Android pide desinstalar la versión anterior. Para evitarlo:

```powershell
winget install EclipseAdoptium.Temurin.21.JDK
keytool -genkeypair -v -keystore visor.jks -alias visor -keyalg RSA -keysize 2048 -validity 10000
[Convert]::ToBase64String([IO.File]::ReadAllBytes("visor.jks")) | Set-Clipboard
```

En GitHub, en **Settings → Secrets and variables → Actions**, crea estos secretos:
`ANDROID_KEYSTORE_BASE64` (lo que se copió al portapapeles), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (= `visor`) y `ANDROID_KEY_PASSWORD`.
**Guarda `visor.jks` y sus claves en un lugar seguro.** Si los pierdes, no podrás publicar actualizaciones de la misma app.

## iPhone: app nativa (opcional, más adelante)

En iOS no se puede instalar un archivo como se hace con la APK. Para iPhone, la PWA es la vía práctica y se ve igual. Para una app nativa en la App Store o TestFlight necesitas:
- una Mac con Xcode (o un servicio de compilación en la nube como Codemagic o Ionic Appflow),
- una cuenta de Apple Developer (USD 99 al año).

El proyecto ya trae `@capacitor/ios`: en una Mac basta con `npx cap add ios && npx cap open ios`.
