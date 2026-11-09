/**
 * Cortex Agent SDK client for the chat popup (server-only).
 *
 * Credentials, in order:
 *   1. Snowflake App Runtime service token (/snowflake/session/token) — the agent
 *      runs as the app's owner role. Sent as Bearer + token type OAUTH, the same
 *      form the template uses for other Cortex REST APIs.
 *   2. SNOWFLAKE_PAT (local dev).
 *   3. Key-pair JWT minted from the active snow CLI connection's private_key_file
 *      (local dev with SNOWFLAKE_CONNECTION_NAME=<key-pair connection>).
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import { CortexAgentClient, type Authenticator } from "@snowflake/cortex-agent-sdk"
import { getServiceToken, getSnowflakeBaseUrl, readTomlDefaultConnection } from "@/lib/snowflake"

export const AGENT = {
  type: "data" as const,
  spec: { database: "SNOWFLAKE_DEMO", schema: "CORTEX_SENSE", name: "SUMMIT_RETAIL_AGENT" },
}

const JWT_LIFETIME_S = 55 * 60
let cachedJwt: { token: string; expiresAt: number } | null = null

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, os.homedir()) : p
}

function mintKeyPairJwt(account: string, user: string, keyFile: string, passphrase?: string): string {
  const now = Math.floor(Date.now() / 1000)
  if (cachedJwt && cachedJwt.expiresAt - 60 > now) return cachedJwt.token

  const privateKey = createPrivateKey({ key: fs.readFileSync(expandHome(keyFile), "utf8"), passphrase })
  const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" })
  const fingerprint = `SHA256:${createHash("sha256").update(publicDer).digest("base64")}`
  // Account identifier without region/cloud suffixes, upper-cased (Snowflake JWT rules).
  const qualifiedUser = `${account.split(".")[0].toUpperCase()}.${user.toUpperCase()}`

  const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url")
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = b64(JSON.stringify({ iss: `${qualifiedUser}.${fingerprint}`, sub: qualifiedUser, iat: now, exp: now + JWT_LIFETIME_S }))
  const unsigned = `${header}.${payload}`
  const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`
  cachedJwt = { token, expiresAt: now + JWT_LIFETIME_S }
  return token
}

class AppAuthenticator implements Authenticator {
  async getAuthHeaders(): Promise<Record<string, string>> {
    const serviceToken = getServiceToken()
    if (serviceToken) {
      return { Authorization: `Bearer ${serviceToken}`, "X-Snowflake-Authorization-Token-Type": "OAUTH" }
    }
    if (process.env.SNOWFLAKE_PAT) {
      return { Authorization: `Bearer ${process.env.SNOWFLAKE_PAT}`, "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN" }
    }
    const conn = readTomlDefaultConnection()
    const keyFile = (conn?.private_key_file ?? conn?.private_key_path) as string | undefined
    if (conn?.account && conn.user && keyFile) {
      const passphrase = (conn.private_key_file_pwd ?? conn.private_key_passphrase) as string | undefined
      return {
        Authorization: `Bearer ${mintKeyPairJwt(String(conn.account), String(conn.user), keyFile, passphrase)}`,
        "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
      }
    }
    throw new Error(
      "No credentials for the Cortex Agent API. Locally, set SNOWFLAKE_PAT or SNOWFLAKE_CONNECTION_NAME to a key-pair snow connection.",
    )
  }
}

let client: CortexAgentClient | null = null

export function getAgentClient(): CortexAgentClient {
  if (!client) {
    const baseUrl = getSnowflakeBaseUrl()
    if (!baseUrl) throw new Error("Cannot determine the Snowflake account URL for the Cortex Agent API")
    client = new CortexAgentClient({
      baseUrl,
      auth: new AppAuthenticator(),
      partnerApplication: "invoice_recon",
      // Tokens are re-read on every request; a 401 just retries with fresh headers.
      refreshAuth: async () => {
        cachedJwt = null
      },
    })
  }
  return client
}
