import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  publicEncrypt,
  constants,
} from 'node:crypto'

const CHUNK_SIZE = 53

function randomDigits(len) {
  let s = ''
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10)
  return s
}

export class TplinkRouterError extends Error {}

export class TplinkRouterClient {
  constructor({ host, password, username = '', timeoutMs = 15000 }) {
    this.host = host.replace(/\/+$/, '')
    this.password = password
    this.username = username
    this.timeoutMs = timeoutMs

    this.stok = ''
    this.sysauth = ''
    this.logged = false

    this.pwdNN = ''
    this.pwdEE = ''
    this.nn = ''
    this.ee = ''
    this.seq = 0

    this.aesKey = ''
    this.aesIv = ''
    this.md5Hash = ''
  }

  get connected() {
    return this.logged && !!this.stok
  }

  async authorize() {
    if (this.logged && this.stok) return
    await this.requestPwd()
    await this.requestAuth()
    await this.login()
  }

  async logout() {
    if (!this.logged) return
    try {
      await this.request('admin/system?form=logout', { operation: 'write' }, true)
    } finally {
      this.stok = ''
      this.sysauth = ''
      this.logged = false
    }
  }

  async getFirmware() {
    const data = await this.request('admin/firmware?form=upgrade', { operation: 'read' })
    return {
      model: data.model || '',
      hardwareVersion: data.hardware_version || '',
      firmwareVersion: data.firmware_version || '',
    }
  }

  async getStatus() {
    const data = await this.request('admin/status?form=all', { operation: 'read' })

    const devices = new Map()

    const add = (list, type) => {
      for (const item of list || []) {
        devices.set(item.macaddr, { ...item, type })
      }
    }

    add(data.access_devices_wired, 'wired')
    add(data.access_devices_wireless_host, 'wifi')
    add(data.access_devices_wireless_guest, 'guest')

    try {
      const smart = await this.request('admin/smart_network?form=game_accelerator', {
        operation: 'loadDevice',
      })
      for (const item of smart || []) {
        if (!item.mac) continue
        const device = devices.get(item.mac) || {
          macaddr: item.mac,
          ipaddr: item.ip || '0.0.0.0',
          hostname: item.deviceName || '',
          type: item.isGuest ? 'guest' : 'wifi',
        }
        device.downSpeed = item.downloadSpeed ?? item.downSpeed
        device.upSpeed = item.uploadSpeed ?? item.upSpeed
        device.txRate = item.txrate ?? item.txRate
        device.rxRate = item.rxrate ?? item.rxRate
        device.onlineTime = item.onlineTime ?? item.online_time
        device.trafficUsed = item.trafficUsage ?? item.trafficUsed
        device.signal = item.signal ? parseInt(item.signal, 10) : device.signal
        devices.set(item.mac, device)
      }
    } catch {
      // smart_network no disponible en este firmware
    }

    return {
      ...data,
      devices: [...devices.values()],
    }
  }

  async getWifi(band) {
    return this.request(`admin/wireless?form=${band}`, { operation: 'read' })
  }

  async setWifi(band, enable) {
    await this.request(`admin/wireless?form=${band}`, {
      operation: 'write',
      [`${band}_enable`]: enable ? 'on' : 'off',
    })
  }

  async renameDevice(mac, alias) {
    await this.request('admin/traffic?form=dev_name', {
      operation: 'write',
      mac,
      alias,
    })
  }

  async reboot() {
    await this.request('admin/system?form=reboot', { operation: 'write' }, true)
  }

  async requestPwd() {
    const data = await this.postPlain('/cgi-bin/luci/;stok=/login?form=keys')
    if (!data?.data?.password) throw new TplinkRouterError('No se pudo obtener la clave pública')
    ;[this.pwdNN, this.pwdEE] = data.data.password
  }

  async requestAuth() {
    const data = await this.postPlain('/cgi-bin/luci/;stok=/login?form=auth')
    if (!data?.data?.key) throw new TplinkRouterError('No se pudo obtener la clave de firma')
    ;[this.nn, this.ee] = data.data.key
    this.seq = parseInt(data.data.seq, 10) || 0
  }

