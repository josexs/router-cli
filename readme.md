# Router CLI — TP-Link AX3000 / Archer AX55

CLI para controlar tu router TP-Link (AX3000, Archer AX55 y similares) desde la terminal, sin pasar por la interfaz web.

Funciona contra el protocolo HTTP local del router (login RSA + AES-128-CBC + firma HmacSHA256), replicado del firmware 1.5.x. Probado con **Archer AX55 v1.0** (firmware 1.5.12).

## Instalación

Requiere Node.js ≥ 20.

```bash
cd ~/apps/router-cli
npm install        # sin dependencias, solo para enlazar el binario
npm run link       # disponible como `router`
```

## Configuración

Crea `~/.router-cli/.env` (o usa el `.env` del propio proyecto):

```bash
mkdir -p ~/.router-cli && cp .env.example ~/.router-cli/.env
nano ~/.router-cli/.env
```

```env
ROUTER_HOST=192.168.1.254
ROUTER_PASSWORD=tu-contraseña-de-admin
ROUTER_USERNAME=            # vacío si tu router no usa usuario
```

> El `.env` está en `.gitignore` y **nunca** debe subirse a git. Contiene tu contraseña del router en texto plano.

### Home Assistant (opcional, para `identify`)

`router identify` cruza las MAC de tus clientes con el registro de dispositivos de Home Assistant. Necesitas un token de HA (Perfil → Tokens de acceso de larga duración):

```env
HA_URL=https://tu-hass.ejemplo.com
HA_TOKEN=eyJhbGciOiJIUzI1NiIs...
```

## Comandos

| Comando | Descripción | Seguridad |
|---|---|---|
| `router status` | Estado general: IPs, uptime, CPU/mem, WiFi, nº clientes | lectura |
| `router clients` | Lista de dispositivos conectados con velocidad y señal | lectura |
| `router identify` | Cruza MAC con Home Assistant (marca los sin nombre y sugiere) | lectura |
| `router export [--output f]` | Vuelca clientes + info del router a JSON | lectura |
| `router wifi status` | Estado de las 4 bandas | lectura |
| `router wifi on\|off --band <b>` | Encender/apagar banda | confirmación |
| `router rename <MAC> <nombre>` | Renombrar un dispositivo | confirmación |
| `router block <MAC>` | Añadir a la lista de denegados (pierde Internet) | confirmación |
| `router unblock <MAC>` | Quitar de la lista de denegados | confirmación |
| `router reboot` | Reiniciar el router | confirmación |

Todos los comandos que **modifican** el router piden confirmación `(y/N)` antes de ejecutar. Usa `-y/--yes` solo en `wifi` y `reboot` para automatización.

### Ejemplos

```bash
# Estado general
router status

# Listar clientes
router clients

# Identificar con Home Assistant
router identify

# Exportar a JSON (stdout o archivo)
router export --output clientes.json

# Renombrar un dispositivo (nombres sin espacios: usa _ o -)
router rename E4-AE-E4-5A-E2-4B Camara_Salon_1

# Bloquear / desbloquear
router block E4-AE-E4-5A-E2-4B
router unblock E4-AE-E4-5A-E2-4B

# WiFi
router wifi status
router wifi off --band 2g
router wifi on --band guest5g

# Reiniciar
router reboot
```

### Bandas WiFi (`--band`)

| Alias | Banda |
|---|---|
| `2g` | WiFi 2.4G |
| `5g` | WiFi 5G |
| `guest2g` | Invitados 2.4G |
| `guest5g` | Invitados 5G |

### Reglas de nombres (`rename`)

El router solo acepta **letras, números, guiones (`-`) y guiones bajos (`_`)**. Nada de espacios ni acentos:

```bash
router rename E4-AE-E4-5A-E2-4B Camara_Salon_1   # ✅
router rename E4-AE-E4-5A-E2-4B "Camara Salon 1" # ❌ (espacios)
```

## Seguridad y precauciones

- **Bloqueo de intentos**: el router bloquea el login 2 horas tras 10 intentos fallidos. Revisa bien `ROUTER_PASSWORD` antes de probar.
- **Bloquear un dispositivo**: lo desconecta de la red y puede tardar en volver. Desbloquéalo con `router unblock <MAC>`.
- **El `.env` es tu responsabilidad**: no lo subas a git, no lo compartas.

## Estructura

```
bin/router-cli.js   # CLI (comandos, confirmaciones, formato)
src/tplink.js       # Cliente del protocolo TP-Link (login RSA+AES+HmacSHA256)
src/ha.js           # Cliente Home Assistant (registro de dispositivos vía websocket)
.env.example        # Plantilla de configuración
```

## Protocolo (para curiosos)

El router expone una API en `/cgi-bin/luci/;stok=<token>/...` con cifrado:

1. `login?form=keys` y `login?form=auth` → claves RSA públicas (en claro)
2. `login?form=login` → password cifrado con RSA-PKCS1 y firmado con **RSA-PKCS1-OAEP** + AES-128-CBC + hash SHA256 → devuelve `stok`
3. Peticiones posteriores: body cifrado con AES-128-CBC, firma **HmacSHA256**, cookie `sysauth`, y `REPLACE_HASH` (el hash se renueva con cada request)
4. `rename`: `admin/traffic?form=dev_name` con `operation=write&mac=<mac>&alias=<nombre>`
5. `block`/`unblock`: `admin/access_control?form=black_devices` (`operation=block`) y `form=black_list` (`operation=remove`)

Los formatos exactos se capturaron interceptando el JS de la propia web del router.
