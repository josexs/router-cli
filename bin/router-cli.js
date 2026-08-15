#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { TplinkRouterClient, TplinkRouterError } from '../src/tplink.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
}
const c = (color, text) => (text ? `${COLORS[color]}${text}${COLORS.reset}` : '')

function banner(title) {
  console.log()
  console.log(c('cyan', c('bold', '┌────────────────────────────────────┐')))
  console.log(c('cyan', c('bold', `│          ROUTER CLI ${PKG.version.padEnd(10)}│`)))
  console.log(c('cyan', c('bold', '└────────────────────────────────────┘')))
  console.log()
  console.log(`  ${c('dim', '·')} ${c('bold', 'TP-Link AX3000')} — ${c('dim', title)}`)
  console.log()
}

function errorAndExit(msg) {
  console.error(`\n  ${c('red', '❌')} ${c('red', msg)}`)
  process.exit(1)
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return null
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatUptime(seconds) {
  if (seconds == null) return '-'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`
}

function onOff(value) {
  return value === 'on' ? c('green', 'ON ') : c('red', 'OFF')
}

function loadEnv() {
  // Prioridad: env del proyecto (junto al CLI) > ~/.router-cli/.env > process.env
  const projectEnv = join(__dirname, '..', '.env')
  const homeEnv = join(homedir(), '.router-cli', '.env')
  for (const path of [projectEnv, homeEnv]) {
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2]
      }
    }
  }
}

function loadConfig(opts) {
  loadEnv()
  const host = opts.host || process.env.ROUTER_HOST || '192.168.0.1'
  const password = opts.password || process.env.ROUTER_PASSWORD
  const username = opts.username ?? process.env.ROUTER_USERNAME ?? ''
  if (!password) {
    errorAndExit('Falta la contraseña. Usa --password, ROUTER_PASSWORD o ~/.router-cli/.env')
  }
  return {
    host: host.includes('://') ? host : `http://${host}`,
    password,
    username,
  }
}

async function withRouter(opts, fn) {
  const config = loadConfig(opts)
  const client = new TplinkRouterClient(config)
  try {
    await client.authorize()
    await fn(client)
  } catch (err) {
    if (err instanceof TplinkRouterError) errorAndExit(err.message)
    else errorAndExit(err?.message || String(err))
  } finally {
    await client.logout().catch(() => {})
  }
}

function statusCommand(opts) {
  withRouter(opts, async (client) => {
    console.log(`  ${c('dim', '→')} consultando estado...`)

    const [firmware, status] = await Promise.all([client.getFirmware(), client.getStatus()])

    if (firmware.model) {
      console.log()
      console.log(`  ${c('dim', 'Modelo')}     ${c('bold', firmware.model)} ${c('dim', `(HW ${firmware.hardwareVersion})`)}`)
      console.log(`  ${c('dim', 'Firmware')}   ${c('white', firmware.firmwareVersion)}`)
    }
    console.log()
    console.log(`  ${c('dim', 'WAN IP')}     ${c('white', status.wan_ipv4_ipaddr || '-')}`)
    console.log(`  ${c('dim', 'Gateway')}    ${c('white', status.wan_ipv4_gateway || '-')}`)
    console.log(`  ${c('dim', 'LAN IP')}     ${c('white', status.lan_ipv4_ipaddr || '-')}`)
    console.log(`  ${c('dim', 'Uptime')}     ${c('white', formatUptime(status.wan_ipv4_uptime))}`)
    if (status.conn_type) console.log(`  ${c('dim', 'Conexión')}   ${c('white', status.conn_type)}`)
    if (status.mem_usage != null) console.log(`  ${c('dim', 'Memoria')}    ${c('white', `${(Number(status.mem_usage) * 100).toFixed(1)}%`)}`)
    if (status.cpu_usage != null) console.log(`  ${c('dim', 'CPU')}        ${c('white', `${(Number(status.cpu_usage) * 100).toFixed(1)}%`)}`)
    console.log()
    console.log(`  ${c('dim', 'WiFi 2.4G')}   ${onOff(status.wireless_2g_enable)}   ${c('dim', 'Invitados 2.4G')} ${onOff(status.guest_2g_enable)}`)
    console.log(`  ${c('dim', 'WiFi 5G')}     ${onOff(status.wireless_5g_enable)}   ${c('dim', 'Invitados 5G')}   ${onOff(status.guest_5g_enable)}`)
    console.log()
    console.log(`  ${c('dim', 'Clientes')}    ${c('white', String(status.devices.length))} ${c('dim', 'conectados')}`)
    console.log()
  })
}

