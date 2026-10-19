# TopReview: instrucciones para subirlo y ponerlo en marcha

**Para:** el agente o la persona que vaya a publicar la app.
**Proyecto:** TopReview, la app de QR por camarero para POLKA San Sebastián.
**Archivo:** `cinestar.zip`, con todo el código. No incluye `node_modules` ni la base de datos.

## Qué es

Es una app web en Node.js (Express + SQLite integrado en Node 22):

- `/` es la web que explica TopReview a los camareros.
- `/admin` es el dashboard del encargado, con usuario y contraseña.
- `/r/<camarero>` es la página que abre el cliente al escanear el QR. El cliente valora con estrellas y después va a Google.
- `/me/<token>` es el panel privado de cada camarero.

Necesita un **servidor con disco persistente**. GitHub Pages no sirve, porque hay backend y base de datos.

---

## Paso 1: Subirlo a GitHub

1. Crea un repositorio **vacío**, sin README, `.gitignore` ni licencia:
   - Organización: `POLKASanSebastian`
   - Nombre: `cinestar`
   - URL para crearlo: https://github.com/organizations/POLKASanSebastian/repositories/new
2. Descomprime `cinestar.zip` y, dentro de la carpeta `cinestar`, ejecuta:

```bash
git init -b main
git add -A
git commit -m "TopReview: QR por camarero, reseñas en Google y dashboard en tiempo real"
git remote add origin https://github.com/POLKASanSebastian/cinestar.git
git push -u origin main
```

Si no se usa la terminal, en la página del repositorio vacío se puede pulsar **«uploading an existing file»** y arrastrar el **contenido** de la carpeta (no la carpeta). El archivo `.gitignore` está oculto: hay que comprobar que también se sube.

---

## Paso 2: Publicarlo en Render

1. Entra en https://dashboard.render.com con la cuenta de GitHub de POLKA.
2. Ve a **New → Blueprint** y elige el repositorio `POLKASanSebastian/cinestar`. Si no aparece, hay que dar acceso a Render a ese repositorio desde el mismo asistente.
3. Render lee el archivo `render.yaml` y crea:
   - El servicio web `cinestar`, con plan Starter, en Frankfurt (unos 7 $/mes).
   - Un disco persistente de 1 GB en `/var/data`, donde vive la base de datos.
   - Estas variables: `BUSINESS_NAME=POLKA San Sebastián`, el enlace de Google de POLKA y `ADMIN_PASSWORD`, que se genera automáticamente.
4. Pulsa **Apply** y espera a que el estado quede en **Live** (2–4 minutos).

**Importante:** el plan gratuito de Render **no** sirve, porque no tiene disco persistente y se borrarían las valoraciones.

---

## Paso 3: Configuración final, antes de imprimir los QR

1. En Render → servicio `cinestar` → **Environment**:
   - Copia el valor de `ADMIN_PASSWORD`. Es la contraseña del dashboard; el usuario es `admin`.
   - Añade `BASE_URL` con la URL pública del servicio, por ejemplo `https://cinestar.onrender.com`. Es la dirección que va dentro de cada QR.
   - Guarda. Render reinicia la app solo.
2. *(Opcional)* Usa un dominio propio, como `opiniones.polkasansebastian.com`, desde **Settings → Custom Domains**. En ese caso, pon ese dominio en `BASE_URL`.
3. Entra en `<URL>/admin` y, en **Ajustes**:
   - Pega el **enlace directo de reseñas** de POLKA. Se obtiene en Google Business Profile → «Pedir reseñas» y tiene la forma `https://g.page/r/XXXX/review`. El enlace que viene puesto por defecto abre la ficha en Google Maps, y desde ahí el cliente tiene que pulsar «Escribir reseña».
   - Revisa los € de bonus por cada estrella y pulsa **Guardar ajustes**.
4. Da de alta a los camareros. Por cada uno se abre su **tarjeta QR** para imprimir. El botón **«Su panel»** copia el enlace privado que hay que enviarle.

---

## Comprobación final

- [ ] `<URL>/` muestra la web de TopReview con «POLKA San Sebastián».
- [ ] `<URL>/admin` pide usuario y contraseña y abre el dashboard.
- [ ] Al escanear con un móvil el QR de un camarero de prueba se abre «¿Qué tal te ha atendido…?».
- [ ] Al votar 5★, el dashboard lo muestra **al momento** y el móvil va a Google.
- [ ] Al votar 1–3★ se pide un comentario, y el comentario aparece en «Actividad en directo».
- [ ] Al desactivar el camarero de prueba, su QR deja de funcionar.

## Para arrancarlo en local (opcional)

```bash
npm install
ADMIN_PASSWORD=una-clave BUSINESS_NAME="POLKA San Sebastián" npm start
# http://localhost:3000  ·  dashboard en /admin (usuario admin)
```

Requiere Node 22.5 o superior. Más detalles en `README.md`.