  async login() {
    this.aesKey = randomDigits(16)
    this.aesIv = randomDigits(16)
    this.md5Hash = this.buildHash(this.username, this.password)

    const pwdKey = this.buildRsaKey(this.pwdNN, this.pwdEE)
    const cryptedPwd = publicEncrypt(
      { key: pwdKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(this.password, 'utf8'),
    ).toString('hex')

    const body = `operation=login&password=${cryptedPwd}&confirm=true`
    const [sign, data] = this.buildBody(body, true)

    const response = await this.post('/cgi-bin/luci/;stok=/login?form=login', { sign, data }, true)
    const json = await response.json()
    const decrypted = await this.decryptResponse(json)

    if (!decrypted || !decrypted.data?.stok) {
      throw new TplinkRouterError('Login fallido. Revisa ROUTER_PASSWORD')
    }

    this.stok = decrypted.data.stok
    const cookies = response.headers.getSetCookie?.() || []
    const sysauthCookie = cookies.find((c) => c.startsWith('sysauth='))
    if (sysauthCookie) {
      this.sysauth = sysauthCookie.split('=')[1].split(';')[0]
    }
    this.logged = true
  }

  async request(path, body, ignoreResponse = false) {
    if (!this.logged || !this.stok) await this.authorize()

    const formBody = Object.entries(body)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => `${key}=${value}`)
      .join('&')

    const [sign, data] = this.buildBody(formBody, false)

    const response = await this.post(
      `/cgi-bin/luci/;stok=${this.stok}/${path}`,
      { sign, data },
      true,
    )

    if (ignoreResponse) return undefined
    const json = await response.json()
    const decrypted = await this.decryptResponse(json)

    if (!decrypted || decrypted.success !== true) {
      throw new TplinkRouterError(`El router respondió con error: ${JSON.stringify(decrypted).slice(0, 300)}`)
    }
    return decrypted.data
  }

  buildHash(username, password) {
    const raw = `admin${password}`
    return createHash('sha256').update(raw).digest('hex')
  }

  buildBody(raw, isLogin) {
    const encryptedData = this.aesEncrypt(raw)
    const dataLen = encryptedData.length
    if (!isLogin) {
      this.md5Hash = createHash('sha256').update(encryptedData).digest('hex')
    }
    const s = isLogin
      ? `k=${this.aesKey}&i=${this.aesIv}&h=${this.md5Hash}&s=${this.seq + dataLen}`
      : `h=${this.md5Hash}&s=${this.seq + dataLen}`

    const authKey = this.buildRsaKey(this.nn, this.ee)
    let sign = ''
    for (let pos = 0; pos < s.length; pos += CHUNK_SIZE) {
      const chunk = Buffer.from(s.slice(pos, pos + CHUNK_SIZE), 'utf8')
      sign += isLogin
        ? publicEncrypt({ key: authKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, chunk).toString('hex')
        : createHmac('sha256', `k=${this.aesKey}&i=${this.aesIv}`).update(chunk).digest('hex')
    }
    return [sign, encryptedData]
  }

  aesEncrypt(raw) {
    const cipher = createCipheriv(
      'aes-128-cbc',
      Buffer.from(this.aesKey, 'utf8'),
      Buffer.from(this.aesIv, 'utf8'),
    )
    let encrypted = cipher.update(raw, 'utf8', 'base64')
    encrypted += cipher.final('base64')
    return encrypted
  }

  aesDecrypt(data) {
    const decipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from(this.aesKey, 'utf8'),
      Buffer.from(this.aesIv, 'utf8'),
    )
    let decrypted = decipher.update(data, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  async decryptResponse(json) {
    if (!json || typeof json.data !== 'string') {
      if (json?.data && typeof json.data === 'object') return json
      throw new TplinkRouterError(`Respuesta inesperada del router: ${JSON.stringify(json).slice(0, 300)}`)
    }
    try {
      return JSON.parse(this.aesDecrypt(json.data))
    } catch {
      throw new TplinkRouterError('No se pudo descifrar la respuesta del router')
    }
  }

  buildRsaKey(nHex, eHex) {
    return createPublicKey({
      key: {
        kty: 'RSA',
        n: Buffer.from(nHex, 'hex').toString('base64url'),
        e: Buffer.from(eHex, 'hex').toString('base64url'),
      },
      format: 'jwk',
    })
  }

  async postPlain(urlPath) {
    const response = await this.post(`${urlPath}&operation=read`, undefined, true)
    return response.json()
  }

  async post(urlPath, body, authenticated) {
    const headers = {
      Referer: `${this.host}/webpages/index.html`,
      Origin: this.host,
    }
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    if (authenticated && this.sysauth) headers.Cookie = `sysauth=${this.sysauth}`

    const init = {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    }
    if (body) init.body = new URLSearchParams(body).toString()

    const response = await fetch(`${this.host}${urlPath}`, init)
    if (!response.ok) {
      throw new TplinkRouterError(`HTTP ${response.status} del router en ${urlPath.split('?')[0]}`)
    }
    return response
  }
}