function clientsCommand(opts) {
  withRouter(opts, async (client) => {
    console.log(`  ${c('dim', '→')} consultando clientes...`)

    const status = await client.getStatus()
    const devices = status.devices

    if (devices.length === 0) {
      console.log(`\n  ${c('yellow', 'No hay clientes conectados')}`)
      return
    }

    const sorted = [...devices].sort((a, b) => {
      const ta = a.type === 'wired' ? 0 : 1
      const tb = b.type === 'wired' ? 0 : 1
      return ta - tb || (a.hostname || '').localeCompare(b.hostname || '')
    })

    console.log(`\n  ${c('dim', `${sorted.length} dispositivos conectados`)}\n`)
    for (const d of sorted) {
      const tag = d.type === 'wired' ? c('cyan', 'cable') : d.type === 'guest' ? c('yellow', 'guest') : c('magenta', 'wifi ')
      let name = d.hostname || d.macaddr
      if (name.length > 26) name = `${name.slice(0, 24)}…`

      const parts = []
      if (d.downSpeed) parts.push(c('dim', `↓${formatBytes(d.downSpeed)}/s`))
      if (d.upSpeed) parts.push(c('dim', `↑${formatBytes(d.upSpeed)}/s`))
      if (d.signal) parts.push(c('dim', `${d.signal}%`))
      const extra = parts.length ? ` ${parts.join(' ')}` : ''

      console.log(
        `  [${tag}] ${c('white', name.padEnd(26))} ${c('dim', (d.ipaddr || '').padEnd(16))} ${c('dim', d.macaddr)}${extra}`,
      )
    }
    console.log()
  })
}

function wifiCommand(opts) {
  const action = opts.action || 'status'
  withRouter(opts, async (client) => {
    const status = await client.getStatus()

    const bands = [
      { key: 'wireless_2g', label: 'WiFi 2.4G', state: status.wireless_2g_enable },
      { key: 'wireless_5g', label: 'WiFi 5G', state: status.wireless_5g_enable },
      { key: 'guest_2g', label: 'Invitados 2.4G', state: status.guest_2g_enable },
      { key: 'guest_5g', label: 'Invitados 5G', state: status.guest_5g_enable },
    ]

    if (action === 'status') {
      console.log()
      for (const band of bands) {
        console.log(`  ${c('dim', band.label.padEnd(14))} ${onOff(band.state)}`)
      }
      console.log()
      return
    }

    if (action !== 'on' && action !== 'off') {
      errorAndExit(`Acción inválida: ${action} (usa on|off|status)`)
    }

    const enable = action === 'on'
    let target = opts.band
    if (!target) {
      console.log()
      console.log(`  ${c('dim', 'Estado actual:')}`)
      bands.forEach((b, i) => console.log(`    ${c('dim', `${i + 1}.`)} ${b.label.padEnd(14)} ${onOff(b.state)}`))
      console.log()
      const input = await prompt(`  ¿Qué banda (${bands.map((b, i) => `${i + 1}=${b.label}`).join(', ')})? `)
      const idx = parseInt(input, 10) - 1
      const band = bands[idx]
      if (!band) errorAndExit('Banda inválida')
      target = band.key
    }

    const band = bands.find((b) => b.key === target || b.label.toLowerCase().includes(target.toLowerCase()))
    if (!band) errorAndExit(`Banda desconocida: ${target} (usa: 2g, 5g, guest2g, guest5g)`)
    if ((band.state === 'on') === enable) {
      console.log(`\n  ${c('dim', `${band.label} ya está ${action}`)}`)
      return
    }

    console.log(`  ${c('dim', '→')} ${action === 'on' ? 'encendiendo' : 'apagando'} ${band.label}...`)
    await client.setWifi(band.key, enable)
    console.log(`\n  ${c('green', '✅')} ${band.label} ${action === 'on' ? c('green', 'encendido') : c('red', 'apagado')}`)
    console.log()
  })
}

function rebootCommand(opts) {
  withRouter(opts, async (client) => {
    if (!opts.yes) {
      const ans = await prompt(`  ¿Reiniciar el router? ${c('dim', '(y/N)')} `)
      if (!ans || !['y', 'Y', 'yes'].includes(ans.trim())) {
        console.log(`\n  ${c('yellow', 'Cancelado')}`)
        return
      }
    }
    console.log(`  ${c('dim', '→')} enviando reboot...`)
    await client.reboot()
    console.log(`\n  ${c('green', '✅')} Router reiniciando. Espera ~2 minutos.\n`)
  })
}

