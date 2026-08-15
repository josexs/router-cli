import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function loadHaConfig() {
  const env = {}
  for (const path of [join(here, '..', '.env'), join(homedir(), '.router-cli', '.env')]) {
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !env[m[1]]) env[m[1]] = m[2]
    }
  }
  return { token: env.HA_TOKEN, url: env.HA_URL }
}

export async function fetchHaDevices() {
  const { token, url } = loadHaConfig()
  if (!token) return { ok: false, reason: 'Falta HA_TOKEN en .env', devices: [] }
  if (!url) return { ok: false, reason: 'Falta HA_URL en .env', devices: [] }

  const wsUrl = url.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/api/websocket'
  return new Promise((resolve) => {
    let socket
    try {
      socket = new WebSocket(wsUrl)
    } catch {
      return resolve({ ok: false, reason: 'WebSocket no soportado', devices: [] })
    }

    const timeout = setTimeout(() => { try { socket.close() } catch {} resolve({ ok: false, reason: 'timeout al conectar con HA', devices: [] }) }, 12000)
    let id = 0
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      try { socket.close() } catch {}
      resolve(result)
    }

    socket.addEventListener('open', () => {
      // esperar auth_required antes de enviar el token
    })
    socket.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data)
      if (data.type === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: token }))
      }
      if (data.type === 'auth_ok') {
        socket.send(JSON.stringify({ id: ++id, type: 'config/device_registry/list' }))
      }
      if (data.type === 'result' && data.id === 1) {
        const devices = (data.result || [])
          .filter((d) => d.connections?.some((c) => c[0] === 'mac'))
          .map((d) => ({
            name: d.name_by_user || d.name || d.model || d.manufacturer || '?',
            macs: d.connections.filter((c) => c[0] === 'mac').map((c) => c[1].toUpperCase()),
            manufacturer: d.manufacturer || '',
          }))
        finish({ ok: true, devices })
      }
      if (data.type === 'auth_invalid') {
        finish({ ok: false, reason: data.message || 'auth inválida', devices: [] })
      }
    })
    socket.addEventListener('error', () => finish({ ok: false, reason: 'no se pudo conectar a HA', devices: [] }))
  })
}

export function findHaName(haDevices, mac) {
  const upper = mac.toUpperCase().replace(/:/g, '-')
  return haDevices.find((d) => d.macs.includes(upper)) || null
}
