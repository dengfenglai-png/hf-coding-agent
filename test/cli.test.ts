// test/cli.test.ts
// 测试 session 持久化的核心 round-trip。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadSession, persistSession, loadConfig, parseApiKeyArg, saveApiKey, friendlyKeyError, projectSessionDir, latestSessionFile, parseContinueFlag } from '../src/cli.js'
import type { Message } from '../src/llm.js'

let tmpFile: string

beforeEach(() => { tmpFile = path.join(os.tmpdir(), `nanopi-session-${Date.now()}.jsonl`) })
afterEach(async () => { await fs.rm(tmpFile, { force: true }) })

describe('session persistence', () => {
  it('persist → load round-trip', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]
    await persistSession(messages, tmpFile)
    expect(await loadSession(tmpFile)).toEqual(messages)
  })
})

describe('loadConfig', () => {
  it('环境变量 + 默认值', async () => {
    const config = await loadConfig('/nonexistent/config.json', { NANOPI_API_KEY: 'test-key' })
    expect(config.apiKey).toBe('test-key')
    expect(config.provider).toBe('openai')
    expect(config.model).toBe('glm-5.3-flash')
    expect(config.maxTokens).toBe(4096)
  })

  it('配置文件加载 + 环境变量覆盖', async () => {
    const tmpConfig = path.join(os.tmpdir(), `nanopi-config-${Date.now()}.json`)
    await fs.writeFile(tmpConfig, JSON.stringify({
      model: 'claude',
      provider: 'anthropic',
      maxTokens: 8192,
    }))
    const config = await loadConfig(tmpConfig, {
      NANOPI_API_KEY: 'test-key',
      NANOPI_MODEL: 'glm-5.2', // 环境变量覆盖配置文件的 model
    })
    expect(config.model).toBe('glm-5.2')      // 环境变量优先
    expect(config.provider).toBe('anthropic')  // 配置文件兜底
    expect(config.maxTokens).toBe(8192)
    await fs.rm(tmpConfig, { force: true })
  })

  it('apiKey 缺失 → throw', async () => {
    await expect(loadConfig('/nonexistent/config.json', {})).rejects.toThrow('NANOPI_API_KEY')
  })

  it('provider 预设：选中后 model/baseUrl 落到预设值', async () => {
    const config = await loadConfig('/nonexistent/config.json', {
      NANOPI_API_KEY: 'test-key',
      NANOPI_PROVIDER: 'deepseek',
    })
    expect(config.provider).toBe('openai')                          // deepseek 走 openai 协议
    expect(config.model).toBe('deepseek-chat')                      // 预设默认 model
    expect(config.baseUrl).toBe('https://api.deepseek.com/v1')      // 预设默认 baseUrl
  })

  it('provider 预设：anthropic 协议 + 显式 env 覆盖预设值', async () => {
    const config = await loadConfig('/nonexistent/config.json', {
      NANOPI_API_KEY: 'test-key',
      NANOPI_PROVIDER: 'anthropic',
      NANOPI_BASE_URL: 'https://my-relay.example.com/v1',  // 中转站覆盖预设 baseUrl
      NANOPI_MODEL: 'claude-sonnet-5',
    })
    expect(config.provider).toBe('anthropic')
    expect(config.baseUrl).toBe('https://my-relay.example.com/v1')
    expect(config.model).toBe('claude-sonnet-5')
  })

  it('未知 provider → throw 并列出可选', async () => {
    await expect(loadConfig('/nonexistent/config.json', {
      NANOPI_API_KEY: 'test-key',
      NANOPI_PROVIDER: 'nope',
    })).rejects.toThrow(/未知的 provider/)
  })

  it('key 三级来源：flag > env > config 文件', async () => {
    const tmpConfig = path.join(os.tmpdir(), `nanopi-config-${Date.now()}.json`)
    await fs.writeFile(tmpConfig, JSON.stringify({ apiKey: 'file-key' }))
    const env = { NANOPI_API_KEY: 'env-key' }

    // env 覆盖文件
    expect((await loadConfig(tmpConfig, env)).apiKey).toBe('env-key')
    // flag 覆盖 env
    expect((await loadConfig(tmpConfig, env, 'flag-key')).apiKey).toBe('flag-key')
    // 无 flag 无 env → 落到文件
    expect((await loadConfig(tmpConfig, {})).apiKey).toBe('file-key')

    await fs.rm(tmpConfig, { force: true })
  })

  it('parseApiKeyArg：空格与等号两种写法', () => {
    expect(parseApiKeyArg(['--api-key', 'abc'])).toBe('abc')
    expect(parseApiKeyArg(['--api-key=abc'])).toBe('abc')
    expect(parseApiKeyArg(['--model', 'glm-5.2'])).toBeUndefined()
    expect(parseApiKeyArg([])).toBeUndefined()
  })

  it('saveApiKey 写入并保留其他字段，权限 600', async () => {
    const tmpConfig = path.join(os.tmpdir(), `nanopi-config-${Date.now()}.json`)
    await saveApiKey('new-key', tmpConfig)
    const stat = await fs.stat(tmpConfig)
    expect(stat.mode & 0o777).toBe(0o600)
    const config = await loadConfig(tmpConfig, {})
    expect(config.apiKey).toBe('new-key')

    // 已有其他字段时，保存只更新 apiKey、保留其余
    await fs.writeFile(tmpConfig, JSON.stringify({ model: 'glm-5.2' }))
    await saveApiKey('second-key', tmpConfig)
    expect(JSON.parse(await fs.readFile(tmpConfig, 'utf-8'))).toMatchObject({ apiKey: 'second-key', model: 'glm-5.2' })
    await fs.rm(tmpConfig, { force: true })
  })

  it('friendlyKeyError：401/403 追加指引，其余原样', () => {
    expect(friendlyKeyError('API 401: bad key')).toContain('API key 无效')
    expect(friendlyKeyError('API 403: forbidden')).toContain('API key 无效')
    expect(friendlyKeyError('API 500: oops')).toBe('API 500: oops')
  })
})

describe('按项目目录隔离 session', () => {
  it('projectSessionDir：slug 规则与 Claude Code projects 命名一致', () => {
    expect(projectSessionDir('/Users/hefeng/Desktop/vibe code/pi-agent'))
      .toBe(path.join(os.homedir(), '.nanopi', 'projects', '-Users-hefeng-Desktop-vibe-code-pi-agent'))
  })

  it('latestSessionFile：按修改时间取最新，目录不存在 → undefined', async () => {
    expect(await latestSessionFile(path.join(os.tmpdir(), `no-such-dir-${Date.now()}`))).toBeUndefined()

    const dir = path.join(os.tmpdir(), `nanopi-proj-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const older = path.join(dir, 'session-111.jsonl')
    const newer = path.join(dir, 'session-222.jsonl')
    await fs.writeFile(older, '')
    await new Promise(r => setTimeout(r, 20))  // 保证 mtime 有差
    await fs.writeFile(newer, '')
    expect(await latestSessionFile(dir)).toBe(newer)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('parseContinueFlag：-c / --continue', () => {
    expect(parseContinueFlag(['-c'])).toBe(true)
    expect(parseContinueFlag(['--continue'])).toBe(true)
    expect(parseContinueFlag(['--api-key', 'x'])).toBe(false)
    expect(parseContinueFlag([])).toBe(false)
  })
})
