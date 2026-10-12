// DocuSign setup check (demo account): JWT grant → access token → eSignature account info.
// Local only. Never prints the token, the private key or the IDs.
//
// Run with the env file that holds the DOCUSIGN_* values:
//   node --env-file=.env.local scripts/docusign-check.mjs
//   node --env-file=supabase/functions/.env scripts/docusign-check.mjs
//
// Needs: DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID (GUIDs),
//        DOCUSIGN_BASE_URI (e.g. https://demo.docusign.net),
//        DOCUSIGN_AUTH_SERVER (e.g. account-d.docusign.com),
//        DOCUSIGN_PRIVATE_KEY_PATH (RSA private key, PEM). Key files are git-ignored (*.key, *.pem).
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const env = (name) => (process.env[name] ?? '').trim().replace(/^["']|["']$/g, '')

function fail(message) {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

// ---- 1. Configuration ----
const integrationKey = env('DOCUSIGN_INTEGRATION_KEY')
const userId = env('DOCUSIGN_USER_ID')
const accountId = env('DOCUSIGN_ACCOUNT_ID')
// Accept "https://account-d.docusign.com/" as well as "account-d.docusign.com".
const authServer = env('DOCUSIGN_AUTH_SERVER').replace(/^https?:\/\//, '').replace(/\/+$/, '')
// Accept "https://demo.docusign.net/restapi" as well as "https://demo.docusign.net".
const baseUri = env('DOCUSIGN_BASE_URI').replace(/\/+$/, '').replace(/\/restapi$/, '')
const keyPath = env('DOCUSIGN_PRIVATE_KEY_PATH')

for (const [name, value] of [['DOCUSIGN_INTEGRATION_KEY', integrationKey], ['DOCUSIGN_USER_ID', userId], ['DOCUSIGN_ACCOUNT_ID', accountId]]) {
  if (!GUID.test(value)) fail(`${name} is missing or not a GUID (got ${value.length} characters, expected 36)`)
}
if (!authServer) fail('DOCUSIGN_AUTH_SERVER is missing (demo: account-d.docusign.com)')
if (!/^https:\/\/\S+$/.test(baseUri)) fail('DOCUSIGN_BASE_URI is missing or not an https URL (demo: https://demo.docusign.net)')
if (authServer !== 'account-d.docusign.com') console.warn(`WARN  auth server is "${authServer}"; demo accounts use account-d.docusign.com`)

let privateKey
try {
  privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'))
} catch (err) {
  fail(`could not read an RSA private key from DOCUSIGN_PRIVATE_KEY_PATH (${keyPath || 'empty'}): ${err.code ?? err.message}`)
}
if (privateKey.asymmetricKeyType !== 'rsa') fail(`private key is ${privateKey.asymmetricKeyType}, DocuSign needs RSA`)
console.log('PASS  configuration looks complete')

// ---- 2. JWT grant: signed assertion → access token ----
const b64url = (data) => Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
  iss: integrationKey,           // the app (integration key)
  sub: userId,                   // the user the app acts as
  aud: authServer,               // host name only, no https://
  iat: now,
  exp: now + 3600,               // DocuSign allows at most 1 hour
  scope: 'signature impersonation',
})}`
const assertion = `${unsigned}.${sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url')}`

const tokenRes = await fetch(`https://${authServer}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
}).catch((err) => fail(`could not reach https://${authServer}: ${err.cause?.code ?? err.message}`))
const token = await tokenRes.json().catch(() => ({}))

if (!tokenRes.ok) {
  if (token.error === 'consent_required') {
    console.error('FAIL  consent_required: the user has not yet allowed this app to act on their behalf.')
    console.error('      Open this URL once in a browser while logged in to the DocuSign demo account,')
    console.error('      replacing <REDIRECT_URI> with a Redirect URI registered on the integration key:')
    console.error(`      https://${authServer}/oauth/auth?response_type=code&scope=${encodeURIComponent('signature impersonation')}&client_id=${integrationKey}&redirect_uri=<REDIRECT_URI>`)
    process.exit(1)
  }
  // Typical: invalid_grant + no_valid_keys_or_signatures (wrong key for this integration key),
  // invalid_grant + user_not_found (wrong user ID or auth server), invalid_client (wrong integration key).
  fail(`token request returned HTTP ${tokenRes.status}: ${token.error ?? ''} ${token.error_description ?? ''}`.trim())
}
console.log(`PASS  access token received (type ${token.token_type}, expires in ${token.expires_in} s)`)
const auth = { Authorization: `Bearer ${token.access_token}` }

// ---- 3. Which accounts can this user use, and where do they live? ----
const userInfoRes = await fetch(`https://${authServer}/oauth/userinfo`, { headers: auth })
const userInfo = await userInfoRes.json().catch(() => ({}))
if (!userInfoRes.ok) fail(`userinfo returned HTTP ${userInfoRes.status}`)
const account = (userInfo.accounts ?? []).find((a) => a.account_id.toLowerCase() === accountId.toLowerCase())
if (!account) fail(`DOCUSIGN_ACCOUNT_ID is not one of this user's ${userInfo.accounts?.length ?? 0} account(s)`)
if (account.base_uri.replace(/\/+$/, '') !== baseUri) {
  console.warn(`WARN  DOCUSIGN_BASE_URI is ${baseUri}, but this account lives at ${account.base_uri}; using the latter`)
}
console.log('PASS  account ID belongs to this user')

// ---- 4. eSignature API: account information ----
const apiBase = `${account.base_uri.replace(/\/+$/, '')}/restapi/v2.1`
const accountRes = await fetch(`${apiBase}/accounts/${accountId}`, { headers: auth })
const info = await accountRes.json().catch(() => ({}))
if (!accountRes.ok) fail(`GET /accounts/{accountId} returned HTTP ${accountRes.status}: ${info.errorCode ?? ''} ${info.message ?? ''}`.trim())

console.log('PASS  eSignature API call succeeded\n')
console.log(`  Account name:  ${info.accountName}`)
console.log(`  Plan:          ${info.planName ?? '-'}`)
console.log(`  Environment:   ${account.base_uri}`)
console.log(`  Created:       ${info.createdDate ?? '-'}`)
console.log('\nDocuSign JWT grant setup works.')