function renameCommand(args, opts) {
  const mac = (args[0] || '').toUpperCase()
  const alias = args[1]

  if (!mac || !alias) {
    errorAndExit('Uso: router rename <MAC> <nombre>')
  }
  if (!/^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/.test(mac)) {
    errorAndExit(`MAC inválida: ${mac} (usa formato XX-XX-XX-XX-XX-XX)`)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(alias)) {
    errorAndExit(`Nombre inválido: "${alias}". Solo se permiten letras, números, guiones y guiones bajos (sin espacios)`)
  }

  withRouter(opts, async (client) => {
    const status = await client.getStatus()
    const devices = status.devices || []
    const dev = devices.find((d) => d.macaddr === mac)
    if (!dev) {
      console.log(`\n  ${c('yellow', `Dispositivo ${mac} no encontrado entre los conectados`)}`)
      console.log(`  ${c('dim', 'Prueba con router clients para ver las MAC disponibles')}`)
      return
    }

    const ans = await prompt(`  ¿Renombrar "${c('bold', dev.hostname || mac)}" → "${c('bold', alias)}"? ${c('dim', '(y/N)')} `)
    if (!ans || !['y', 'Y', 'yes'].includes(ans.trim())) {
      console.log(`\n  ${c('yellow', 'Cancelado')}`)
      return
    }

    await client.renameDevice(mac, alias)
    console.log(`\n  ${c('green', '✅')} Dispositivo renombrado a "${c('bold', alias)}"`)
    console.log()
  })
}

function prompt(text) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(text, (ans) => {
      rl.close()
      resolve(ans)
    })
  })
}

const USAGE = `Router CLI — controla tu TP-Link AX3000 desde la terminal

USO:
  router <comando> [opciones]

COMANDOS:
  status                Estado general del router
  clients               Lista de dispositivos conectados
  wifi [status]         Estado de las bandas WiFi
  wifi on|off           Encender/apagar una banda (pide banda o usa --band)
  rename <MAC> <nombre> Renombrar un dispositivo (ej: router rename E4-AE-E4-5A-E2-4B EnchufeCocina)
  reboot                Reiniciar el router

OPCIONES:
  --host <host>         IP o hostname del router (default: ROUTER_HOST o 192.168.0.1)
  --password <pass>     Contraseña de admin (o ROUTER_PASSWORD)
  --username <user>     Usuario (default: vacío — el AX3000 suele no tener)
  --band <band>         Banda para wifi on/off: 2g, 5g, guest2g, guest5g
  -y, --yes             Confirmar reboot sin preguntar
  -h, --help            Muestra esta ayuda
  -v, --version         Versión

CONFIGURACIÓN:
  mkdir -p ~/.router-cli && cp .env.example ~/.router-cli/.env
  # edita ~/.router-cli/.env con tu contraseña
  export ROUTER_HOST=192.168.0.1
  export ROUTER_PASSWORD=tu-password
`

const args = process.argv.slice(2)

function parseArgs(args) {
  const opts = { _: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg === '-v' || arg === '--version') opts.version = true
    else if (arg === '-y' || arg === '--yes') opts.yes = true
    else if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=')
      if (value !== undefined) {
        opts[key] = value
      } else {
        opts[key] = args[++i]
      }
    } else {
      opts._.push(arg)
    }
  }
  return opts
}

const opts = parseArgs(args)

if (opts.help) {
  console.log(USAGE)
  process.exit(0)
}
if (opts.version) {
  console.log(PKG.version)
  process.exit(0)
}

const [command, sub] = opts._
async function main() {
  switch (command) {
    case 'status':
      banner('Estado del router')
      statusCommand(opts)
      break
    case 'clients':
      banner('Dispositivos conectados')
      clientsCommand(opts)
      break
    case 'wifi':
      banner('WiFi')
      await wifiCommand({ ...opts, action: sub })
      break
    case 'rename':
      banner('Renombrar dispositivo')
      renameCommand([sub, ...opts._.slice(2)], opts)
      break
    case 'reboot':
      banner('Reinicio')
      await rebootCommand(opts)
      break
    case undefined:
      console.log(USAGE)
      break
    default:
      errorAndExit(`Comando desconocido: ${command}`)
  }
}

main()
